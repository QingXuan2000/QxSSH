package httpapi

// 本文件实现 QxSSH 作为「轻量 IdP」的令牌层：
//
//  1. 签名密钥的首次生成、持久化、轮换与 JWKS 发布（§7.1/§7.3）；
//  2. RS256 签名 JWT 的签发与验签，scope 自包含、aud 限定受众（§7.2）；
//  3. 刷新令牌的轮换与「重用即泄露」检测（§7.5）；
//  4. 以「应用令牌世代（epoch）」实现整体撤销（§9.1）。
//
// 刻意不引入第三方 JWT 库：令牌只有 RS256 一种算法、claims 由我们自己定义，
// 用标准库实现既足够又便于审计。IdP 只签令牌、不做业务鉴权——
// 具体 API 是否放行由 sysDispatch 按 scope 判定。

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"qxssh/internal/config"
)

const (
	// 令牌的签发者/受众。aud 让「给 A 签的令牌」不能被挪用到另一类服务上。
	idpIssuer   = "qxssh"
	idpAudience = "qxssh"

	// 访问令牌刻意取短：它是自包含的，泄露后无需查库即可验签，
	// 因此有效期越短，可滥用的窗口越小。
	accessTTL = 30 * time.Minute

	// 刷新令牌的绝对上限与不活跃上限（§7.5）。
	refreshTTL     = 30 * 24 * time.Hour
	refreshIdleTTL = 7 * 24 * time.Hour

	// 时钟偏差容忍：校验 iat/exp 时允许 NTP 未同步造成的轻微偏移。
	clockSkew = 60 * time.Second
)

// idpClaims 是应用访问令牌的载荷。
type idpClaims struct {
	Issuer    string   `json:"iss"`
	Subject   string   `json:"sub"`
	Audience  []string `json:"aud"`
	Scope     []string `json:"scope"`
	Epoch     int64    `json:"epo"`
	ExpiresAt int64    `json:"exp"`
	IssuedAt  int64    `json:"iat"`
	ID        string   `json:"jti"`
}

// idpKey 是一把签名密钥及其标识。
type idpKey struct {
	kid string
	key *rsa.PrivateKey
}

// idpKeys 持有「当前签名密钥」与「已轮换、仅用于验签」的历史公钥。
type idpKeys struct {
	mu      sync.RWMutex
	current *idpKey
	byKid   map[string]*rsa.PublicKey
}

func newIDPKeys(current *idpKey, extra map[string]*rsa.PublicKey) *idpKeys {
	byKid := make(map[string]*rsa.PublicKey, len(extra)+1)
	for kid, pub := range extra {
		byKid[kid] = pub
	}
	if current != nil {
		byKid[current.kid] = &current.key.PublicKey
	}
	return &idpKeys{current: current, byKid: byKid}
}

// sign 用当前密钥签发一枚 JWT。
func (ks *idpKeys) sign(c idpClaims) (string, error) {
	ks.mu.RLock()
	k := ks.current
	ks.mu.RUnlock()
	if k == nil {
		return "", errors.New("idp: 签名密钥不可用")
	}
	return signClaims(c, k)
}

// publicKey 按 kid 取公钥；轮换后仍保留旧公钥，使历史令牌在轮换后一段时间内可验签。
func (ks *idpKeys) publicKey(kid string) (*rsa.PublicKey, bool) {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	pub, ok := ks.byKid[kid]
	return pub, ok
}

// rotate 生成新密钥并归档旧私钥；旧公钥保留在验签集合里。
// 必须「先归档、再覆盖」：顺序反了会把还没留档的旧私钥直接冲掉。
func (ks *idpKeys) rotate(dir string) error {
	if ks.current != nil {
		if err := os.MkdirAll(filepath.Join(dir, idpArchiveDir), 0o700); err != nil {
			return fmt.Errorf("创建密钥归档目录失败: %w", err)
		}
		old := idpKeyPath(dir, idpPrivateFile)
		arc := filepath.Join(dir, idpArchiveDir, "private-"+ks.current.kid+".pem")
		if err := os.Rename(old, arc); err != nil {
			return fmt.Errorf("归档旧签名私钥失败: %w", err)
		}
	}

	next, err := createIDPKey(dir, "")
	if err != nil {
		return err
	}
	ks.mu.Lock()
	if ks.current != nil {
		if _, dup := ks.byKid[ks.current.kid]; !dup {
			ks.byKid[ks.current.kid] = &ks.current.key.PublicKey
		}
	}
	ks.current = next
	ks.byKid[next.kid] = &next.key.PublicKey
	ks.mu.Unlock()
	return nil
}

