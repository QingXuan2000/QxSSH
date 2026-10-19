package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// hostApp 是宿主桌面页面的内置保留身份标识符。
const hostApp = "__host__"

// maxSessions 限制单进程最大活跃会话数量上限。
const maxSessions = 256

type sysAppKey struct{}

// sysEntry 描述路由表中的一个端点配置：包含所需权限、WebSocket 标识、免权标记与实际处理函数。
type sysEntry struct {
	perm string
	ws   bool
	pub  bool

	noBody bool
	h      http.HandlerFunc
}

// sys 向网关注册一个标准 HTTP 端点。
func (a *Gateway) sys(verb, target, perm string, h http.HandlerFunc) {
	a.sysTable[verb+" "+target] = &sysEntry{perm: perm, h: h}
}

// sysPerm 向网关注册一个受细粒度权限控制的 HTTP 端点。
func (a *Gateway) sysPerm(verb, target, perm string, h http.HandlerFunc) {
	a.sysTable[verb+" "+target] = &sysEntry{perm: perm, h: h}
}

// sysSecret 注册一个处理敏感凭据的端点（详细审计时跳过请求体记录）。
func (a *Gateway) sysSecret(verb, target, perm string, h http.HandlerFunc) {
	a.sysTable[verb+" "+target] = &sysEntry{perm: perm, h: h, noBody: true}
}

// sysNoBody 注册一个请求体不落盘审计日志的常规端点。
func (a *Gateway) sysNoBody(verb, target, perm string, h http.HandlerFunc) {
	a.sysTable[verb+" "+target] = &sysEntry{perm: perm, h: h, noBody: true}
}

// sysWS 注册一个受细粒度权限控制的 WebSocket 端点。
func (a *Gateway) sysWS(target, perm string, h http.HandlerFunc) {
	a.sysWSPerm(target, perm, h)
}

// sysWSPerm 注册受权限保护的 WebSocket 端点实现。
func (a *Gateway) sysWSPerm(target, perm string, h http.HandlerFunc) {
	a.sysTable["GET "+target] = &sysEntry{perm: perm, ws: true, h: h}
}

// sysPub 注册一个无需权限校验即可访问的公开端点。
func (a *Gateway) sysPub(verb, target string, h http.HandlerFunc) {
	a.sysTable[verb+" "+target] = &sysEntry{pub: true, h: h}
}

