// Package httpapi 是 QxSSH 的 HTTP / WebSocket API 网关。
//
// 它把每个端点注册为“方法 + 命名空间/方法 + 所需权限”的表项，由 sysDispatch
// 统一完成：会话令牌校验、应用权限判定、审计记录，再分派到业务处理函数。
// 中间件链负责全局鉴权（可选 Bearer/Cookie 令牌）、请求日志、panic 恢复与安全响应头；
// 静态资源与前端页面由 embed.FS 提供，宿主页面在渲染时注入会话令牌。
package httpapi

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"qxssh/internal/config"
	"qxssh/internal/logging"
	"qxssh/internal/proxy"
	"qxssh/internal/sshpool"
	"qxssh/internal/tunnel"
	"qxssh/internal/webui"
)

// Gateway 聚合 API 网关所需的全部依赖与运行时状态：
// 配置存储、SSH 连接池、转发/代理注册表，以及会话、审计、后台任务、调度器等子系统。
type Gateway struct {
	store     *config.Store
	mgr       *sshpool.Pool
	tunnels   *tunnel.Registry
	proxies   *proxy.Registry
	version   string
	configDir string
	log       *logging.Logger

	sudoMu    sync.Mutex
	sudoCreds map[string]sudoCred

	sysTable map[string]*sysEntry
	hostTok  string
	// hostClaims 是宿主不透明口令对应的内存「令牌」：不落盘、不过期、
	// 拥有全量权限。它与应用 JWT 走同一套校验入口（sessionClaims）。
	hostClaims *idpClaims
	// idp 是轻量 IdP：签发/验签应用访问令牌，并发布 JWKS。
	idp *idpKeys
	// deny 是访问令牌的 jti 吊销名单（值是令牌过期时间，过期后自动清理）。
	denyMu sync.RWMutex
	deny  map[string]int64

	bgMu    sync.Mutex
	bgProcs map[string]*bgProc
	bgSeq   uint64

	audit *auditStore

	appState *appState

	sched *scheduler

	authToken string

	wsSlots chan struct{}

	netHTTPMu    sync.Mutex
	netHTTPTr    map[netHTTPTransportKey]*http.Transport
	netHTTPOrder []netHTTPTransportKey

	sftpMu      sync.Mutex
	sftpClients map[string]*sftpShared

	elevMu   sync.Mutex
	elevInfo map[string]elevCacheEntry
}

func newGateway(store *config.Store, mgr *sshpool.Pool, tunnels *tunnel.Registry, wp *proxy.Registry, version, configDir string, log *logging.Logger) (*Gateway, error) {
	if log == nil {
		log = logging.New(logging.LevelInfo)
	}
	a := &Gateway{store: store, mgr: mgr, tunnels: tunnels, proxies: wp, version: version, configDir: configDir, log: log, authToken: os.Getenv("QXSSH_AUTH_TOKEN")}

	if err := store.NormalizeGrants(PermNormalize); err != nil {
		log.Warn("normalize app grants failed", "error", err.Error())
	}
	a.sysTable = map[string]*sysEntry{}
	a.hostTok = randTok()
	a.deny = map[string]int64{}
	a.bgProcs = map[string]*bgProc{}
	a.wsSlots = make(chan struct{}, wsMaxSessions)
	a.sftpClients = map[string]*sftpShared{}
	a.elevInfo = map[string]elevCacheEntry{}

	// 签名密钥是 IdP 的根基：读不出来就起不来，否则应用会拿到无法验签的令牌。
	idpKeys, err := loadIDPKeys(configDir)
	if err != nil {
		return nil, fmt.Errorf("初始化签名密钥失败: %w", err)
	}
	a.idp = idpKeys
	a.hostClaims = &idpClaims{
		Issuer: idpIssuer, Subject: hostApp, Audience: []string{idpAudience},
		Scope: permIDs(),
	}

	a.audit = newAuditStore(auditDir(configDir), archiveDir(configDir), store, log)
	a.appState = loadAppState(store, log)

	if n, perr := store.PurgeExpiredRefresh(time.Now().Unix()); perr != nil {
		log.Warn("purge expired refresh tokens failed", "error", perr.Error())
	} else if n > 0 {
		log.Info("purged expired refresh tokens", "count", n)
	}

	if mgr != nil {
		mgr.OnInvalidate(a.dropHostCache)
		a.sched = newScheduler(a)
	}
	return a, nil
}

