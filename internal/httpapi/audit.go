package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type auditType string

const (
	auditAPICall       auditType = "api_call"
	auditPermRequest   auditType = "perm_request"
	auditPermGrant     auditType = "perm_grant"
	auditPermRevoke    auditType = "perm_revoke"
	auditPermClear     auditType = "perm_clear"
	auditSessionMint   auditType = "session_mint"
	auditSessionRevoke auditType = "session_revoke"
	auditNote          auditType = "note"
	auditSystem        auditType = "system"
)

type auditEntry struct {
	Seq      uint64    `json:"seq"`
	Time     time.Time `json:"time"`
	AppID    string    `json:"appId"`
	HostID   string    `json:"hostId,omitempty"`
	Type     auditType `json:"type"`
	Target   string    `json:"target,omitempty"`
	Detail   string    `json:"detail,omitempty"`
	Result   string    `json:"result,omitempty"`
	Duration int64     `json:"durationMs,omitempty"`

	User  string   `json:"user,omitempty"`
	Scope []string `json:"scope,omitempty"`
	JTI   string   `json:"jti,omitempty"`
	Deny  string   `json:"deny,omitempty"`

	Verbose *auditVerbose `json:"verbose,omitempty"`
}

type auditVerbose struct {
	Query     string            `json:"query,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body,omitempty"`
	BodyBytes int64             `json:"bodyBytes,omitempty"`
	BodyNote  string            `json:"bodyNote,omitempty"`
	Remote    string            `json:"remote,omitempty"`
	Agent     string            `json:"agent,omitempty"`
	Referer   string            `json:"referer,omitempty"`
	Origin    string            `json:"origin,omitempty"`
	FetchMode string            `json:"fetchMode,omitempty"`
	FetchDest string            `json:"fetchDest,omitempty"`
	RespType  string            `json:"respType,omitempty"`
	RespBytes int64             `json:"respBytes,omitempty"`
	RespError string            `json:"respError,omitempty"`
}

const (
	auditNoHostGroup = "_"

	auditRingCap = 2000

	auditTailBytes = 1 << 20

	auditScanTailBytes = 128 << 10

	archiveScanArchives = 1

	archiveHydrateArchives = 2

	auditBodyMax = 64 << 10

	auditRespErrMax = 4 << 10

	auditHeaderMax = 2 << 10

	auditQueue = 16384

	auditSysQueue = 256

	auditEnvelopeV = 1

	auditAppID = "logs"

	auditCurSub = "audit"
	auditArcSub = "archlive"
)

func auditStoreRoot(configDir string) string {
	return filepath.Join(configDir, "appdata", auditAppID)
}

func auditDir(configDir string) string {
	return filepath.Join(auditStoreRoot(configDir), auditCurSub)
}

func archiveDir(configDir string) string {
	return filepath.Join(auditStoreRoot(configDir), auditArcSub)
}

type auditEnvelope struct {
	V    int    `json:"v"`
	Data string `json:"d"`
	// 哈希链表头：Prev 是上一条已落盘行的哈希（首条为空），Hash 是本行载荷的
	// SHA-256(prev || payload)。二者只出现在 v=2 链路信封里，旧行没有也能读。
	Prev string `json:"p,omitempty"`
	Hash string `json:"h,omitempty"`
}

// auditChainV 是带完整性链的信封版本。载荷仍是原来的明文条目或 v=1 加密信封，
// 只是外面再套一层链接，便于逐行校验而不改变既有内容格式。
const auditChainV = 2

// chainHash 计算 SHA-256(prev || payload) 的十六进制摘要。
func chainHash(prev string, payload []byte) string {
	h := sha256.New()
	h.Write([]byte(prev))
	h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))
}

// marshalChained 把一条审计条目编码成带哈希链的信封行。
func (s *auditStore) marshalChained(e auditEntry, prev string) ([]byte, string, error) {
	payload, err := s.marshalLine(e)
	if err != nil {
		return nil, "", err
	}
	sum := chainHash(prev, payload)
	line, err := json.Marshal(auditEnvelope{
		V: auditChainV, Prev: prev, Hash: sum,
		Data: base64.StdEncoding.EncodeToString(payload),
	})
	if err != nil {
		return nil, "", err
	}
	return line, sum, nil
}