// jwks 是发布给外部验签方的公钥集合。
type jwks struct {
	Keys []jwksKey `json:"keys"`
}

type jwksKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS 返回当前可用的全部公钥（含已轮换的历史密钥）。
func (ks *idpKeys) JWKS() jwks {
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	doc := jwks{Keys: make([]jwksKey, 0, len(ks.byKid))}
	for kid, pub := range ks.byKid {
		doc.Keys = append(doc.Keys, jwksKey{
			Kty: "RSA",
			Kid: kid,
			Use: "sig",
			Alg: "RS256",
			N:   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		})
	}
	sort.Slice(doc.Keys, func(i, j int) bool { return doc.Keys[i].Kid < doc.Keys[j].Kid })
	return doc
}

const (
	idpKeyDir      = "keys"
	idpKidFile     = "kid"
	idpPrivateFile = "private.pem"
	idpPublicFile  = "public.pem"
	idpArchiveDir  = "archive"
)

// kidOf 按 RFC 7638 的思路取公钥 DER 的 SHA-256 再 base64url 编码，作为密钥标识。
// 它由公钥唯一决定，因此kid 文件与私钥不匹配时能立刻发现。
func kidOf(pub *rsa.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(der)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func idpKeyPath(dir, name string) string { return filepath.Join(dir, name) }

// loadIDPKeys 读取配置目录下的签名密钥；不存在则生成一对全新的 RSA-2048。
func loadIDPKeys(configDir string) (*idpKeys, error) {
	dir := filepath.Join(configDir, idpKeyDir)
	if err := os.MkdirAll(filepath.Join(dir, idpArchiveDir), 0o700); err != nil {
		return nil, fmt.Errorf("创建密钥目录失败: %w", err)
	}

	kidBytes, err := os.ReadFile(idpKeyPath(dir, idpKidFile))
	switch {
	case err == nil:
		current, err := loadIDPKey(dir, strings.TrimSpace(string(kidBytes)))
		if err != nil {
			return nil, err
		}
		return newIDPKeys(current, loadArchivedPublicKeys(dir)), nil
	case errors.Is(err, os.ErrNotExist):
		current, err := createIDPKey(dir, "")
		if err != nil {
			return nil, err
		}
		return newIDPKeys(current, nil), nil
	default:
		return nil, fmt.Errorf("读取密钥标识失败: %w", err)
	}
}

// RotateIDPKeys 在配置目录里生成一把新的签名密钥并归档旧密钥，供命令行显式轮换。
// 旧私钥保留在 archive/ 下只用于验签，不会被再次用于签名。
func RotateIDPKeys(configDir string) error {
	dir := filepath.Join(configDir, idpKeyDir)
	if err := os.MkdirAll(filepath.Join(dir, idpArchiveDir), 0o700); err != nil {
		return fmt.Errorf("创建密钥目录失败: %w", err)
	}
	ks := &idpKeys{current: nil, byKid: map[string]*rsa.PublicKey{}}
	kidBytes, err := os.ReadFile(idpKeyPath(dir, idpKidFile))
	if err != nil {
		return fmt.Errorf("读取密钥标识失败: %w", err)
	}
	current, err := loadIDPKey(dir, strings.TrimSpace(string(kidBytes)))
	if err != nil {
		return err
	}
	ks.current = current
	ks.byKid[current.kid] = &current.key.PublicKey
	for kid, pub := range loadArchivedPublicKeys(dir) {
		ks.byKid[kid] = pub
	}
	return ks.rotate(dir)
}

func loadIDPKey(dir, kid string) (*idpKey, error) {
	if kid == "" {
		return nil, errors.New("idp: 密钥目录缺少 kid 记录")
	}
	der, err := readPEMFile(idpKeyPath(dir, idpPrivateFile))
	if err != nil {
		return nil, fmt.Errorf("读取签名私钥失败: %w", err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("解析签名私钥失败: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("idp: 签名私钥不是 RSA 密钥")
	}
	if got := kidOf(&key.PublicKey); got != kid {
		return nil, fmt.Errorf("idp: kid 记录与私钥不一致（记录 %q，实际 %q）", kid, got)
	}
	return &idpKey{kid: kid, key: key}, nil
}

// loadArchivedPublicKeys 读出已轮换的历史公钥。
// 单个损坏的归档密钥只跳过、不致命：它签发的令牌自然已过期，不应拖垮启动。
func loadArchivedPublicKeys(dir string) map[string]*rsa.PublicKey {
	out := map[string]*rsa.PublicKey{}
	entries, err := os.ReadDir(filepath.Join(dir, idpArchiveDir))
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "private-") || !strings.HasSuffix(name, ".pem") {
			continue
		}
		der, err := readPEMFile(filepath.Join(dir, idpArchiveDir, name))
		if err != nil {
			continue
		}
		parsed, err := x509.ParsePKCS8PrivateKey(der)
		if err != nil {
			continue
		}
		priv, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			continue
		}
		kid := strings.TrimSuffix(strings.TrimPrefix(name, "private-"), ".pem")
		if kid == "" {
			continue
		}
		out[kid] = &priv.PublicKey
	}
	return out
}