func randTok() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic("qxssh: crypto/rand 不可用，拒绝铸造会话 token: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func (a *Gateway) sysDispatch(w http.ResponseWriter, r *http.Request) {
	ws := strings.HasPrefix(r.URL.Path, "/api/v1/ws/")
	ns, method := r.PathValue("ns"), r.PathValue("method")
	rest := r.PathValue("rest")

	key := r.Method + " " + ns
	if !ws {
		if method != "" {
			key += "/" + method
		}
		if rest != "" {
			key += "/" + rest
		}
	} else {
		key += "/" + method
	}
	e := a.sysTable[key]
	if e == nil || e.ws != ws {
		writeErr(w, http.StatusNotFound, fmt.Errorf("系统 API 不存在：%s", key))
		return
	}

	hostID := peekHostID(r)

	tok := sessionHeaderToken(r)
	var app string
	var claims *idpClaims
	if !e.pub {
		// 应用 JWT 自带 scope，验签即完成「是谁 + 能做什么」两项判定；
		// 宿主不透明口令没有 scope，仍走 permAllowed 的旁路。
		claims = a.sessionClaims(tok)
		if claims == nil {
			writeErr(w, http.StatusUnauthorized, errors.New("缺少有效会话"))
			return
		}
		app = claims.Subject
		if e.perm != "" {
			need := PermNormalize(e.perm)
			allowed := a.tokenAllows(app, need, claims)
			if !allowed && (need == "tunnel:start" || need == "tunnel:stop") && a.tokenAllows(app, "tunnel:local", claims) {
				allowed = true
			}
			if !allowed && (need == "exec:run" || need == "exec:stream" || need == "exec:session") && a.tokenAllows(app, "local:exec", claims) {
				allowed = true
			}
			if !allowed {
				denied := app
				if denied == hostApp {
					denied = ""
				}
				a.audit.record(auditEntry{
					AppID:  denied,
					HostID: hostID,
					Type:   auditPermRequest,
					Target: key,
					Detail: need,
					Result: "denied",
					User:   "admin",
					Scope:  claims.Scope,
					JTI:    claims.ID,
					Deny:   "no_scope",
				})
				writePermErr(w, []string{need})
				return
			}
		}
	} else {
		app = a.sessionApp(tok)
	}
	if app != "" {
		r = r.WithContext(context.WithValue(r.Context(), sysAppKey{}, app))
	}

	start := time.Now()
	var cap *auditCapture

	if a.audit.Verbose() && !ws && !e.noBody {
		cap = newAuditCapture(r)
	}
	rec := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	if cap != nil {
		rec.errCap = auditRespErrMax
	}
	e.h(rec, r)
	if app == hostApp {
		app = ""
	}
	var scopes []string
	var jti string
	if claims != nil {
		scopes = claims.Scope
		jti = claims.ID
	}
	entry := auditEntry{
		AppID:    app,
		HostID:   hostID,
		Type:     auditAPICall,
		Target:   key,
		Result:   strconv.Itoa(rec.status),
		Duration: time.Since(start).Milliseconds(),
		User:     "admin",
		Scope:    scopes,
		JTI:      jti,
	}
	if cap != nil {
		entry.Verbose = cap.finish(r, rec)
	}
	a.audit.record(entry)
}

type auditCapture struct {
	body    []byte
	total   int64
	note    string
	headers map[string]string
}

func newAuditCapture(r *http.Request) *auditCapture {
	c := &auditCapture{headers: make(map[string]string, len(r.Header))}
	for k, v := range r.Header {
		c.headers[k] = truncStr(strings.Join(v, ", "), auditHeaderMax)
	}
	if r.ContentLength > 0 {
		c.total = r.ContentLength
	}
	if r.Body == nil || r.Method == http.MethodGet || r.Method == http.MethodHead {
		return c
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		c.note = fmt.Sprintf("multipart 请求未记录正文（%d 字节），只保留请求头与长度", r.ContentLength)
		return c
	}
	buf := make([]byte, auditBodyMax)
	n := 0
	base := io.Reader(r.Body)
	if p, ok := r.Body.(*peekBody); ok && len(p.head) > 0 {
		n = copy(buf, p.head)
		base = p.rest
	}
	n += readUpTo(base, buf[n:])
	c.body = buf[:n]

	r.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(c.body), base), r.Body}
	if r.ContentLength <= 0 {
		c.total = int64(n)
	}
	if c.total > int64(n) {
		c.note = fmt.Sprintf("请求体共 %d 字节，仅记录前 %d 字节", c.total, n)
	}
	return c
}

func redactSessionInQuery(raw string) string {
	if raw == "" || (!strings.Contains(raw, "session=") && !strings.Contains(raw, "token=")) {
		return raw
	}
	parts := strings.Split(raw, "&")
	for i, p := range parts {
		if k, _, ok := strings.Cut(p, "="); ok && (k == "session" || k == "token") {
			parts[i] = k + "=" + redactedValue
		}
	}
	return strings.Join(parts, "&")
}