func (s *auditStore) marshalLine(e auditEntry) ([]byte, error) {
	if e.Verbose == nil {
		return json.Marshal(e)
	}
	if s.se == nil {
		return nil, errors.New("审计条目含敏感内容但主密钥不可用")
	}
	plain, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	sealed, err := s.se.Seal(plain, nil)
	if err != nil {
		return nil, err
	}
	return json.Marshal(auditEnvelope{V: auditEnvelopeV, Data: base64.StdEncoding.EncodeToString(sealed)})
}

func (s *auditStore) unmarshalLine(b []byte) (auditEntry, error) {
	e, _, _, err := s.unmarshalVerified(b)
	return e, err
}

// errAuditChainBroken 表示某条审计记录的哈希链校验不通过（被改写/插入）。
var errAuditChainBroken = errors.New("审计记录哈希链已断裂")

// unmarshalVerified 解出一条审计记录，并返回它的链哈希与声明的 prev
// （非链行两者均为空串）。链行会同时校验自身摘要；校验不过时返回错误。
func (s *auditStore) unmarshalVerified(b []byte) (auditEntry, string, string, error) {
	var env auditEnvelope
	if err := json.Unmarshal(b, &env); err == nil && env.V == auditChainV && env.Data != "" {
		payload, err := base64.StdEncoding.DecodeString(env.Data)
		if err != nil {
			return auditEntry{}, "", "", err
		}
		if want := chainHash(env.Prev, payload); want != env.Hash {
			return auditEntry{}, "", "", errAuditChainBroken
		}
		e, err := s.unmarshalLine(payload)
		if err != nil {
			return auditEntry{}, "", "", err
		}
		return e, env.Hash, env.Prev, nil
	}
	if err := json.Unmarshal(b, &env); err == nil && env.V == auditEnvelopeV && env.Data != "" {
		if s.se == nil {
			return auditEntry{}, "", "", errors.New("审计条目已加密但主密钥不可用")
		}
		raw, err := base64.StdEncoding.DecodeString(env.Data)
		if err != nil {
			return auditEntry{}, "", "", err
		}
		plain, err := s.se.Open(raw, nil)
		if err != nil {
			return auditEntry{}, "", "", err
		}
		var e auditEntry
		if err := json.Unmarshal(plain, &e); err != nil {
			return auditEntry{}, "", "", err
		}
		return e, "", "", nil
	}
	var e auditEntry
	if err := json.Unmarshal(b, &e); err != nil {
		return auditEntry{}, "", "", err
	}
	return e, "", "", nil
}

func countJSONL(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	buf := make([]byte, 64<<10)
	var n int64
	var lastByte byte
	for {
		read, err := f.Read(buf)
		for i := 0; i < read; i++ {
			if buf[i] == '\n' {
				n++
			}
		}
		if read > 0 {
			lastByte = buf[read-1]
		}
		if err != nil {
			break
		}
	}
	if n == 0 {

		if fi, serr := f.Stat(); serr == nil && fi.Size() > 0 {
			return 1
		}
		return 0
	}
	if lastByte != '\n' {
		n++
	}
	return n
}

const (
	auditDefMaxBytes   = 8 << 20
	auditDefArchives   = 1
	auditMinArchives   = 1
	auditMaxArchives   = 10
	auditMinMaxBytes   = 64 << 10
	auditMaxMaxBytes   = 64 << 20
	auditMaxRetention  = 3650
	auditRotateArchive = "archive"
	auditRotateDelete  = "delete"
)

type auditSettings struct {
	Verbose bool `json:"verbose"`

	MaxBytes int64 `json:"maxBytes"`

	Archives int `json:"archives"`

	RotateMode string `json:"rotateMode"`

	RetentionDays int `json:"retentionDays"`
}

func defaultAuditSettings() auditSettings {
	return auditSettings{
		MaxBytes:      auditDefMaxBytes,
		Archives:      auditDefArchives,
		RotateMode:    auditRotateArchive,
		RetentionDays: 0,
	}
}

func (s auditSettings) normalize() auditSettings {
	if s.MaxBytes < auditMinMaxBytes {
		s.MaxBytes = auditDefMaxBytes
	}
	if s.MaxBytes > auditMaxMaxBytes {
		s.MaxBytes = auditMaxMaxBytes
	}
	if s.Archives < auditMinArchives {
		s.Archives = auditDefArchives
	}
	if s.Archives > auditMaxArchives {
		s.Archives = auditMaxArchives
	}
	if s.RotateMode != auditRotateDelete {
		s.RotateMode = auditRotateArchive
	}
	if s.RetentionDays < 0 {
		s.RetentionDays = 0
	}
	if s.RetentionDays > auditMaxRetention {
		s.RetentionDays = auditMaxRetention
	}
	return s
}

