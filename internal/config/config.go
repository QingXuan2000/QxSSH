// Package config 管理 QxSSH 的持久化配置。
//
// 它以纯 Go 的 SQLite 作为存储后端，用 AES-256-GCM 加密主机凭据与应用机密，
// 对外提供主机增删改查、应用权限授权、界面偏好、定时任务、应用机密等访问接口。
// 所有写操作在锁内完成并同步落库，读操作返回数据副本以避免外部修改内部状态。
package config

import (
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Host 是一台受管 SSH 主机的完整配置，包含加密后的凭据字段。
// Password、KeyData、KeyPassphrase 在存储层为密文，仅在 GetHost 返回时解密。
type Host struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Group         string `json:"group,omitempty"`
	Address       string `json:"address"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	AuthType      string `json:"authType"`
	Password      string `json:"password,omitempty"`
	KeyData       string `json:"keyData,omitempty"`
	KeyPath       string `json:"keyPath,omitempty"`
	KeyPassphrase string `json:"keyPassphrase,omitempty"`
	Note          string `json:"note,omitempty"`

	JumpHostID string `json:"jumpHostId,omitempty"`
}

// MaxJumpDepth 是跳板链允许的最大层级数。
const MaxJumpDepth = 5

// Store 是配置存储，封装 SQLite 连接、加解密引擎与内存中的数据快照。
// 所有方法都通过内部互斥锁保证并发安全。
type Store struct {
	mu   sync.RWMutex
	dir  string
	db   *sql.DB
	gcm  cipher.AEAD
	data storeData
}

// ScopeGrant 是应用授权映射表（app_scopes）中的一条记录。
type ScopeGrant struct {
	Scope     string `json:"scope"`
	Granted   int64  `json:"granted"`
	GrantedBy string `json:"grantedBy,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
}

type storeData struct {
	Hosts     []Host
	AppGrants map[string]map[string]string
	AppScopes map[string]map[string]ScopeGrant
}