// New 构建 API 网关的 HTTP 处理器以及一个用于关闭其后台资源的函数。
// 返回的 closes 函数会停止调度器、后台任务与挂在连接池上的联动钩子。
// 签名密钥等初始化失败时返回 error：此时起服务只会得到「应用拿不到可用令牌」的半可用状态。
func New(store *config.Store, mgr *sshpool.Pool, tunnels *tunnel.Registry, wp *proxy.Registry, version, configDir string, log *logging.Logger) (http.Handler, func(), error) {
	a, err := newGateway(store, mgr, tunnels, wp, version, configDir, log)
	if err != nil {
		return nil, func() {}, err
	}
	return a.routes(), a.closeBackground, nil
}

func (a *Gateway) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/v1/session/mint", a.handleSessionMint)
	mux.HandleFunc("POST /api/v1/session/refresh", a.handleSessionRefresh)
	mux.HandleFunc("POST /api/v1/session/revoke", a.handleSessionRevoke)

	// JWKS 发布签名公钥：纯公钥、无敏感信息，不需要会话；
	// 走 withCORS 的 /.well-known/ 与 /api/ 分支，便于未来外部客户端跨源读取。
	mux.HandleFunc("/.well-known/jwks.json", a.handleJWKS)
	mux.HandleFunc("/api/v1/jwks", a.handleJWKS)

	mux.HandleFunc("GET /api/v1/apps/file/{id}/{path...}", a.handleServeAppFile)

	mux.HandleFunc("/api/v1/{ns}", a.sysDispatch)
	mux.HandleFunc("/api/v1/ws/{ns}/{method}", a.sysDispatch)
	mux.HandleFunc("/api/v1/{ns}/{method}", a.sysDispatch)
	mux.HandleFunc("/api/v1/{ns}/{method}/{rest...}", a.sysDispatch)

	a.sysPerm("GET", "local/hostinfo", "local:hostinfo", a.handleLocalHostInfo)
	a.sysPub("GET", "host/version", a.handleInfo)

	a.sysPub("GET", "lang/list", a.handleLanguages)
	a.sysPub("GET", "lang/negotiate", a.handleLangNegotiate)

	a.sysPerm("GET", "hosts/list", "hosts:read", a.handleListHosts)

	a.sysNoBody("POST", "hosts/create", "hosts:create", a.handleCreateHost)
	a.sysNoBody("POST", "hosts/import", "hosts:import", a.handleImportHosts)
	a.sysNoBody("POST", "hosts/update", "hosts:update", a.handleUpdateHost)
	a.sysPerm("POST", "hosts/delete", "hosts:delete", a.handleDeleteHost)
	a.sysPerm("POST", "hosts/test", "hosts:test", a.handleTestHost)

	a.sysPerm("POST", "hosts/preconnect", "hosts:preconnect", a.handlePreconnectHost)

	a.sysPerm("POST", "hosts/probe", "hosts:probe", a.handleProbeHost)

	a.sysPerm("POST", "hosts/forget-os", "hosts:forgetos", a.handleForgetHostOS)

	a.sysPerm("POST", "hosts/credential", "hosts:credential", a.handleHostCredential)

	a.sysWS("term/session", "term:open", a.serveTerminalWS)

	a.sysPerm("POST", "exec/run", "exec:run", a.handleExecRun)
	a.sysPerm("POST", "exec/stream", "exec:stream", a.handleExecStream)
	a.sysPerm("GET", "exec/status", "local:exec", a.handleExecStatus)
	a.sysPerm("POST", "exec/kill", "local:exec", a.handleExecKill)
	a.sysWSPerm("exec/session", "exec:session", a.serveExecWS)

	a.sysPerm("POST", "job/start", "job:run", a.handleJobStart)
	a.sysPerm("GET", "job/status", "job:status", a.handleJobStatus)
	a.sysPerm("GET", "job/output", "job:output", a.handleJobOutput)
	a.sysPerm("POST", "job/kill", "job:kill", a.handleJobKill)
	a.sysPerm("GET", "job/list", "job:list", a.handleJobList)
	a.sysPerm("POST", "job/remove", "job:delete", a.handleJobRemove)

	a.sysPerm("GET", "schedule/list", "schedule:list", a.handleScheduleList)
	a.sysPerm("POST", "schedule/create", "schedule:create", a.handleScheduleCreate)
	a.sysPerm("POST", "schedule/update", "schedule:update", a.handleScheduleUpdate)
	a.sysPerm("POST", "schedule/delete", "schedule:delete", a.handleScheduleDelete)
	a.sysPerm("POST", "schedule/run", "schedule:run", a.handleScheduleRun)

	a.sysPerm("POST", "files/stat", "server:stat", a.handleSftpStat)
	a.sysPerm("GET", "files/list", "server:read", a.handleSftpList)
	a.sysPerm("GET", "files/download", "server:download", a.handleSftpDownload)
	a.sysPerm("POST", "files/mkdir", "server:mkdir", a.handleSftpMkdir)
	a.sysPerm("POST", "files/rm", "server:delete", a.handleSftpRemove)
	a.sysPerm("POST", "files/rename", "server:rename", a.handleSftpRename)
	a.sysPerm("POST", "files/copy", "server:copy", a.handleSftpCopy)
	a.sysPerm("POST", "files/move", "server:move", a.handleSftpMove)
	a.sysPerm("POST", "files/upload", "server:upload", a.handleSftpUpload)
	a.sysPerm("POST", "files/attrs", "server:attrs", a.handleSftpAttrs)

	a.sysNoBody("POST", "sudo/request", "sudo:request", a.handleSudoAuth)
	a.sysPerm("POST", "sudo/forget", "sudo:forget", a.handleSudoForget)

	a.sysPerm("POST", "tunnel/start", "tunnel:start", a.handleStartTunnel)
	a.sysPerm("GET", "tunnel/list", "tunnel:list", a.handleListTunnels)
	a.sysPerm("POST", "tunnel/stop", "tunnel:stop", a.handleStopTunnel)
	a.sysPerm("POST", "webproxy/start", "webproxy:start", a.handleStartWebProxy)
	a.sysPerm("POST", "webproxy/stop", "webproxy:stop", a.handleStopWebProxy)

	a.sysWSPerm("net/tcp", "net:tcp", a.serveTcpWS)
	a.sysPerm("POST", "net/http", "net:http", a.handleNetHTTP)

	a.sysPerm("GET", "apps/list", "apps:list", a.handleListUserApps)
	a.sysPerm("POST", "apps/validate", "apps:validate", a.handleValidateApp)
	a.sysPerm("POST", "apps/install", "apps:install", a.handleInstallApp)
	a.sysPerm("POST", "apps/uninstall", "apps:uninstall", a.handleUninstallApp)
	a.sysPerm("POST", "apps/git-branches", "apps:validate", a.handleGitBranches)

	a.sysPerm("POST", "apps/link", "apps:link", a.handleLinkApp)

	a.sysPerm("POST", "apps/enabled", "apps:toggle", a.handleSetAppEnabled)

	a.sysPub("GET", "perm/catalog", a.handlePermCatalog)
	a.sysPerm("GET", "perm/granted", "perm:granted", a.handlePermGranted)
	a.sysPerm("GET", "perm/grants", "perm:read", a.handlePermGrants)
	a.sysPerm("POST", "perm/grant", "perm:grant", a.handlePermGrant)
	a.sysPerm("POST", "perm/revoke", "perm:revoke", a.handlePermRevoke)
	a.sysPerm("POST", "perm/clear", "perm:clear", a.handlePermClear)

	a.sysPerm("GET", "prefs", "prefs:read", a.handleGetPrefs)
	a.sysPerm("PUT", "prefs", "prefs:write", a.handleSetPrefs)
	a.sysPerm("GET", "prefs/self", "prefs:self:read", a.handleGetAppPrefs)
	a.sysPerm("PUT", "prefs/self", "prefs:self:write", a.handleSetAppPrefs)

	a.sysPerm("GET", "logs/list", "logs:read", a.handleAuditList)

	a.sysPerm("POST", "audit/note", "audit:note", a.handleAuditNote)

	a.sysPerm("GET", "logs/settings", "logs:settings:read", a.handleAuditSettings)
	a.sysPerm("POST", "logs/settings", "logs:settings:write", a.handleAuditSettings)
	a.sysPerm("POST", "logs/verbose", "logs:verbose", a.handleAuditVerbose)
	a.sysPerm("POST", "logs/archive", "logs:archive", a.handleAuditArchive)
	a.sysPerm("POST", "logs/clear", "logs:clear", a.handleAuditClear)

	a.sysPerm("GET", "storage/list", "storage:list", a.handleStoreList)
	a.sysPerm("GET", "storage/read", "storage:read", a.handleStoreRead)
	a.sysPerm("POST", "storage/write", "storage:write", a.handleStoreWrite)
	a.sysPerm("POST", "storage/delete", "storage:delete", a.handleStoreDelete)
	a.sysPerm("POST", "storage/mkdir", "storage:mkdir", a.handleStoreMkdir)
	a.sysPerm("POST", "storage/rename", "storage:rename", a.handleStoreRename)

	a.sysPerm("GET", "secret/get", "secret:read", a.handleSecretGet)
	a.sysSecret("POST", "secret/set", "secret:write", a.handleSecretSet)
	a.sysPerm("POST", "secret/delete", "secret:delete", a.handleSecretDelete)
	a.sysPerm("GET", "secret/list", "secret:list", a.handleSecretList)

	a.sysPerm("GET", "localfs/list", "local:list", a.handleLocalList)
	a.sysPerm("GET", "localfs/read", "local:read", a.handleLocalRead)
	a.sysPerm("POST", "localfs/write", "local:write", a.handleLocalWrite)
	a.sysPerm("POST", "localfs/delete", "local:delete", a.handleLocalDelete)
	a.sysPerm("POST", "localfs/mkdir", "local:mkdir", a.handleLocalMkdir)
	a.sysPerm("POST", "localfs/rename", "local:rename", a.handleLocalRename)

	for key, e := range a.sysTable {
		if e.pub || e.perm == "" {
			continue
		}
		if !permKnown(e.perm) {
			panic(fmt.Sprintf("api: 注册表条目 %q 的权限键 %q 归一化后不在 permissions.go 的 permCatalog 中", key, e.perm))
		}
	}

	static := a.serveStatic()
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")

		if r.Method == http.MethodGet && strings.EqualFold(r.Header.Get("Sec-Fetch-Mode"), "navigate") {
			var name string
			switch r.URL.Path {
			case "/", "/index.html":
				name = "index.html"
			case "/desktop.html":
				name = "desktop.html"
			}
			if name != "" {
				if b, err := webui.FS.ReadFile(name); err == nil {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					_, _ = w.Write(injectSession(b, a.hostTok))
					return
				}
			}
		}
		static.ServeHTTP(w, r)
	}))

	return withSecurityHeaders(a.withCORS(a.withAuth(a.withLogging(a.withRecovery(mux)))))
}