func createIDPKey(dir, kid string) (*idpKey, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("生成 RSA-2048 签名密钥失败: %w", err)
	}
	if kid == "" {
		kid = kidOf(&key.PublicKey)
	}
	if kid == "" {
		return nil, errors.New("idp: 无法计算公钥标识")
	}

	privDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("编码签名私钥失败: %w", err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("编码签名公钥失败: %w", err)
	}

	// 私钥先写临时文件再改名，避免读到写了一半的 PEM。
	// 权限 0600：Windows 上 Go 只能控制只读位，这一点在文档中说明。
	privPath := idpKeyPath(dir, idpPrivateFile)
	tmpPath := privPath + ".tmp"
	if err := os.WriteFile(tmpPath, pemEncode(idpPrivateType, privDER), 0o600); err != nil {
		return nil, fmt.Errorf("写入签名私钥失败: %w", err)
	}
	if err := os.Rename(tmpPath, privPath); err != nil {
		return nil, fmt.Errorf("落盘签名私钥失败: %w", err)
	}
	if err := os.WriteFile(idpKeyPath(dir, idpKidFile), []byte(kid), 0o600); err != nil {
		return nil, fmt.Errorf("写入密钥标识失败: %w", err)
	}
	if err := os.WriteFile(idpKeyPath(dir, idpPublicFile), pemEncode(idpPublicType, pubDER), 0o644); err != nil {
		return nil, fmt.Errorf("写入签名公钥失败: %w", err)
	}
	return &idpKey{kid: kid, key: key}, nil
}

const (
	idpPrivateType = "PRIVATE KEY"
	idpPublicType  = "PUBLIC KEY"
)

func pemEncode(typ string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der})
}

func readPEMFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s 不是合法的 PEM 文件", path)
	}
	return block.Bytes, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// signClaims 用 RS256 对 claims 签名，返回紧凑序列化的 JWT。
func signClaims(c idpClaims, key *idpKey) (string, error) {
	header := map[string]string{"alg": "RS256", "typ": "JWT", "kid": key.kid}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := b64url(hb) + "." + b64url(cb)
	sum := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("签名应用令牌失败: %w", err)
	}
	return signingInput + "." + b64url(sig), nil
}

var (
	errIDPFormat    = errors.New("令牌格式非法")
	errIDPAlgorithm = errors.New("令牌算法不受支持")
	errIDPKey       = errors.New("令牌签名密钥未知")
	errIDPParse     = errors.New("令牌载荷无法解析")
	errIDPIssuer    = errors.New("令牌签发者非法")
	errIDPAudience  = errors.New("令牌受众非法")
	errIDPExpired   = errors.New("令牌已过期")
	errIDPNotYet    = errors.New("令牌尚未生效")
	errIDPIdentity  = errors.New("令牌主体非法")
)

