package httpapi

import (
	"qxssh/internal/config"
	"qxssh/internal/tunnel"
)

type okResp struct {
	OK bool `json:"ok"`
}

type okErrResp struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

type okPathResp struct {
	OK   bool   `json:"ok"`
	Path string `json:"path"`
}

type okKeyResp struct {
	OK  bool   `json:"ok"`
	Key string `json:"key"`
}

type okFromToResp struct {
	OK   bool   `json:"ok"`
	From string `json:"from"`
	To   string `json:"to"`
}

type okSystemResp struct {
	OK     bool `json:"ok"`
	System bool `json:"system"`
}

type okGrantedResp struct {
	OK      bool              `json:"ok"`
	Granted map[string]string `json:"granted"`
}

// tokenResp 是旧版「不透明随机串会话」的响应，保留给仍在用旧字段的宿主壳。
type tokenResp struct {
	Token string `json:"token"`
}

// sessionMintResp 是 session/mint 端点的标准响应结构：
// 访问令牌是可自验签的 JWT，刷新令牌是不透明随机串（只在宿主壳内传递）。
type sessionMintResp struct {
	Token            string   `json:"token"`
	TokenType        string   `json:"tokenType"`
	ExpiresIn        int      `json:"expiresIn"`
	Scope            []string `json:"scope"`
	RefreshToken     string   `json:"refreshToken"`
	RefreshExpiresIn int      `json:"refreshExpiresIn"`
}

// sessionRevokeReq 支持「按应用整体撤销」与「按单枚令牌吊销」两种粒度。
type sessionRevokeReq struct {
	App   string `json:"app"`
	Token string `json:"token"`
	Host  string `json:"host"`
}

type versionResp struct {
	Version string `json:"version"`
}

type languagesResp struct {
	Languages []langInfo `json:"languages"`
	Default   string     `json:"default"`
}

type langResp struct {
	Lang string `json:"lang"`
}

type prefsResp struct {
	Prefs map[string]string `json:"prefs"`
}

type hostsListResp struct {
	Hosts []config.PublicHost `json:"hosts"`
}

type hostTestResp struct {
	OK        bool  `json:"ok"`
	LatencyMs int64 `json:"latencyMs"`
}

type hostProbeResp struct {
	OK          bool    `json:"ok"`
	TCPMs       int64   `json:"tcpMs"`
	HandshakeMs int64   `json:"handshakeMs"`
	LatencyMs   int64   `json:"latencyMs"`
	OSID        *string `json:"osId,omitempty"`
	OSName      *string `json:"osName,omitempty"`
}

type hostCredentialResp struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

type hostsImportResp struct {
	OK       bool     `json:"ok"`
	Imported int      `json:"imported"`
	Errors   []string `json:"errors"`
}

type secretGetResp struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Found bool   `json:"found"`
}

type secretKeysResp struct {
	Keys []config.SecretMeta `json:"keys"`
}

type jobsListResp struct {
	Jobs []jobStatus `json:"jobs"`
}

type jobOutputResp struct {
	Data   string `json:"data"`
	Offset int64  `json:"offset"`
	Next   int64  `json:"next"`
	Size   int64  `json:"size"`
	Done   bool   `json:"done"`
}

type schedulesResp struct {
	Schedules []config.Schedule `json:"schedules"`
}

type tunnelsResp struct {
	Tunnels []tunnel.Running `json:"tunnels"`
}

type appsListResp struct {
	Apps []appEntry `json:"apps"`
}

type appValidateResp struct {
	App       appManifest `json:"app"`
	Installed bool        `json:"installed"`
	FileCount int         `json:"fileCount"`
	Size      int         `json:"size"`
}

type appEnabledResp struct {
	OK      bool   `json:"ok"`
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

type pathEntriesResp struct {
	Path    string       `json:"path"`
	Entries []storeEntry `json:"entries"`
}

type pathEntriesHomesResp struct {
	Path    string       `json:"path"`
	Entries []storeEntry `json:"entries"`
	Homes   []storeEntry `json:"homes"`
}

type sftpListResp struct {
	Path  string     `json:"path"`
	Files []fileInfo `json:"files"`
}

type sftpAttrOpResp struct {
	OK      bool     `json:"ok"`
	Results []attrOp `json:"results"`
}

type netHTTPResp struct {
	Status    int               `json:"status"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	Encoding  string            `json:"encoding"`
	Truncated bool              `json:"truncated"`
}

type execRunResp struct {
	OK        bool   `json:"ok"`
	Output    string `json:"output"`
	Error     string `json:"error"`
	Exit      int    `json:"exit"`
	Truncated bool   `json:"truncated"`
}

type execGoneResp struct {
	Gone    bool `json:"gone"`
	Running bool `json:"running"`
}

type execKillResp struct {
	OK   bool `json:"ok"`
	Gone bool `json:"gone"`
}

type bgSnapshot struct {
	ID      string   `json:"id"`
	PID     int      `json:"pid"`
	Running bool     `json:"running"`
	Argv    []string `json:"argv,omitempty"`
	Exit    *int     `json:"exit,omitempty"`
	Output  *string  `json:"output,omitempty"`
	Error   *string  `json:"error,omitempty"`
}

type bgStartResp struct {
	OK bool `json:"ok"`
	bgSnapshot
}

type auditLogsResp struct {
	Logs      []auditEntry `json:"logs"`
	Verbose   bool         `json:"verbose"`
	Sensitive bool         `json:"sensitive"`
}

type auditVerboseResp struct {
	OK       bool          `json:"ok"`
	Verbose  bool          `json:"verbose"`
	State    string        `json:"state"`
	Settings auditSettings `json:"settings"`
}

type auditSettingsGetResp struct {
	Settings    auditSettings   `json:"settings"`
	Group       *auditGroupStat `json:"group"`
	Path        string          `json:"path"`
	ArchivePath string          `json:"archivePath"`
}

type auditSettingsSetResp struct {
	OK          bool            `json:"ok"`
	Settings    auditSettings   `json:"settings"`
	Group       *auditGroupStat `json:"group"`
	Path        string          `json:"path"`
	ArchivePath string          `json:"archivePath"`
}

type auditResultResp struct {
	OK          bool            `json:"ok"`
	Result      auditResult     `json:"result"`
	Group       *auditGroupStat `json:"group"`
	Path        string          `json:"path"`
	ArchivePath string          `json:"archivePath"`
}

type auditClearResp struct {
	OK          bool            `json:"ok"`
	Result      auditResult     `json:"result"`
	Group       *auditGroupStat `json:"group"`
	Verbose     bool            `json:"verbose"`
	Path        string          `json:"path"`
	ArchivePath string          `json:"archivePath"`
}

type permCatalogResp struct {
	Groups  []permGroup       `json:"groups"`
	Perms   []permDef         `json:"perms"`
	Aliases map[string]string `json:"aliases"`
}

type appGrantedListResp struct {
	App     string   `json:"app"`
	System  bool     `json:"system"`
	Granted []string `json:"granted"`
}

type appGrantedMapResp struct {
	App     string            `json:"app"`
	System  bool              `json:"system"`
	Granted map[string]string `json:"granted"`
}

type grantsOneResp struct {
	Grants map[string]any `json:"grants"`
}

type grantsAllResp struct {
	Grants map[string]map[string]string `json:"grants"`
}