func (s *auditStore) Verbose() bool { return s.verbose.Load() }

func (s *auditStore) SetVerbose(on bool) (auditSettings, error) {
	cur := s.settings()
	if cur.Verbose == on {
		return cur, nil
	}
	cur.Verbose = on
	set, err := s.applySettings(cur)
	if err != nil {
		return s.settings(), err
	}
	s.verbose.Store(on)
	return set, nil
}

func auditGroupDir(hostID string) string {
	if hostID == "" {
		return auditNoHostGroup
	}
	return hostID
}

func hostIDOfGroup(g string) string {
	if g == auditNoHostGroup {
		return ""
	}
	return g
}

func auditGroupNameOK(g string) bool {
	if g == "" {
		return false
	}
	for _, r := range g {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func requireAuditGroup(hostID string) (string, error) {
	if hostID == "" {
		return "", errors.New("缺少 host 参数：审计数据按工作区隔离，必须指明要看或要操作的工作区")
	}
	if !auditGroupNameOK(hostID) {
		return "", errors.New("host 参数含非法字符")
	}
	return auditGroupDir(hostID), nil
}

func (a *Gateway) requireAuditAdmin(w http.ResponseWriter, r *http.Request) bool {
	app := callerApp(r)
	if app != hostApp && !systemAppIDs[app] {
		writeErr(w, http.StatusForbidden, errors.New("只有宿主或系统应用可以管理审计配置和归档"))
		return false
	}
	return true
}

func (a *Gateway) auditGroup(g string) *auditGroupStat {
	st, ok := a.audit.statOf(g)
	if !ok {
		return nil
	}
	if st.HostID == "" {
		st.Name = "宿主页面（无归属）"
		return &st
	}
	if h, ok := a.store.GetHost(st.HostID); ok {
		st.Name = h.Name
	}
	return &st
}

func (a *Gateway) handleAuditList(w http.ResponseWriter, r *http.Request) {
	if !a.requireAuditAdmin(w, r) {
		return
	}
	q := r.URL.Query()
	group, err := requireAuditGroup(q.Get("host"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	appID := q.Get("app")
	typ := auditType(q.Get("type"))
	onlyHost := q.Get("page") == "1" && appID == ""
	limit := 200
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	sensitive := a.permAllowed(callerApp(r), permLogsSensitive)
	logs := a.audit.list(group, appID, onlyHost, typ, limit)
	if !sensitive {
		for i := range logs {
			logs[i].Verbose = nil
		}
	}
	writeJSON(w, auditLogsResp{
		Logs: logs, Verbose: a.audit.Verbose(), Sensitive: sensitive,
	})
}

func (a *Gateway) handleAuditVerbose(w http.ResponseWriter, r *http.Request) {
	if !a.requireAuditAdmin(w, r) {
		return
	}
	var req struct {
		Verbose bool   `json:"verbose"`
		Host    string `json:"host,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	set, err := a.audit.SetVerbose(req.Verbose)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	state := "已关闭"
	if req.Verbose {
		state = "已开启"
	}
	a.log.Info("audit verbose changed", "verbose", req.Verbose)
	a.audit.recordSystem(auditEntry{
		Target: "logs/verbose",
		Detail: fmt.Sprintf("caller=%s verbose=%v", callerApp(r), req.Verbose), Result: "ok",
	})
	writeJSON(w, auditVerboseResp{OK: true, Verbose: req.Verbose, State: state, Settings: set})
}

func (a *Gateway) handleAuditSettings(w http.ResponseWriter, r *http.Request) {
	if !a.requireAuditAdmin(w, r) {
		return
	}
	cur := a.audit.settings()
	if r.Method == http.MethodGet {
		group, err := requireAuditGroup(r.URL.Query().Get("host"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, auditSettingsGetResp{
			Settings: cur, Group: a.auditGroup(group), Path: a.audit.Path(), ArchivePath: a.audit.ArchivePath(),
		})
		return
	}

	var patch struct {
		Host          string  `json:"host"`
		Verbose       *bool   `json:"verbose"`
		MaxBytes      *int64  `json:"maxBytes"`
		Archives      *int    `json:"archives"`
		RotateMode    *string `json:"rotateMode"`
		RetentionDays *int    `json:"retentionDays"`
	}
	if err := decodeJSON(r, &patch); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	group, err := requireAuditGroup(patch.Host)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	merged := cur
	if patch.Verbose != nil {
		merged.Verbose = *patch.Verbose
	}
	if patch.MaxBytes != nil {
		merged.MaxBytes = *patch.MaxBytes
	}
	if patch.Archives != nil {
		merged.Archives = *patch.Archives
	}
	if patch.RotateMode != nil {
		merged.RotateMode = *patch.RotateMode
	}
	if patch.RetentionDays != nil {
		merged.RetentionDays = *patch.RetentionDays
	}
	set, err := a.audit.applySettings(merged)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.audit.verbose.Store(set.Verbose)
	a.log.Info("audit settings changed",
		"verbose", set.Verbose, "maxBytes", set.MaxBytes, "archives", set.Archives,
		"rotateMode", set.RotateMode, "retentionDays", set.RetentionDays)
	a.audit.recordSystem(auditEntry{
		HostID: group, Target: "logs/settings",
		Detail: fmt.Sprintf("caller=%s verbose=%v maxBytes=%d archives=%d rotate=%s retention=%d",
			callerApp(r), set.Verbose, set.MaxBytes, set.Archives, set.RotateMode, set.RetentionDays),
		Result: "ok",
	})
	writeJSON(w, auditSettingsSetResp{
		OK: true, Settings: set, Group: a.auditGroup(group), Path: a.audit.Path(), ArchivePath: a.audit.ArchivePath(),
	})
}

func (a *Gateway) handleAuditArchive(w http.ResponseWriter, r *http.Request) {
	if !a.requireAuditAdmin(w, r) {
		return
	}
	var req struct {
		Host string `json:"host"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	group, err := requireAuditGroup(req.Host)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	res, err := a.audit.control(auditCmdArchive, group)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.log.Info("audit archived", "group", group, "bytes", res.Freed)
	// 管理操作自身入独立系统审计（QX-039）。
	a.audit.recordSystem(auditEntry{
		HostID: group, Target: "logs/archive",
		Detail: fmt.Sprintf("caller=%s freed=%d", callerApp(r), res.Freed), Result: "ok",
	})
	writeJSON(w, auditResultResp{
		OK: true, Result: res, Group: a.auditGroup(group), Path: a.audit.Path(), ArchivePath: a.audit.ArchivePath(),
	})
}

func (a *Gateway) handleAuditClear(w http.ResponseWriter, r *http.Request) {
	if !a.requireAuditAdmin(w, r) {
		return
	}
	var req struct {
		Host string `json:"host"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	group, err := requireAuditGroup(req.Host)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	res, err := a.audit.control(auditCmdClear, group)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.log.Info("audit cleared", "group", group, "bytes", res.Freed)
	// 清空操作自身入独立系统审计（QX-039）：组级清空删不掉 system.jsonl。
	a.audit.recordSystem(auditEntry{
		HostID: group, Target: "logs/clear",
		Detail: fmt.Sprintf("caller=%s freed=%d", callerApp(r), res.Freed), Result: "ok",
	})
	writeJSON(w, auditClearResp{
		OK: true, Result: res, Group: a.auditGroup(group),
		Verbose: a.audit.Verbose(), Path: a.audit.Path(), ArchivePath: a.audit.ArchivePath(),
	})
}

const (
	auditNoteActionMax = 120
	auditNoteDetailMax = 2 << 10
)

func (a *Gateway) handleAuditNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string `json:"action"`
		Detail string `json:"detail"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	action := strings.TrimSpace(req.Action)
	if action == "" {
		writeErr(w, http.StatusBadRequest, errors.New("action 为必填项"))
		return
	}
	app := callerApp(r)
	if app != hostApp && !systemAppIDs[app] {
		writeErr(w, http.StatusForbidden, errors.New("审计备注仅限宿主或系统应用"))
		return
	}
	hostID := peekHostID(r)
	if app == hostApp {
		app = ""
	}
	a.audit.record(auditEntry{
		AppID:  app,
		HostID: hostID,
		Type:   auditNote,
		Target: truncStr(action, auditNoteActionMax),
		Detail: truncStr(req.Detail, auditNoteDetailMax),
		Result: "ok",
	})
	writeJSON(w, okResp{OK: true})
}