// verify 只做「密码学校验 + 声明校验」，不做应用层判定。
// 令牌的撤销（jti 黑名单、应用世代）由调用方复核，因为它们依赖运行期状态。
func (ks *idpKeys) verify(tok string, now time.Time) (*idpClaims, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		return nil, errIDPFormat
	}

	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errIDPFormat
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hb, &header); err != nil {
		return nil, errIDPParse
	}
	if header.Alg != "RS256" || header.Kid == "" {
		return nil, errIDPAlgorithm
	}
	if !strings.EqualFold(header.Typ, "JWT") {
		return nil, errIDPAlgorithm
	}

	pub, ok := ks.publicKey(header.Kid)
	if !ok {
		return nil, errIDPKey
	}
	cb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errIDPFormat
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) == 0 {
		return nil, errIDPFormat
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, fmt.Errorf("令牌签名校验失败: %w", err)
	}

	var c idpClaims
	if err := json.Unmarshal(cb, &c); err != nil {
		return nil, errIDPParse
	}
	if c.ID == "" || c.Subject == "" {
		return nil, errIDPIdentity
	}
	if c.Issuer != idpIssuer {
		return nil, errIDPIssuer
	}
	if !audienceContains(c.Audience, idpAudience) {
		return nil, errIDPAudience
	}
	if now.After(time.Unix(c.ExpiresAt, 0).Add(clockSkew)) {
		return nil, errIDPExpired
	}
	if now.Add(clockSkew).Before(time.Unix(c.IssuedAt, 0)) {
		return nil, errIDPNotYet
	}
	return &c, nil
}