// Load 打开（必要时创建）dir 下的配置数据库并返回 Store。
// dir 为空时使用用户配置目录下的 qxssh。它会检查 schema 版本、解析/生成主密钥并加载数据。
func Load(dir string) (*Store, error) {
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(base, "qxssh")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	db, err := openDB(dbPath(dir))
	if err != nil {
		return nil, err
	}
	tooNewVer, tooNew, err := schemaTooNew(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	if tooNew {
		db.Close()
		return nil, fmt.Errorf("数据库 %s 由更新版本的 QxSSH 创建（schema v%d > 本程序 v%d），请升级后再运行",
			dbPath(dir), tooNewVer, schemaVersion)
	}
	if err := ensureSchemaVersion(db); err != nil {
		db.Close()
		return nil, err
	}
	key, err := resolveMasterKey(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{dir: dir, db: db, gcm: gcm, data: storeData{AppGrants: map[string]map[string]string{}}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.migrateGrants(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close 关闭底层数据库连接。可安全重复调用。
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *Store) reloadLocked() error {
	s.data = storeData{
		Hosts:     nil,
		AppGrants: map[string]map[string]string{},
		AppScopes: map[string]map[string]ScopeGrant{},
	}

	rows, err := s.db.Query(`SELECT ` + selectHostCols + ` FROM hosts ORDER BY ord, rowid`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		h, err := scanHost(rows)
		if err != nil {
			return err
		}
		s.data.Hosts = append(s.data.Hosts, h)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	gr, err := s.db.Query(`SELECT app_id, perm, granted FROM app_grants`)
	if err != nil {
		return err
	}
	defer gr.Close()
	for gr.Next() {
		var app, perm, at string
		if err := gr.Scan(&app, &perm, &at); err != nil {
			return err
		}
		if s.data.AppGrants[app] == nil {
			s.data.AppGrants[app] = map[string]string{}
		}
		s.data.AppGrants[app][perm] = at
	}
	if err := gr.Err(); err != nil {
		return err
	}

	scRows, err := s.db.Query(`SELECT app_id, scope, granted, granted_by, expires_at FROM app_scopes`)
	if err != nil {
		return err
	}
	defer scRows.Close()
	for scRows.Next() {
		var app, sc, by string
		var at, exp int64
		if err := scRows.Scan(&app, &sc, &at, &by, &exp); err != nil {
			return err
		}
		if s.data.AppScopes[app] == nil {
			s.data.AppScopes[app] = map[string]ScopeGrant{}
		}
		s.data.AppScopes[app][sc] = ScopeGrant{
			Scope:     sc,
			Granted:   at,
			GrantedBy: by,
			ExpiresAt: exp,
		}
	}
	if err := scRows.Err(); err != nil {
		return err
	}

	return s.migrateGrantsToScopesLocked()
}

func (s *Store) encrypt(v string) string {
	if v == "" {
		return ""
	}
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return ""
	}
	ct := s.gcm.Seal(nonce, nonce, []byte(v), nil)
	return base64.StdEncoding.EncodeToString(ct)
}

func (s *Store) decrypt(v string) string {
	if v == "" {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return ""
	}
	ns := s.gcm.NonceSize()
	if len(data) < ns {
		return ""
	}
	pt, err := s.gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return ""
	}
	return string(pt)
}

// Seal 用主密钥加密 plaintext，aad 作为附加认证数据。返回的密文前带随机 nonce。
func (s *Store) Seal(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.gcm.Seal(nonce, nonce, plaintext, aad), nil
}

// Open 解密由 Seal 生成的密文，aad 必须与加密时一致。
func (s *Store) Open(sealed, aad []byte) ([]byte, error) {
	ns := s.gcm.NonceSize()
	if len(sealed) < ns {
		return nil, errors.New("密文长度不足")
	}
	return s.gcm.Open(nil, sealed[:ns], sealed[ns:], aad)
}

// NewID 生成一个 16 位十六进制随机 ID，用于主机等实体。
// crypto/rand 不可用时直接 panic，拒绝生成不安全的 ID。
func NewID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("qxssh: crypto/rand 不可用，拒绝生成主机 ID: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// PublicHost 是主机面向客户端的公开视图：不含任何明文凭据，
// 只用 HasPassword/HasKeyPass/HasKey 等布尔量表示凭据是否存在。
type PublicHost struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Group        string `json:"group,omitempty"`
	Address      string `json:"address"`
	Port         int    `json:"port"`
	User         string `json:"user"`
	AuthType     string `json:"authType"`
	KeyPath      string `json:"keyPath,omitempty"`
	HasPassword  bool   `json:"hasPassword"`
	HasKeyPass   bool   `json:"hasKeyPassphrase"`
	HasKey       bool   `json:"hasKey"`
	Note         string `json:"note,omitempty"`
	JumpHostID   string `json:"jumpHostId,omitempty"`
	JumpHostName string `json:"jumpHostName,omitempty"`
	OSID         string `json:"osId,omitempty"`
	OSName       string `json:"osName,omitempty"`
}

// Public 把内部 Host 转换为不含明文凭据的 PublicHost。
func (h Host) Public() PublicHost {
	return PublicHost{
		ID: h.ID, Name: h.Name, Group: h.Group, Address: h.Address,
		Port: h.Port, User: h.User, AuthType: h.AuthType, KeyPath: h.KeyPath,
		HasPassword: h.Password != "", HasKeyPass: h.KeyPassphrase != "",
		HasKey: h.KeyData != "",
		Note:   h.Note, JumpHostID: h.JumpHostID,
	}
}

const (
	osIDPrefPrefix   = "qx-host-os-"
	osNamePrefPrefix = "qx-host-osname-"
	osPrefPrefix     = "qx-host-os"
)

func (s *Store) osMapsLocked() (ids, names map[string]string) {
	ids, names = map[string]string{}, map[string]string{}
	if s.db == nil {
		return ids, names
	}
	rows, err := s.db.Query(`SELECT key, value FROM prefs WHERE key LIKE ?`,
		osPrefPrefix+"%")
	if err != nil {
		return ids, names
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		if id, ok := strings.CutPrefix(k, osNamePrefPrefix); ok {
			names[id] = v
			continue
		}
		if id, ok := strings.CutPrefix(k, osIDPrefPrefix); ok {
			ids[id] = v
		}
	}
	return ids, names
}

// HostOS 返回为某主机记忆的操作系统图标与名称（不存在时返回空串）。
func (s *Store) HostOS(hostID string) (icon, name string) {
	if hostID == "" {
		return "", ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return "", ""
	}
	_ = s.db.QueryRow(`SELECT value FROM prefs WHERE key = ?`, osIDPrefPrefix+hostID).Scan(&icon)
	_ = s.db.QueryRow(`SELECT value FROM prefs WHERE key = ?`, osNamePrefPrefix+hostID).Scan(&name)
	return icon, name
}

// JumpDependents 返回把 hostID 作为跳板机的主机 ID 列表。
func (s *Store) JumpDependents(hostID string) []string {
	if hostID == "" {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []string
	for i := range s.data.Hosts {
		if s.data.Hosts[i].JumpHostID == hostID && s.data.Hosts[i].ID != hostID {
			out = append(out, s.data.Hosts[i].ID)
		}
	}
	return out
}

// SetHostOS 记忆某主机的操作系统图标与名称（存于 prefs）。
func (s *Store) SetHostOS(hostID, icon, name string) error {
	if hostID == "" {
		return errors.New("主机 id 不能为空")
	}
	return s.SetPrefs(map[string]string{
		osIDPrefPrefix + hostID:   icon,
		osNamePrefPrefix + hostID: name,
	})
}

// ClearHostOS 清除某主机记忆的操作系统信息。
func (s *Store) ClearHostOS(hostID string) error {
	if hostID == "" {
		return errors.New("主机 id 不能为空")
	}

	return s.SetPrefs(map[string]string{
		osIDPrefPrefix + hostID:   "",
		osNamePrefPrefix + hostID: "",
	})
}

// ListHosts 返回全部主机的公开视图，按保存顺序排列，并补全跳板机名称与 OS 记忆。
func (s *Store) ListHosts() []PublicHost {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PublicHost, 0, len(s.data.Hosts))
	for _, h := range s.data.Hosts {
		out = append(out, h.Public())
	}
	names := map[string]string{}
	for _, h := range s.data.Hosts {
		names[h.ID] = h.Name
	}
	osIDs, osNames := s.osMapsLocked()
	for i := range out {
		if out[i].JumpHostID != "" {
			out[i].JumpHostName = names[out[i].JumpHostID]
		}
		out[i].OSID = osIDs[out[i].ID]
		out[i].OSName = osNames[out[i].ID]
	}
	return out
}

// GetHost 按 id 返回主机，凭据字段会被解密为明文。第二个返回值表示是否存在。
func (s *Store) GetHost(id string) (Host, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, h := range s.data.Hosts {
		if h.ID == id {

			h.Password = s.decrypt(h.Password)
			h.KeyData = s.decrypt(h.KeyData)
			h.KeyPassphrase = s.decrypt(h.KeyPassphrase)
			return h, true
		}
	}
	return Host{}, false
}

// HostUpdate 是主机更新请求。所有字段均为指针：nil 表示“不修改该字段”，
// 用于区分“置空”与“未提供”。
type HostUpdate struct {
	Name          *string `json:"name"`
	Group         *string `json:"group"`
	Address       *string `json:"address"`
	Port          *int    `json:"port"`
	User          *string `json:"user"`
	AuthType      *string `json:"authType"`
	Password      *string `json:"password"`
	KeyData       *string `json:"keyData"`
	KeyPath       *string `json:"keyPath"`
	KeyPassphrase *string `json:"keyPassphrase"`
	Note          *string `json:"note"`
	JumpHostID    *string `json:"jumpHostId"`
}

// CreateHost 新建主机。Name、Address、User 为必填；凭据会被加密后落库。
func (s *Store) CreateHost(u HostUpdate) (PublicHost, error) {
	if u.Name == nil || *u.Name == "" {
		return PublicHost{}, errors.New("name is required")
	}
	if u.Address == nil || *u.Address == "" {
		return PublicHost{}, errors.New("address is required")
	}
	if u.User == nil || *u.User == "" {
		return PublicHost{}, errors.New("user is required")
	}
	port := 22
	if u.Port != nil && *u.Port > 0 {
		port = *u.Port
	}
	auth := "password"
	if u.AuthType != nil && *u.AuthType != "" {
		auth = *u.AuthType
	}
	h := Host{
		ID:       NewID(),
		Name:     *u.Name,
		Address:  *u.Address,
		Port:     port,
		User:     *u.User,
		AuthType: auth,
	}
	if u.Group != nil {
		h.Group = *u.Group
	}
	if u.Note != nil {
		h.Note = *u.Note
	}
	if u.JumpHostID != nil {
		h.JumpHostID = *u.JumpHostID
	}
	if u.KeyPath != nil {
		h.KeyPath = *u.KeyPath
	}
	if u.KeyData != nil {
		h.KeyData = s.encrypt(*u.KeyData)
	}
	if u.Password != nil {
		h.Password = s.encrypt(*u.Password)
	}
	if u.KeyPassphrase != nil {
		h.KeyPassphrase = s.encrypt(*u.KeyPassphrase)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validateJumpLocked(&h); err != nil {
		return PublicHost{}, err
	}
	ord := len(s.data.Hosts)
	if _, err := s.db.Exec(insertHostSQL, h.ID, ord, h.Name, h.Group, h.Address, h.Port,
		h.User, h.AuthType, h.Password, h.KeyData, h.KeyPath, h.KeyPassphrase, h.Note, h.JumpHostID); err != nil {
		return PublicHost{}, err
	}
	s.data.Hosts = append(s.data.Hosts, h)
	return h.Public(), nil
}

// UpdateHost 修改主机。只更新 HostUpdate 中非 nil 的字段；校验失败会回滚内存改动。
func (s *Store) UpdateHost(id string, u HostUpdate) (PublicHost, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Hosts {
		if s.data.Hosts[i].ID != id {
			continue
		}
		h := &s.data.Hosts[i]
		prev := *h
		if u.Name != nil && *u.Name != "" {
			h.Name = *u.Name
		}
		if u.Group != nil {
			h.Group = *u.Group
		}
		if u.Address != nil && *u.Address != "" {
			h.Address = *u.Address
		}
		if u.Port != nil && *u.Port > 0 {
			h.Port = *u.Port
		}
		if u.User != nil && *u.User != "" {
			h.User = *u.User
		}
		if u.AuthType != nil && *u.AuthType != "" {
			h.AuthType = *u.AuthType
		}
		if u.KeyPath != nil {
			h.KeyPath = *u.KeyPath
		}
		if u.KeyData != nil {
			h.KeyData = s.encrypt(*u.KeyData)
		}
		if u.Note != nil {
			h.Note = *u.Note
		}
		if u.JumpHostID != nil {
			h.JumpHostID = *u.JumpHostID
		}
		if u.Password != nil {
			h.Password = s.encrypt(*u.Password)
		}
		if u.KeyPassphrase != nil {
			h.KeyPassphrase = s.encrypt(*u.KeyPassphrase)
		}
		if err := s.validateJumpLocked(h); err != nil {
			s.data.Hosts[i] = prev
			return PublicHost{}, err
		}
		if _, err := s.db.Exec(insertHostSQL, h.ID, i, h.Name, h.Group, h.Address, h.Port,
			h.User, h.AuthType, h.Password, h.KeyData, h.KeyPath, h.KeyPassphrase, h.Note, h.JumpHostID); err != nil {
			s.data.Hosts[i] = prev
			return PublicHost{}, err
		}
		return h.Public(), nil
	}
	return PublicHost{}, errors.New("host not found")
}

func (s *Store) validateJumpLocked(h *Host) error {
	if h.JumpHostID == "" {
		return nil
	}
	if h.JumpHostID == h.ID {
		return errors.New("跳板机不能是主机自己")
	}
	byID := make(map[string]*Host, len(s.data.Hosts))
	for i := range s.data.Hosts {
		byID[s.data.Hosts[i].ID] = &s.data.Hosts[i]
	}
	cur, ok := byID[h.JumpHostID]
	if !ok {
		return errors.New("跳板机不存在")
	}
	for i := 0; i < MaxJumpDepth; i++ {
		if cur.ID == h.ID {
			return errors.New("跳板链存在循环引用")
		}
		if cur.JumpHostID == "" {
			return nil
		}
		next, ok := byID[cur.JumpHostID]
		if !ok {
			return errors.New("跳板机不存在")
		}
		cur = next
	}
	if cur.ID == h.ID {
		return errors.New("跳板链存在循环引用")
	}
	return fmt.Errorf("跳板层级超过上限（%d 级）", MaxJumpDepth)
}

// Dir 返回配置目录的绝对路径。
func (s *Store) Dir() string {
	return s.dir
}

// DeleteHost 删除主机。若仍有其它主机以它作为跳板机会被拒绝。
func (s *Store) DeleteHost(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Hosts {
		if s.data.Hosts[i].ID != id {
			continue
		}
		var deps []string
		for j := range s.data.Hosts {
			if j != i && s.data.Hosts[j].JumpHostID == id {
				deps = append(deps, s.data.Hosts[j].Name)
			}
		}
		if len(deps) > 0 {
			return fmt.Errorf("仍有主机以它作为跳板机：%s；请先修改这些主机的跳板设置", strings.Join(deps, "、"))
		}
		if _, err := s.db.Exec(`DELETE FROM hosts WHERE id = ?`, id); err != nil {
			return err
		}
		s.data.Hosts = append(s.data.Hosts[:i], s.data.Hosts[i+1:]...)

		for k := i; k < len(s.data.Hosts); k++ {
			if _, err := s.db.Exec(`UPDATE hosts SET ord = ? WHERE id = ?`, k, s.data.Hosts[k].ID); err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("host not found")
}

var legacyPermExpansion = map[string][]string{
	"hosts.manage": {"hosts.create", "hosts.update", "hosts.delete"},

	"sys.exec":     {"server.exec"},
	"files.read":   {"server.read"},
	"files.write":  {"server.write"},
	"sudo.request": {"perm.sudo"},

	"local.files": {"local.read", "local.write"},
}

// legacyScopeExpansion 把旧版权限键映射并展开为细粒度的冒号规范 scope。
var legacyScopeExpansion = map[string][]string{
	"server.exec":        {"term:open", "tunnel:start", "tunnel:stop", "exec:run"},
	"hosts.manage":       {"hosts:create", "hosts:update", "hosts:delete"},
	"apps.install":       {"apps:install", "apps:link"},
	"apps.uninstall":     {"apps:uninstall", "apps:toggle"},
	"sys.read":           {"prefs:read"},
	"server.read":        {"server:read", "server:stat"},
	"server.write":       {"server:upload", "server:mkdir", "server:rename", "server:copy", "server:move", "server:attrs"},
	"local.read":         {"local:read", "local:list"},
	"local.write":        {"local:write", "local:mkdir", "local:rename"},
	"local.exec":         {"local:exec"},
	"local.hostinfo":     {"local:hostinfo"},
	"hosts.credential":   {"hosts:credential"},
	"perm.sudo":          {"sudo:request", "sudo:forget"},
	"perm.manage":        {"perm:grant", "perm:revoke", "perm:clear"},
	"logs.read":          {"logs:read"},
	"logs.readSensitive": {"logs:readSensitive"},
	"logs.archive":       {"logs:archive", "logs:settings:read", "logs:settings:write", "logs:verbose"},
	"logs.clear":         {"logs:clear"},
	"ui.notify":          {"ui:notify"},
	"ui.settings":        {"ui:settings", "prefs:write"},
	"tunnel.local":       {"tunnel:local"},
	"apps.list":          {"apps:list"},

	// 历史别名直接展开为对应 scope
	"hosts.list":       {"hosts:read"},
	"hosts.test":       {"hosts:test"},
	"hosts.preconnect": {"hosts:preconnect"},
	"hosts.probe":      {"hosts:probe"},
	"hosts.create":     {"hosts:create"},
	"hosts.import":     {"hosts:import"},
	"hosts.update":     {"hosts:update"},
	"hosts.delete":     {"hosts:delete"},
	"term.session":     {"term:open"},
	"files.list":       {"server:read"},
	"files.download":   {"server:download"},
	"files.upload":     {"server:upload"},
	"files.mkdir":      {"server:mkdir"},
	"files.rm":         {"server:delete"},
	"files.rename":     {"server:rename"},
	"files.copy":       {"server:copy"},
	"files.move":       {"server:move"},
	"files.attrs":      {"server:attrs"},
	"tunnel.list":      {"tunnel:list"},
	"tunnel.stop":      {"tunnel:stop"},
	"webproxy.start":   {"webproxy:start"},
	"webproxy.stop":    {"webproxy:stop"},
	"schedule.list":    {"schedule:list"},
	"schedule.add":     {"schedule:create"},
	"schedule.update":  {"schedule:update"},
	"schedule.delete":  {"schedule:delete"},
	"schedule.run":     {"schedule:run"},
	"net.tcp":          {"net:tcp"},
	"net.http":         {"net:http"},
	"apps.validate":    {"apps:validate"},
	"localfs.list":     {"local:list"},
	"localfs.read":     {"local:read"},
	"localfs.write":    {"local:write"},
	"localfs.mkdir":    {"local:mkdir"},
	"localfs.rename":   {"local:rename"},
	"localfs.delete":   {"local:delete"},
	"sudo.request":     {"sudo:request"},
	"sudo.forget":      {"sudo:forget"},
}

func (s *Store) migrateGrantsToScopesLocked() error {
	now := time.Now().Unix()
	for app, perms := range s.data.AppGrants {
		if s.data.AppScopes[app] == nil {
			s.data.AppScopes[app] = map[string]ScopeGrant{}
		}
		for p := range perms {
			scopes := legacyScopeExpansion[p]
			if len(scopes) == 0 {
				if strings.Contains(p, ".") {
					scopes = []string{strings.ReplaceAll(p, ".", ":")}
				} else if strings.Contains(p, ":") {
					scopes = []string{p}
				}
			}
			for _, sc := range scopes {
				if _, ok := s.data.AppScopes[app][sc]; !ok {
					s.data.AppScopes[app][sc] = ScopeGrant{
						Scope:     sc,
						Granted:   now,
						GrantedBy: "migration",
					}
					if _, err := s.db.Exec(`INSERT INTO app_scopes (app_id, scope, granted, granted_by, expires_at)
						VALUES (?, ?, ?, 'migration', 0)
						ON CONFLICT(app_id, scope) DO NOTHING`, app, sc, now); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func (s *Store) migrateGrants() error {
	for app, perms := range s.data.AppGrants {
		for old, news := range legacyPermExpansion {
			at, ok := perms[old]
			if !ok {
				continue
			}
			for _, n := range news {
				if perms[n] == "" {
					perms[n] = at
					if err := s.putGrant(app, n, at); err != nil {
						return err
					}
				}
			}
			delete(perms, old)
			if _, err := s.db.Exec(`DELETE FROM app_grants WHERE app_id = ? AND perm = ?`, app, old); err != nil {
				return err
			}
		}
		if len(perms) == 0 {
			delete(s.data.AppGrants, app)
		}
	}

	return nil
}

func (s *Store) putGrant(app, perm, at string) error {
	_, err := s.db.Exec(`INSERT INTO app_grants (app_id, perm, granted) VALUES (?, ?, ?)
		ON CONFLICT(app_id, perm) DO UPDATE SET granted = excluded.granted`, app, perm, at)
	return err
}

// HasScope 报告某应用是否拥有指定 scope（考虑过期时间）。
func (s *Store) HasScope(appID, scope string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.data.AppScopes[appID]
	if !ok {
		return false
	}
	g, ok := m[scope]
	if !ok {
		return false
	}
	if g.ExpiresAt > 0 && time.Now().Unix() > g.ExpiresAt {
		return false
	}
	return true
}

// AppScopes 返回某应用已获授权的全部有效 scope 列表。
func (s *Store) AppScopes(appID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.data.AppScopes[appID]
	if len(m) == 0 {
		return nil
	}
	now := time.Now().Unix()
	out := make([]string, 0, len(m))
	for sc, g := range m {
		if g.ExpiresAt > 0 && now > g.ExpiresAt {
			continue
		}
		out = append(out, sc)
	}
	sort.Strings(out)
	return out
}

// AllScopes 返回所有应用的授权映射副本。
func (s *Store) AllScopes() map[string]map[string]ScopeGrant {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]map[string]ScopeGrant, len(s.data.AppScopes))
	now := time.Now().Unix()
	for app, m := range s.data.AppScopes {
		sub := make(map[string]ScopeGrant, len(m))
		for k, v := range m {
			if v.ExpiresAt > 0 && now > v.ExpiresAt {
				continue
			}
			sub[k] = v
		}
		out[app] = sub
	}
	return out
}

// GrantScopes 为应用授予指定的 scope 集合（幂等）。
func (s *Store) GrantScopes(appID string, scopes []string, grantedBy string, expiresAt int64) error {
	if appID == "" || len(scopes) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.AppScopes[appID] == nil {
		s.data.AppScopes[appID] = map[string]ScopeGrant{}
	}
	now := time.Now().Unix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO app_scopes (app_id, scope, granted, granted_by, expires_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(app_id, scope) DO UPDATE SET
			granted = excluded.granted, granted_by = excluded.granted_by, expires_at = excluded.expires_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, sc := range scopes {
		if sc == "" {
			continue
		}
		if _, err := stmt.Exec(appID, sc, now, grantedBy, expiresAt); err != nil {
			return err
		}
		s.data.AppScopes[appID][sc] = ScopeGrant{
			Scope:     sc,
			Granted:   now,
			GrantedBy: grantedBy,
			ExpiresAt: expiresAt,
		}
	}
	return tx.Commit()
}

// RevokeScopes 撤销某应用的指定 scope。
func (s *Store) RevokeScopes(appID string, scopes []string) error {
	if appID == "" || len(scopes) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`DELETE FROM app_scopes WHERE app_id = ? AND scope = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, sc := range scopes {
		if _, err := stmt.Exec(appID, sc); err != nil {
			return err
		}
		delete(s.data.AppScopes[appID], sc)
	}
	if len(s.data.AppScopes[appID]) == 0 {
		delete(s.data.AppScopes, appID)
	}
	return tx.Commit()
}

// ClearScopes 清空某应用的全部授权。
func (s *Store) ClearScopes(appID string) error {
	if appID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM app_scopes WHERE app_id = ?`, appID); err != nil {
		return err
	}
	delete(s.data.AppScopes, appID)
	return nil
}

// HasGrant 报告某应用是否已被授予指定权限（兼容旧接口与冒号 scope）。
func (s *Store) HasGrant(appID, perm string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.AppGrants[appID] != nil && s.data.AppGrants[appID][perm] != "" {
		return true
	}
	if m := s.data.AppScopes[appID]; m != nil {
		if g, ok := m[perm]; ok && (g.ExpiresAt == 0 || time.Now().Unix() <= g.ExpiresAt) {
			return true
		}
		colon := strings.ReplaceAll(perm, ".", ":")
		if g, ok := m[colon]; ok && (g.ExpiresAt == 0 || time.Now().Unix() <= g.ExpiresAt) {
			return true
		}
	}
	return false
}

// NormalizeGrants 用 norm 归一化所有已授权权限键（用于别名/旧键升级），并持久化结果。
func (s *Store) NormalizeGrants(norm func(string) string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	nowUnix := time.Now().Unix()
	for app, perms := range s.data.AppGrants {
		for k, at := range perms {
			nk := norm(k)
			if nk != k {
				if _, ok := perms[nk]; !ok {
					perms[nk] = at
					if err := s.putGrant(app, nk, at); err != nil {
						return err
					}
				}
				delete(perms, k)
				if _, err := s.db.Exec(`DELETE FROM app_grants WHERE app_id = ? AND perm = ?`, app, k); err != nil {
					return err
				}
			}
			// 同步到 AppScopes 映射表
			sc := strings.ReplaceAll(nk, ".", ":")
			if s.data.AppScopes[app] == nil {
				s.data.AppScopes[app] = map[string]ScopeGrant{}
			}
			s.data.AppScopes[app][sc] = ScopeGrant{Scope: sc, Granted: nowUnix, GrantedBy: "migration"}
			_, _ = s.db.Exec(`INSERT INTO app_scopes (app_id, scope, granted, granted_by, expires_at)
				VALUES (?, ?, ?, 'migration', 0)
				ON CONFLICT(app_id, scope) DO NOTHING`, app, sc, nowUnix)
		}
		if len(perms) == 0 {
			delete(s.data.AppGrants, app)
		}
	}

	return nil
}

// AppGrants 返回某应用已授权的权限键到授权时间的映射副本。
func (s *Store) AppGrants(appID string) map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string)
	for k, v := range s.data.AppGrants[appID] {
		out[k] = v
	}
	now := time.Now().Unix()
	for sc, g := range s.data.AppScopes[appID] {
		if g.ExpiresAt > 0 && now > g.ExpiresAt {
			continue
		}
		if out[sc] == "" {
			out[sc] = time.Unix(g.Granted, 0).UTC().Format(time.RFC3339)
		}
	}
	return out
}

// AllGrants 返回所有应用的授权映射副本（应用 ID → 权限 → 授权时间）。
func (s *Store) AllGrants() map[string]map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	apps := make(map[string]bool)
	for app := range s.data.AppGrants {
		apps[app] = true
	}
	for app := range s.data.AppScopes {
		apps[app] = true
	}
	out := make(map[string]map[string]string, len(apps))
	now := time.Now().Unix()
	for app := range apps {
		m := make(map[string]string)
		for k, v := range s.data.AppGrants[app] {
			m[k] = v
		}
		for sc, g := range s.data.AppScopes[app] {
			if g.ExpiresAt > 0 && now > g.ExpiresAt {
				continue
			}
			if m[sc] == "" {
				m[sc] = time.Unix(g.Granted, 0).UTC().Format(time.RFC3339)
			}
		}
		out[app] = m
	}
	return out
}

// Grant 为应用授予权限（幂等，同时写入 app_grants 与 app_scopes）。
func (s *Store) Grant(appID string, perms []string) error {
	if appID == "" || len(perms) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.AppScopes[appID] == nil {
		s.data.AppScopes[appID] = map[string]ScopeGrant{}
	}
	prev := s.data.AppGrants[appID]
	snap := make(map[string]string, len(prev))
	for k, v := range prev {
		snap[k] = v
	}
	m := make(map[string]string, len(prev)+len(perms))
	for k, v := range prev {
		m[k] = v
	}
	nowTime := time.Now().UTC()
	nowUnix := nowTime.Unix()
	nowStr := nowTime.Format(time.RFC3339)
	for _, p := range perms {
		if p != "" {
			m[p] = nowStr
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for k, v := range m {
		if _, err := tx.Exec(`INSERT INTO app_grants (app_id, perm, granted) VALUES (?, ?, ?)
			ON CONFLICT(app_id, perm) DO UPDATE SET granted = excluded.granted`, appID, k, v); err != nil {
			return err
		}
		sc := strings.ReplaceAll(k, ".", ":")
		if _, err := tx.Exec(`INSERT INTO app_scopes (app_id, scope, granted, granted_by, expires_at)
			VALUES (?, ?, ?, 'grant', 0)
			ON CONFLICT(app_id, scope) DO UPDATE SET
				granted = excluded.granted, granted_by = excluded.granted_by, expires_at = excluded.expires_at`, appID, sc, nowUnix); err != nil {
			return err
		}
		s.data.AppScopes[appID][sc] = ScopeGrant{Scope: sc, Granted: nowUnix, GrantedBy: "grant", ExpiresAt: 0}
	}
	if err := tx.Commit(); err != nil {
		if len(snap) == 0 {
			delete(s.data.AppGrants, appID)
		} else {
			s.data.AppGrants[appID] = snap
		}
		return err
	}
	if len(m) == 0 {
		delete(s.data.AppGrants, appID)
	} else {
		s.data.AppGrants[appID] = m
	}
	return nil
}

// Revoke 撤销应用的指定权限。
func (s *Store) Revoke(appID string, perms []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.data.AppGrants[appID]
	if len(cur) == 0 && len(s.data.AppScopes[appID]) == 0 {
		return nil
	}
	snap := make(map[string]string, len(cur))
	for k, v := range cur {
		snap[k] = v
	}
	m := make(map[string]string, len(cur))
	for k, v := range cur {
		m[k] = v
	}
	for _, p := range perms {
		delete(m, p)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, p := range perms {
		if _, err := tx.Exec(`DELETE FROM app_grants WHERE app_id = ? AND perm = ?`, appID, p); err != nil {
			return err
		}
		sc := strings.ReplaceAll(p, ".", ":")
		if _, err := tx.Exec(`DELETE FROM app_scopes WHERE app_id = ? AND (scope = ? OR scope = ?)`, appID, p, sc); err != nil {
			return err
		}
		delete(s.data.AppScopes[appID], p)
		delete(s.data.AppScopes[appID], sc)
	}
	if err := tx.Commit(); err != nil {
		s.data.AppGrants[appID] = snap
		return err
	}
	if len(m) == 0 {
		delete(s.data.AppGrants, appID)
	} else {
		s.data.AppGrants[appID] = m
	}
	return nil
}

// ClearGrants 清空某应用的全部授权。
func (s *Store) ClearGrants(appID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM app_grants WHERE app_id = ?`, appID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM app_scopes WHERE app_id = ?`, appID); err != nil {
		return err
	}
	delete(s.data.AppGrants, appID)
	delete(s.data.AppScopes, appID)
	return nil
}

// DisabledApps 返回被禁用的应用 ID 列表。
func (s *Store) DisabledApps() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT app_id FROM app_state WHERE disabled = 1`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			out = append(out, id)
		}
	}
	return out
}

// SetAppDisabled 设置应用的启用/禁用状态并持久化。
func (s *Store) SetAppDisabled(id string, disabled bool) error {
	if id == "" {
		return errors.New("应用 id 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if disabled {
		_, err := s.db.Exec(`INSERT INTO app_state (app_id, disabled) VALUES (?, 1)
			ON CONFLICT(app_id) DO UPDATE SET disabled = 1`, id)
		return err
	}
	_, err := s.db.Exec(`DELETE FROM app_state WHERE app_id = ?`, id)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// AppTokenEpoch 返回某应用当前的「令牌世代」。
// 每次整体撤销都会递增它；令牌携带签发时的世代号，校验时世代不符即视为已撤销。
func (s *Store) AppTokenEpoch(id string) int64 {
	if id == "" {
		return 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var epoch int64
	if err := s.db.QueryRow(`SELECT epoch FROM app_token_epoch WHERE app_id = ?`, id).Scan(&epoch); err != nil {
		return 0
	}
	return epoch
}

// BumpAppTokenEpoch 递增某应用的令牌世代，使其此前签发的全部访问令牌立即失效。
// 返回递增后的世代号。
func (s *Store) BumpAppTokenEpoch(id string) (int64, error) {
	if id == "" {
		return 0, errors.New("应用 id 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`INSERT INTO app_token_epoch (app_id, epoch) VALUES (?, 1)
		ON CONFLICT(app_id) DO UPDATE SET epoch = epoch + 1`, id); err != nil {
		return 0, err
	}
	var epoch int64
	if err := s.db.QueryRow(`SELECT epoch FROM app_token_epoch WHERE app_id = ?`, id).Scan(&epoch); err != nil {
		return 0, err
	}
	return epoch, nil
}

// RefreshRow 是一枚刷新令牌的持久化记录。
// Token 是不透明随机串；JTI 是与之配套的访问令牌 ID，用于审计关联。
type RefreshRow struct {
	Token       string `json:"token"`
	AppID       string `json:"appId"`
	JTI         string `json:"jti"`
	RotFrom     string `json:"rotFrom,omitempty"`
	Exp         int64  `json:"exp"`
	Revoked     bool   `json:"revoked"`
	LastUse     int64  `json:"lastUse"`
	CreatedAt   int64  `json:"createdAt"`
	ExtraScopes string `json:"extraScopes,omitempty"`
}

// SaveRefresh 写入或更新一条刷新令牌记录。
func (s *Store) SaveRefresh(r RefreshRow) error {
	if r.Token == "" {
		return errors.New("刷新令牌不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO app_refresh (token, app_id, jti, rot_from, exp, revoked, last_use, created_at, extra_scopes)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET
			app_id = excluded.app_id, jti = excluded.jti, rot_from = excluded.rot_from,
			exp = excluded.exp, revoked = excluded.revoked, last_use = excluded.last_use,
			extra_scopes = excluded.extra_scopes`,
		r.Token, r.AppID, r.JTI, r.RotFrom, r.Exp, boolToInt(r.Revoked), r.LastUse, r.CreatedAt, r.ExtraScopes)
	return err
}

// GetRefresh 取一条刷新令牌记录；不存在时 ok 为 false。
func (s *Store) GetRefresh(token string) (RefreshRow, bool) {
	if token == "" {
		return RefreshRow{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var (
		r       RefreshRow
		revoked int
	)
	err := s.db.QueryRow(`SELECT token, app_id, jti, rot_from, exp, revoked, last_use, created_at, COALESCE(extra_scopes, '')
		FROM app_refresh WHERE token = ?`, token).
		Scan(&r.Token, &r.AppID, &r.JTI, &r.RotFrom, &r.Exp, &revoked, &r.LastUse, &r.CreatedAt, &r.ExtraScopes)
	if err != nil {
		return RefreshRow{}, false
	}
	r.Revoked = revoked != 0
	return r, true
}

// RevokeRefreshToken 把单枚刷新令牌置为已吊销。
func (s *Store) RevokeRefreshToken(token string) error {
	if token == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE app_refresh SET revoked = 1 WHERE token = ?`, token)
	return err
}

// RotateRefresh 把旧刷新令牌置为「已轮换」并写入新记录。
// 两者在同一事务里完成，避免中途失败留下「旧令牌仍有效、新令牌不存在」的窗口。
func (s *Store) RotateRefresh(old string, nr RefreshRow) error {
	if old == "" || nr.Token == "" {
		return errors.New("轮换刷新令牌时新旧令牌都不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE app_refresh SET revoked = 1 WHERE token = ?`, old); err != nil {
		tx.Rollback()
		return err
	}
	if _, err := tx.Exec(`INSERT INTO app_refresh (token, app_id, jti, rot_from, exp, revoked, last_use, created_at, extra_scopes)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET rot_from = excluded.rot_from, exp = excluded.exp, last_use = excluded.last_use, extra_scopes = excluded.extra_scopes`,
		nr.Token, nr.AppID, nr.JTI, nr.RotFrom, nr.Exp, nr.LastUse, nr.CreatedAt, nr.ExtraScopes); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// RevokeRefreshForApp 作废某应用的全部刷新令牌（整体撤销时用）。
func (s *Store) RevokeRefreshForApp(id string) error {
	if id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE app_refresh SET revoked = 1 WHERE app_id = ?`, id)
	return err
}

// PurgeExpiredRefresh 删除已过期的刷新令牌行，返回删除条数。
func (s *Store) PurgeExpiredRefresh(now int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM app_refresh WHERE exp < ?`, now)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// Prefs 返回全部界面偏好键值。
func (s *Store) Prefs() (map[string]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, errNoDB
	}
	rows, err := s.db.Query(`SELECT key, value FROM prefs`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string, 32)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			out[k] = v
		}
	}
	return out, rows.Err()
}

// ErrPrefInvalid 表示偏好键名或值不合法（键为空或过长、值超过大小上限）。
var ErrPrefInvalid = errors.New("偏好键名或值不合法")

// SetPrefs 写入一批界面偏好（存在即覆盖）。会先校验键名与值长度。
func (s *Store) SetPrefs(in map[string]string) error {
	if len(in) == 0 {
		return nil
	}
	for k, v := range in {
		if k == "" || len(k) > 128 {
			return fmt.Errorf("%w：键为空或过长", ErrPrefInvalid)
		}
		if len(v) > prefValueMax {
			return fmt.Errorf("%w：偏好 %q 的值超过 %d 字节", ErrPrefInvalid, k, prefValueMax)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO prefs (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for k, v := range in {
		if _, err := stmt.Exec(k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AppPrefs 返回某应用专属的私有偏好设置，按应用身份严格隔离。
func (s *Store) AppPrefs(appID string) (map[string]string, error) {
	if appID == "" {
		return nil, errors.New("应用 id 不能为空")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, errNoDB
	}
	rows, err := s.db.Query(`SELECT key, value FROM app_prefs WHERE app_id = ?`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			out[k] = v
		}
	}
	return out, rows.Err()
}

// SetAppPrefs 批量设置某应用专属的私有偏好（upsert）。
func (s *Store) SetAppPrefs(appID string, in map[string]string) error {
	if appID == "" {
		return errors.New("应用 id 不能为空")
	}
	if len(in) == 0 {
		return nil
	}
	for k, v := range in {
		if k == "" || len(k) > 128 {
			return fmt.Errorf("%w：键为空或过长", ErrPrefInvalid)
		}
		if len(v) > prefValueMax {
			return fmt.Errorf("%w：偏好 %q 的值超过 %d 字节", ErrPrefInvalid, k, prefValueMax)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO app_prefs (app_id, key, value) VALUES (?, ?, ?)
		ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for k, v := range in {
		if _, err := stmt.Exec(appID, k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteAppPref 删除某应用的某条私有偏好。
func (s *Store) DeleteAppPref(appID, key string) error {
	if appID == "" || key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err := s.db.Exec(`DELETE FROM app_prefs WHERE app_id = ? AND key = ?`, appID, key)
	return err
}

const prefValueMax = 512 << 10

// MetaGet 读取 meta 表中的原始字节值，第二个返回值表示是否存在。
func (s *Store) MetaGet(key string) ([]byte, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, false, errNoDB
	}
	return metaGet(s.db, key)
}

// MetaSet 写入 meta 表中的原始字节值（存在即覆盖）。
func (s *Store) MetaSet(key string, val []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	return metaSet(s.db, key, val)
}

// Schedule 是一条定时任务：在指定主机上按 cron 表达式运行某应用的命令。
type Schedule struct {
	ID        string   `json:"id"`
	AppID     string   `json:"app"`
	Host      string   `json:"host"`
	Name      string   `json:"name"`
	Argv      []string `json:"argv"`
	Cwd       string   `json:"cwd,omitempty"`
	Cron      string   `json:"cron"`
	Enabled   bool     `json:"enabled"`
	CreatedAt int64    `json:"createdAt"`
	LastRun   int64    `json:"lastRun"`
	LastJob   string   `json:"lastJob,omitempty"`
	LastErr   string   `json:"lastErr,omitempty"`
}

const scheduleCols = `id, app_id, host, name, argv, cwd, cron, enabled, created_at, last_run, last_job, last_err`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSchedule(row rowScanner) (Schedule, error) {
	var sc Schedule
	var argv string
	var enabled int
	if err := row.Scan(&sc.ID, &sc.AppID, &sc.Host, &sc.Name, &argv, &sc.Cwd, &sc.Cron, &enabled, &sc.CreatedAt, &sc.LastRun, &sc.LastJob, &sc.LastErr); err != nil {
		return Schedule{}, err
	}
	_ = json.Unmarshal([]byte(argv), &sc.Argv)
	sc.Enabled = enabled == 1
	return sc, nil
}

// Schedules 返回定时任务列表。appID 非空时只返回该应用的任务。
func (s *Store) Schedules(appID string) ([]Schedule, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, errNoDB
	}
	q := `SELECT ` + scheduleCols + ` FROM schedules`
	var args []any
	if appID != "" {
		q += ` WHERE app_id = ?`
		args = append(args, appID)
	}
	q += ` ORDER BY created_at, id`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Schedule, 0, 8)
	for rows.Next() {
		sc, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// ScheduleByID 按 id 查询定时任务，第二个返回值表示是否存在。
func (s *Store) ScheduleByID(id string) (Schedule, bool, error) {
	if id == "" {
		return Schedule{}, false, nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return Schedule{}, false, errNoDB
	}
	sc, err := scanSchedule(s.db.QueryRow(`SELECT `+scheduleCols+` FROM schedules WHERE id = ?`, id))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Schedule{}, false, nil
		}
		return Schedule{}, false, err
	}
	return sc, true, nil
}

// SaveSchedule 新建或更新定时任务（按 ID 覆盖）。id/app/host/cron/argv 为必填。
func (s *Store) SaveSchedule(sc Schedule) error {
	if sc.ID == "" || sc.AppID == "" || sc.Host == "" || sc.Cron == "" || len(sc.Argv) == 0 {
		return errors.New("定时任务缺少 id / app / host / cron / argv")
	}
	argv, err := json.Marshal(sc.Argv)
	if err != nil {
		return err
	}
	enabled := 0
	if sc.Enabled {
		enabled = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err = s.db.Exec(`INSERT INTO schedules (id, app_id, host, name, argv, cwd, cron, enabled, created_at, last_run, last_job, last_err)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET host = excluded.host, name = excluded.name, argv = excluded.argv, cwd = excluded.cwd,
		cron = excluded.cron, enabled = excluded.enabled`,
		sc.ID, sc.AppID, sc.Host, sc.Name, string(argv), sc.Cwd, sc.Cron, enabled, sc.CreatedAt, sc.LastRun, sc.LastJob, sc.LastErr)
	return err
}

// MarkScheduleRun 记录一次定时任务的运行结果（时间、任务 ID、错误信息）。
func (s *Store) MarkScheduleRun(id string, at int64, jobID, errText string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err := s.db.Exec(`UPDATE schedules SET last_run = ?, last_job = ?, last_err = ? WHERE id = ?`, at, jobID, errText, id)
	return err
}

// DeleteSchedule 删除定时任务。
func (s *Store) DeleteSchedule(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err := s.db.Exec(`DELETE FROM schedules WHERE id = ?`, id)
	return err
}

// SecretGet 读取某应用的机密并解密，第二个返回值表示是否存在且非空。
func (s *Store) SecretGet(appID, key string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return "", false
	}
	var enc string
	if err := s.db.QueryRow(`SELECT value FROM app_secrets WHERE app_id = ? AND key = ?`, appID, key).Scan(&enc); err != nil {
		return "", false
	}
	v := s.decrypt(enc)
	return v, v != ""
}

// SecretSet 加密保存某应用的机密（存在即覆盖）。
func (s *Store) SecretSet(appID, key, value string) error {
	enc := s.encrypt(value)
	if enc == "" {
		return errors.New("加密失败")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err := s.db.Exec(`INSERT INTO app_secrets (app_id, key, value, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		appID, key, enc, time.Now().Unix())
	return err
}

// SecretDelete 删除某应用的一个机密。
func (s *Store) SecretDelete(appID, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return errNoDB
	}
	_, err := s.db.Exec(`DELETE FROM app_secrets WHERE app_id = ? AND key = ?`, appID, key)
	return err
}

// SecretKeys 返回某应用的全部机密键及其更新时间（不含值）。
func (s *Store) SecretKeys(appID string) ([]SecretMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, errNoDB
	}
	rows, err := s.db.Query(`SELECT key, updated_at FROM app_secrets WHERE app_id = ? ORDER BY key`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SecretMeta, 0, 8)
	for rows.Next() {
		var m SecretMeta
		if err := rows.Scan(&m.Key, &m.UpdatedAt); err == nil {
			out = append(out, m)
		}
	}
	return out, rows.Err()
}

// SecretMeta 描述一个应用机密的元信息。
type SecretMeta struct {
	Key       string `json:"key"`
	UpdatedAt int64  `json:"updatedAt"`
}