func (c *auditCapture) finish(r *http.Request, rec *statusWriter) *auditVerbose {
	v := &auditVerbose{

		Query:   truncStr(redactSessionInQuery(r.URL.RawQuery), auditHeaderMax),
		Headers: c.headers,
		Remote:  r.RemoteAddr,
		Agent:   truncStr(r.Header.Get("User-Agent"), auditHeaderMax),
		Referer: truncStr(r.Header.Get("Referer"), auditHeaderMax),
		Origin:  truncStr(r.Header.Get("Origin"), auditHeaderMax),

		FetchMode: r.Header.Get("Sec-Fetch-Mode"),
		FetchDest: r.Header.Get("Sec-Fetch-Dest"),
		RespType:  truncStr(rec.Header().Get("Content-Type"), 200),
		RespBytes: rec.n,
	}
	if len(c.body) > 0 {
		v.Body = string(c.body)
	}
	if c.total > 0 {
		v.BodyBytes = c.total
	}
	if c.note != "" {
		v.BodyNote = c.note
	}
	if rec.status >= 400 {
		v.RespError = truncStr(rec.errSnippet(), auditRespErrMax)
	}
	if v.Query == "" && v.Body == "" && v.RespBytes == 0 && len(v.Headers) == 0 {
		return nil
	}
	return v
}

func truncStr(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("…（已截断，共 %d 字节）", len(s))
}

func (a *Gateway) permAllowed(appID, perm string) bool {
	if appID == hostApp || systemAppIDs[appID] {
		return true
	}
	if permIsDefault(perm) {
		return true
	}
	return a.store.HasGrant(appID, perm)
}

func execPermNeed(host string) string {
	if host == "" {
		return "local:exec"
	}
	return "exec:run"
}

func (a *Gateway) requireExecPerm(w http.ResponseWriter, r *http.Request, host string) bool {
	need := execPermNeed(host)
	if !a.permAllowed(callerApp(r), need) {
		writePermErr(w, []string{need})
		return false
	}
	return true
}

func (a *Gateway) requireLocalExecPerm(w http.ResponseWriter, r *http.Request) bool {
	return a.requireExecPerm(w, r, "")
}

func callerApp(r *http.Request) string {
	v, _ := r.Context().Value(sysAppKey{}).(string)
	return v
}

func (a *Gateway) appExists(id string) bool {
	if systemAppIDs[id] {
		return true
	}
	if !appIDRe.MatchString(id) {
		return false
	}
	fi, err := os.Stat(filepath.Join(a.appsDir(), id))
	return err == nil && fi.IsDir()
}

type sessionMintReq struct {
	App string `json:"app"`

	Host        string   `json:"host,omitempty"`
	ExtraScopes []string `json:"extraScopes,omitempty"`
}

// handleSessionMint / handleSessionRefresh / handleSessionRevoke / handleJWKS
// 已移到 idp.go：它们属于 IdP 的签发与校验职责，与本文件的权限判定分开。

func (a *Gateway) handlePermCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, permCatalogResp{Groups: permGroups, Perms: permCatalog, Aliases: permAliases})
}

const defaultGrantMark = "default"

func (a *Gateway) handlePermGranted(w http.ResponseWriter, r *http.Request) {
	app := callerApp(r)
	if app == hostApp || systemAppIDs[app] {
		writeJSON(w, appGrantedListResp{App: app, System: true, Granted: permIDs()})
		return
	}
	granted := a.store.AppGrants(app)
	for _, id := range permDefaultIDs() {
		if granted[id] == "" {
			granted[id] = defaultGrantMark
		}
	}
	writeJSON(w, appGrantedMapResp{App: app, System: false, Granted: granted})
}

func (a *Gateway) handlePermGrants(w http.ResponseWriter, r *http.Request) {
	if id := r.URL.Query().Get("app"); id != "" {
		writeJSON(w, grantsOneResp{Grants: map[string]any{id: a.store.AppGrants(id)}})
		return
	}
	writeJSON(w, grantsAllResp{Grants: a.store.AllGrants()})
}

type permManageReq struct {
	App   string   `json:"app"`
	Perms     []string `json:"perms"`
	ExpiresAt int64    `json:"expiresAt,omitempty"`

	Host string `json:"host,omitempty"`
}

func permReqHost(h string) string {
	if safeHostID(h) {
		return h
	}
	return ""
}