func audienceContains(aud []string, want string) bool {
	for _, a := range aud {
		if a == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 网关侧的会话解析与令牌生命周期
// ---------------------------------------------------------------------------

// sessionApp 返回令牌对应的应用 id；宿主不透明口令与已签发的应用 JWT 都能识别。
// 两者之外一律视为未认证。
func (a *Gateway) sessionApp(tok string) string {
	if c := a.sessionClaims(tok); c != nil {
		return c.Subject
	}
	return ""
}

// sessionClaims 解析并校验请求携带的会话凭据。
//
// 宿主页拿到的 hostTok 是内存中的不透明口令：不落盘、不过期、不参与轮换，
// 只在进程内有效；应用拿到的则是本文件签发的 JWT。
func (a *Gateway) sessionClaims(tok string) *idpClaims {
	if tok == "" {
		return nil
	}
	if subtle.ConstantTimeCompare([]byte(tok), []byte(a.hostTok)) == 1 {
		return a.hostClaims
	}
	c, err := a.idp.verify(tok, time.Now())
	if err != nil {
		a.log.Debug("session token rejected", "error", err.Error())
		return nil
	}
	if !a.idpSubjectAllowed(c.Subject) {
		return nil
	}
	if !a.epochCurrent(c) {
		a.log.Info("app token rejected: stale epoch", "app", c.Subject, "epoch", c.Epoch)
		return nil
	}
	if a.deniedIDPJTI(c.ID) {
		a.log.Info("app token rejected: jti denied", "app", c.Subject)
		return nil
	}
	return c
}

// idpSubjectAllowed 确认令牌主体是一个仍存在的应用（或宿主/内置应用）。
func (a *Gateway) idpSubjectAllowed(sub string) bool {
	if sub == hostApp || systemAppIDs[sub] {
		return true
	}
	if !appIDRe.MatchString(sub) {
		return false
	}
	return a.appExists(sub)
}

// epochCurrent 复核令牌的「应用世代」：世代号在整体撤销时递增，
// 旧令牌即使没过期也会在此被拒。
func (a *Gateway) epochCurrent(c *idpClaims) bool {
	if c.Subject == hostApp {
		return true
	}
	return a.store.AppTokenEpoch(c.Subject) == c.Epoch
}

// tokenAllows 判定本次调用是否被令牌放行。
// 宿主不透明口令走原有旁路（permAllowed）；应用 JWT 只看 scope——
// 授权表只在签发时读一次，运行期不再查库。
func (a *Gateway) tokenAllows(app, need string, c *idpClaims) bool {
	if c == nil {
		return a.permAllowed(app, need)
	}
	for _, s := range c.Scope {
		if s == need {
			return true
		}
	}
	return false
}

// appScope 把某应用「当前实际拥有的权限」折算成令牌 scope。
// 结果必须与 permAllowed 的判定完全一致：宿主/内置应用给全量，
// 其余给「默认权限 + 已授权权限」，保证换成令牌后授权结论不变。
func (a *Gateway) appScope(app string) []string {
	if app == hostApp || systemAppIDs[app] {
		return permIDs()
	}
	seen := make(map[string]bool, 8)
	out := make([]string, 0, 8)
	add := func(p string) {
		norm := PermNormalize(p)
		if norm == "" || seen[norm] {
			return
		}
		seen[norm] = true
		out = append(out, norm)
	}
	for _, p := range permDefaultIDs() {
		add(p)
	}
	for _, sc := range a.store.AppScopes(app) {
		add(sc)
	}
	for p := range a.store.AppGrants(app) {
		add(p)
	}
	sort.Strings(out)
	return out
}

// appSession 是一对「访问令牌 + 刷新令牌」的内部表示。
type appSession struct {
	App        string
	AccessJWT  string
	AccessJTI  string
	AccessExp  int64
	Scope      []string
	RefreshTok string
	RefreshExp int64
}

func (s *appSession) mintResp() sessionMintResp {
	return sessionMintResp{
		Token:            s.AccessJWT,
		TokenType:        "Bearer",
		ExpiresIn:        int(time.Until(time.Unix(s.AccessExp, 0)).Round(time.Second).Seconds()),
		Scope:            s.Scope,
		RefreshToken:     s.RefreshTok,
		RefreshExpiresIn: int(time.Until(time.Unix(s.RefreshExp, 0)).Round(time.Second).Seconds()),
	}
}

// issueAppSession 为某应用签发一对令牌。
//
// 访问令牌是自包含的 RS256 JWT：scope 由授权表在签发时折算，加上宿主为当前会话指定的 extraScopes，
// 校验方无需再查库；刷新令牌是落盘的不透明随机串，用于轮换。
func (a *Gateway) issueAppSession(app string, extraScopes ...string) (*appSession, error) {
	now := time.Now()
	accessJTI := randTok()
	scope := a.appScope(app)
	var validExtra []string
	if len(extraScopes) > 0 {
		seen := make(map[string]bool, len(scope)+len(extraScopes))
		for _, s := range scope {
			seen[s] = true
		}
		for _, s := range extraScopes {
			norm := PermNormalize(strings.TrimSpace(s))
			if norm != "" && permKnown(norm) && !seen[norm] {
				seen[norm] = true
				scope = append(scope, norm)
				validExtra = append(validExtra, norm)
			}
		}
		sort.Strings(scope)
	}
	claims := idpClaims{
		Issuer:    idpIssuer,
		Subject:   app,
		Audience:  []string{idpAudience},
		Scope:     scope,
		Epoch:     a.store.AppTokenEpoch(app),
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(accessTTL).Unix(),
		ID:        accessJTI,
	}
	tok, err := a.idp.sign(claims)
	if err != nil {
		return nil, err
	}
	sess := &appSession{
		App:        app,
		AccessJWT:  tok,
		AccessJTI:  accessJTI,
		AccessExp:  claims.ExpiresAt,
		Scope:      claims.Scope,
		RefreshTok: randTok(),
		RefreshExp: now.Add(refreshTTL).Unix(),
	}
	if err := a.store.SaveRefresh(config.RefreshRow{
		Token: sess.RefreshTok, AppID: app, JTI: accessJTI,
		Exp: sess.RefreshExp, LastUse: now.Unix(), CreatedAt: now.Unix(),
		ExtraScopes: strings.Join(validExtra, ","),
	}); err != nil {
		return nil, err
	}
	return sess, nil
}

// denyIDPJTI 报告某访问令牌 ID 是否已被吊销。
func (a *Gateway) deniedIDPJTI(jti string) bool {
	a.denyMu.RLock()
	_, ok := a.deny[jti]
	a.denyMu.RUnlock()
	return ok
}

// revokeIDPJTI 把单枚访问令牌加入吊销名单（到 exp 后自然不再出现）。
func (a *Gateway) revokeIDPJTI(jti string, exp int64) {
	if jti == "" {
		return
	}
	a.denyMu.Lock()
	a.deny[jti] = exp
	a.denyMu.Unlock()
}

// pruneIDPDeny 清掉已过期的吊销项，避免名单无限增长。
func (a *Gateway) pruneIDPDeny(now int64) {
	a.denyMu.Lock()
	for jti, exp := range a.deny {
		if exp <= now {
			delete(a.deny, jti)
		}
	}
	a.denyMu.Unlock()
}

// invalidateAppTokens 递增应用令牌世代（旧访问 JWT 立即失效）并作废其全部刷新令牌。
// 不需要保存任何令牌内容。
func (a *Gateway) invalidateAppTokens(app string) {
	if _, err := a.store.BumpAppTokenEpoch(app); err != nil {
		a.log.Warn("bump app token epoch failed", "app", app, "error", err.Error())
	}
	if err := a.store.RevokeRefreshForApp(app); err != nil {
		a.log.Warn("revoke app refresh tokens failed", "app", app, "error", err.Error())
	}
}

// revokeAppTokens 在 invalidateAppTokens 的基础上补一条审计记录。
func (a *Gateway) revokeAppTokens(app, reason string) {
	a.invalidateAppTokens(app)
	a.log.Info("app tokens revoked", "app", app, "reason", reason)
	a.audit.record(auditEntry{
		AppID:  app,
		Type:   auditSessionRevoke,
		Target: "app/" + app,
		Detail: reason,
		Result: "ok",
	})
}

// revokeToken 吊销单枚令牌：访问 JWT 进 jti 名单，刷新令牌直接置为已吊销。
func (a *Gateway) revokeToken(token string) {
	if token == "" {
		return
	}
	if c, err := a.idp.verify(token, time.Now()); err == nil && c != nil {
		a.revokeIDPJTI(c.ID, c.ExpiresAt)
		a.audit.record(auditEntry{
			AppID:  c.Subject,
			Type:   auditSessionRevoke,
			Target: "token",
			Result: "ok",
		})
		return
	}
	if _, ok := a.store.GetRefresh(token); ok {
		if err := a.store.RevokeRefreshToken(token); err != nil {
			a.log.Warn("revoke refresh token failed", "error", err.Error())
		}
	}
}

// handleJWKS 发布签名公钥集合，供未来的外部客户端验签（§7.3）。
// 它是纯公钥、无敏感信息，因此不需要会话；CORS 头由 withCORS 统一处理。
func (a *Gateway) handleJWKS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("仅支持 GET/HEAD"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, a.idp.JWKS())
}

// handleSessionMint 由宿主壳调用，为指定应用签发一对令牌。
func (a *Gateway) handleSessionMint(w http.ResponseWriter, r *http.Request) {
	if a.sessionApp(sessionHeaderToken(r)) != hostApp {
		writeErr(w, http.StatusForbidden, errors.New("只有宿主可以创建应用会话"))
		return
	}
	var req sessionMintReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !a.appExists(req.App) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("应用不存在：%s", req.App))
		return
	}
	if a.appState.isDisabled(req.App) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("应用已被禁用：%s", req.App))
		return
	}
	sess, err := a.issueAppSession(req.App, req.ExtraScopes...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.audit.record(auditEntry{
		AppID:  req.App,
		HostID: permReqHost(req.Host),
		Type:   auditSessionMint,
		Target: "session/mint",
		Result: "ok",
	})
	writeJSON(w, sess.mintResp())
}