// corsPath 报告哪些路径需要跨源头：应用资源、共享前端资源、API 与未来的
// JWKS（.well-known）。其余路径（宿主页面、图标等）不需要跨源读取。
func corsPath(p string) bool {
	switch {
	case strings.HasPrefix(p, "/api/"):
		return true
	case strings.HasPrefix(p, "/assets/"):
		return true
	case strings.HasPrefix(p, "/apps/"):
		return true
	case strings.HasPrefix(p, "/.well-known/"):
		return true
	}
	return false
}

// withCORS 为跨源请求补上 CORS 头。
//
// 应用被放入「无 allow-same-origin 的 sandbox」后处于不透明源（Origin: null）：
// ES Module 导入与 fetch 都按跨源处理，缺少这些响应头会让应用连自己的模块都加载不了。
// 因此这里回显 Origin（含字面量 null），并放行 X-Qx-Session/Authorization 等头部。
//
// 刻意不设置 Access-Control-Allow-Credentials：跨源调用只能凭会话令牌，
// 不能借宿主 Cookie 蒙混过关；OPTIONS 预检必须在部署门禁（withAuth）之前短路，
// 因为预检请求本身不携带凭据。
func (a *Gateway) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" || !corsPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Qx-Session")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sessionHeaderToken 取请求里携带的宿主会话令牌（应用 API 调用统一用它）。
func sessionHeaderToken(r *http.Request) string {
	if t := r.Header.Get("X-Qx-Session"); t != "" {
		return t
	}
	return r.URL.Query().Get("session")
}