func (a *Gateway) decodePermReq(r *http.Request) (permManageReq, error) {
	var req permManageReq
	if err := decodeJSON(r, &req); err != nil {
		return req, err
	}
	if !appIDRe.MatchString(req.App) {
		return req, errors.New("应用 id 非法")
	}
	if len(req.Perms) == 0 {
		return req, errors.New("perms 不能为空")
	}
	for i, p := range req.Perms {

		p = PermNormalize(strings.TrimSpace(p))
		if !permKnown(p) {
			return req, fmt.Errorf("未知权限：%s", p)
		}
		req.Perms[i] = p
	}
	return req, nil
}

func (a *Gateway) handlePermGrant(w http.ResponseWriter, r *http.Request) {
	req, err := a.decodePermReq(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	host := permReqHost(req.Host)
	if systemAppIDs[req.App] {
		a.audit.record(auditEntry{
			AppID:  req.App,
			HostID: host,
			Type:   auditPermGrant,
			Target: "perm/grant",
			Detail: "system",
			Result: "system",
		})
		writeJSON(w, okSystemResp{OK: true, System: true})
		return
	}
	if !a.appExists(req.App) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("应用不存在：%s", req.App))
		return
	}
	if req.ExpiresAt > 0 {
		err = a.store.GrantScopes(req.App, req.Perms, "consent_session", req.ExpiresAt)
	} else {
		err = a.store.Grant(req.App, req.Perms)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.log.Info("app permission granted", "app", req.App, "count", len(req.Perms))
	a.audit.record(auditEntry{
		AppID:  req.App,
		HostID: host,
		Type:   auditPermGrant,
		Target: "perm/grant",
		Detail: strings.Join(req.Perms, ","),
		Result: "ok",
	})
	writeJSON(w, okGrantedResp{OK: true, Granted: a.store.AppGrants(req.App)})
}

func (a *Gateway) handlePermRevoke(w http.ResponseWriter, r *http.Request) {
	req, err := a.decodePermReq(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := a.store.Revoke(req.App, req.Perms); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	// 撤销权限要「立即」生效：递增令牌世代，旧令牌当场失效，
	// 应用下次换发的令牌自然不再携带被撤销的 scope。
	a.invalidateAppTokens(req.App)
	a.log.Info("app permission revoked", "app", req.App, "count", len(req.Perms))
	a.audit.record(auditEntry{
		AppID:  req.App,
		HostID: permReqHost(req.Host),
		Type:   auditPermRevoke,
		Target: "perm/revoke",
		Detail: strings.Join(req.Perms, ","),
		Result: "ok",
	})
	writeJSON(w, okGrantedResp{OK: true, Granted: a.store.AppGrants(req.App)})
}

func (a *Gateway) handlePermClear(w http.ResponseWriter, r *http.Request) {
	var req struct {
		App  string `json:"app"`
		Host string `json:"host,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !appIDRe.MatchString(req.App) {
		writeErr(w, http.StatusBadRequest, errors.New("应用 id 非法"))
		return
	}

	granted := a.store.AppGrants(req.App)
	before := make([]string, 0, len(granted))
	for k := range granted {
		before = append(before, k)
	}
	sort.Strings(before)
	if err := a.store.ClearGrants(req.App); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.log.Info("app permissions cleared", "app", req.App)
	// 清空授权是破坏性操作：立即整体撤销该应用的令牌。
	a.invalidateAppTokens(req.App)
	a.audit.record(auditEntry{
		AppID:  req.App,
		HostID: permReqHost(req.Host),
		Type:   auditPermClear,
		Target: "perm/clear",
		Detail: strings.Join(before, ","),
		Result: "ok",
	})
	writeJSON(w, okResp{OK: true})
}

func injectSession(html []byte, tok string) []byte {
	if tok == "" {
		return html
	}
	idx := bytes.LastIndex(bytes.ToLower(html), []byte("</head>"))
	if idx < 0 {
		return html
	}
	meta := []byte(`<meta name="qx-session" content="` + tok + `">`)
	out := make([]byte, 0, len(html)+len(meta))
	out = append(out, html[:idx]...)
	out = append(out, meta...)
	out = append(out, html[idx:]...)
	return out
}