// handleSessionRefresh 轮换刷新令牌并换发访问令牌（§7.5）。
//
// 重复使用「已经轮换掉」的旧刷新令牌是明确的泄露信号：
// 此时直接整体撤销该应用的全部令牌。
func (a *Gateway) handleSessionRefresh(w http.ResponseWriter, r *http.Request) {
	tok := sessionHeaderToken(r)
	caller := a.sessionApp(tok)
	var req struct {
		RefreshToken string `json:"refreshToken"`
		Host         string `json:"host"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	now := time.Now().Unix()
	a.pruneIDPDeny(now)

	row, ok := a.store.GetRefresh(req.RefreshToken)
	switch {
	case !ok:
		writeErr(w, http.StatusUnauthorized, errors.New("刷新令牌不存在"))
		return
	case caller != "" && caller != hostApp && caller != row.AppID:
		writeErr(w, http.StatusForbidden, errors.New("无权使用其他应用的刷新令牌"))
		return
	case a.appState.isDisabled(row.AppID):
		a.revokeAppTokens(row.AppID, "app_disabled")
		writeErr(w, http.StatusUnauthorized, errors.New("应用已被禁用"))
		return
	case row.Revoked:
		a.revokeAppTokens(row.AppID, "refresh_reuse")
		writeErr(w, http.StatusUnauthorized, errors.New("刷新令牌已被轮换，该应用全部令牌已吊销"))
		return
	case now >= row.Exp:
		writeErr(w, http.StatusUnauthorized, errors.New("刷新令牌已过绝对有效期"))
		return
	case now-row.LastUse > int64(refreshIdleTTL/time.Second):
		a.revokeAppTokens(row.AppID, "refresh_idle")
		writeErr(w, http.StatusUnauthorized, errors.New("刷新令牌已超过不活跃期限，已全部吊销"))
		return
	}

	var extra []string
	if row.ExtraScopes != "" {
		for _, s := range strings.Split(row.ExtraScopes, ",") {
			if s = strings.TrimSpace(s); s != "" {
				extra = append(extra, s)
			}
		}
	}
	sess, err := a.issueAppSession(row.AppID, extra...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.store.RotateRefresh(req.RefreshToken, config.RefreshRow{
		Token: sess.RefreshTok, AppID: row.AppID, JTI: sess.AccessJTI,
		RotFrom: req.RefreshToken, Exp: sess.RefreshExp, LastUse: now, CreatedAt: now,
		ExtraScopes: row.ExtraScopes,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.audit.record(auditEntry{
		AppID:  row.AppID,
		HostID: permReqHost(req.Host),
		Type:   auditSessionRevoke,
		Target: "session/refresh",
		Result: "rotated",
	})
	writeJSON(w, sess.mintResp())
}

// handleSessionRevoke 支持两种粒度：
//   - {app}：整体撤销该应用（递增令牌世代 + 作废全部刷新令牌）；
//   - {token}：吊销单枚访问令牌（jti 名单）或单枚刷新令牌。
//
// 权限要求（§9.1）：
//   - 宿主壳或具备 perm:revoke 权限的主体（如设置应用）可吊销任意应用或令牌；
//   - 普通应用仅允许吊销自身的令牌或会话。
func (a *Gateway) handleSessionRevoke(w http.ResponseWriter, r *http.Request) {
	tok := sessionHeaderToken(r)
	caller := a.sessionApp(tok)
	if caller == "" {
		writeErr(w, http.StatusUnauthorized, errors.New("缺少有效会话"))
		return
	}
	hasManage := caller == hostApp || a.permAllowed(caller, "perm:revoke")

	var req sessionRevokeReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	switch {
	case req.App != "":
		if !appIDRe.MatchString(req.App) {
			writeErr(w, http.StatusBadRequest, errors.New("应用 id 非法"))
			return
		}
		if !a.appExists(req.App) {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("应用不存在：%s", req.App))
			return
		}
		if caller != req.App && !hasManage {
			writeErr(w, http.StatusForbidden, errors.New("只有宿主或具备 perm:revoke 权限的主体可以吊销其他应用的会话"))
			return
		}
		a.revokeAppTokens(req.App, "session_revoke")
	case req.Token != "":
		if !hasManage {
			if c, err := a.idp.verify(req.Token, time.Now()); err == nil && c != nil {
				if c.Subject != caller {
					writeErr(w, http.StatusForbidden, errors.New("无权吊销其他应用的令牌"))
					return
				}
			} else if row, ok := a.store.GetRefresh(req.Token); ok {
				if row.AppID != caller {
					writeErr(w, http.StatusForbidden, errors.New("无权吊销其他应用的令牌"))
					return
				}
			}
		}
		a.revokeToken(req.Token)
	default:
		writeErr(w, http.StatusBadRequest, errors.New("app 与 token 至少填一个"))
		return
	}
	writeJSON(w, okResp{OK: true})
}