func (a *Gateway) withAuth(next http.Handler) http.Handler {
	if a.authToken == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			tok = strings.TrimPrefix(auth, "Bearer ")
		} else if q := r.URL.Query().Get("token"); q != "" {
			tok = q
		} else if c, err := r.Cookie("qx_token"); err == nil && c != nil {
			tok = c.Value
		}

		if subtle.ConstantTimeCompare([]byte(tok), []byte(a.authToken)) == 1 {
			if r.URL.Query().Get("token") != "" {
				http.SetCookie(w, &http.Cookie{
					Name:     "qx_token",
					Value:    a.authToken,
					Path:     "/",
					HttpOnly: true,
					SameSite: http.SameSiteStrictMode,
				})
			}
			next.ServeHTTP(w, r)
			return
		}

		// 应用 iframe 处于不透明源，拿不到宿主的部署 Cookie（qx_token）；
		// 只要携带的是宿主签发的有效会话令牌，就视为已通过「部署门禁」。
		// 注意：逐权限判定仍由 sysDispatch 按应用身份完成，这里只是放行门禁。
		if sess := sessionHeaderToken(r); sess != "" && a.sessionApp(sess) != "" {
			next.ServeHTTP(w, r)
			return
		}

		http.Error(w, "Unauthorized: invalid or missing auth token", http.StatusUnauthorized)
	})
}

const slowRequestMs = 1500

func (a *Gateway) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		dur := time.Since(start)
		kv := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur", dur.Round(time.Millisecond).String(),
		}
		switch {
		case rec.status >= http.StatusInternalServerError:
			a.log.Error("api request failed", kv...)
		case rec.status >= http.StatusBadRequest || dur > time.Duration(slowRequestMs)*time.Millisecond:
			a.log.Warn("api request slow/error", kv...)
		default:
			a.log.Debug("api request", kv...)
		}
	})
}

func (a *Gateway) withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				stack := debug.Stack()
				if len(stack) > 8<<10 {
					stack = stack[:8<<10]
				}
				a.log.Error("panic recovered",
					"method", r.Method,
					"path", r.URL.Path,
					"panic", fmt.Sprint(rec),
					"stack", string(stack),
				)
				writeErr(w, http.StatusInternalServerError, errors.New("internal server error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	n      int64

	errCap int
	errBuf bytes.Buffer
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.errCap > 0 && w.status >= 400 && w.errBuf.Len() < w.errCap {
		w.errBuf.Write(b[:min(len(b), w.errCap-w.errBuf.Len())])
	}
	n, err := w.ResponseWriter.Write(b)
	w.n += int64(n)
	return n, err
}

func (w *statusWriter) errSnippet() string { return w.errBuf.String() }

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("api: response writer does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
