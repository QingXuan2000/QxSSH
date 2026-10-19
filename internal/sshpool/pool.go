// Package sshpool 维护到受管主机的 SSH 连接池。
//
// 它是所有远端能力的唯一出口：负责拨号（含经跳板机逐级转发的跳板链）、
// SSH 握手超时控制、基于 known_hosts 的主机密钥校验、30 秒 keepalive 保活，
// 以及连接失效时对依赖它的主机做级联失效。并发拨号同一主机时只发起一次。
package sshpool

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"qxssh/internal/config"
	"qxssh/internal/logging"
)

const (
	dialTimeout      = 10 * time.Second
	handshakeTimeout = 10 * time.Second
)

// entry 包装单个活跃的 SSH 连接条目，持有底层客户端与断开通知通道。
type entry struct {
	client *ssh.Client
	done   chan struct{}
	once   sync.Once
}

// dialCall 记录正在执行中的拨号调用，供并发请求共享等待，避免惊群重复连接。
type dialCall struct {
	done chan struct{}
	err  error
}

func (e *entry) close() {
	e.once.Do(func() { close(e.done) })
}

func (e *entry) isClosed() bool {
	select {
	case <-e.done:
		return true
	default:
		return false
	}
}

// Pool 是 SSH 连接池。它缓存活跃的 *ssh.Client，并对并发拨号去重。
type Pool struct {
	mu    sync.Mutex
	conns map[string]*entry
	dials map[string]*dialCall
	store *config.Store
	log   *logging.Logger
	hosts *knownHosts

	closed bool

	hooksMu sync.Mutex
	hooks   []func(hostID string)
}

// OnInvalidate 注册一个主机失效回调（例如停止该主机上的端口转发与内网代理）。
// 回调在锁外执行，panic 会被吞掉以免影响其他回调。
func (m *Pool) OnInvalidate(hook func(hostID string)) {
	if hook == nil {
		return
	}
	m.hooksMu.Lock()
	m.hooks = append(m.hooks, hook)
	m.hooksMu.Unlock()
}

func (m *Pool) notifyInvalidate(hostID string) {
	m.hooksMu.Lock()
	hooks := make([]func(string), len(m.hooks))
	copy(hooks, m.hooks)
	m.hooksMu.Unlock()
	for _, h := range hooks {
		func() {
			defer func() { _ = recover() }()
			h(hostID)
		}()
	}
}

// New 创建一个连接池。log 为 nil 时使用默认日志；known_hosts 落在配置目录下。
func New(store *config.Store, log *logging.Logger) *Pool {
	if log == nil {
		log = logging.New(logging.LevelInfo)
	}
	return &Pool{
		conns: map[string]*entry{},
		store: store,
		log:   log,
		hosts: newKnownHosts(store.Dir()),
	}
}

func (m *Pool) authMethods(h config.Host) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	if h.Password != "" {
		methods = append(methods, ssh.Password(h.Password))
	}

	pem := []byte(h.KeyData)
	if len(pem) == 0 && h.KeyPath != "" {
		b, err := os.ReadFile(h.KeyPath)
		if err != nil {
			return nil, fmt.Errorf("read key: %w", err)
		}
		pem = b
	}
	if len(pem) > 0 {
		var signer ssh.Signer
		var err error
		if h.KeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(pem, []byte(h.KeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(pem)
		}
		if err != nil {
			return nil, fmt.Errorf("parse key: %w", err)
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, errors.New("no auth method configured")
	}
	return methods, nil
}

func newClientWithTimeout(conn net.Conn, addr string, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	type result struct {
		ncc   ssh.Conn
		chans <-chan ssh.NewChannel
		reqs  <-chan *ssh.Request
		err   error
	}
	res := make(chan result, 1)
	go func() {
		ncc, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
		res <- result{ncc: ncc, chans: chans, reqs: reqs, err: err}
	}()
	select {
	case r := <-res:
		if r.err != nil {
			return nil, r.err
		}
		return ssh.NewClient(r.ncc, r.chans, r.reqs), nil
	case <-time.After(handshakeTimeout):
		_ = conn.Close()
		return nil, fmt.Errorf("ssh 握手超时（%s）", addr)
	}
}

func (m *Pool) clientConfig(h config.Host, addr string) (*ssh.ClientConfig, error) {
	methods, err := m.authMethods(h)
	if err != nil {
		return nil, err
	}
	return &ssh.ClientConfig{
		User:            h.User,
		Auth:            methods,
		HostKeyCallback: m.hosts.callback(addr),
		Timeout:         dialTimeout,
	}, nil
}

func (m *Pool) dialVia(h config.Host, chain []string) (*ssh.Client, error) {
	addr := net.JoinHostPort(h.Address, fmt.Sprintf("%d", h.Port))
	cfg, err := m.clientConfig(h, addr)
	if err != nil {
		return nil, err
	}

	if h.JumpHostID == "" {
		m.log.Debug("ssh dial", "host", h.Name, "addr", addr, "user", h.User, "via", "direct")
		conn, err := net.DialTimeout("tcp", addr, dialTimeout)
		if err != nil {
			return nil, err
		}
		c, err := newClientWithTimeout(conn, addr, cfg)
		if err != nil {
			return nil, err
		}
		m.log.Info("ssh connected", "host", h.Name, "addr", addr, "user", h.User, "via", "direct")
		return c, nil
	}

	for _, id := range chain {
		if id == h.JumpHostID {
			return nil, errors.New("跳板链存在循环引用")
		}
	}
	if len(chain) > config.MaxJumpDepth {
		return nil, fmt.Errorf("跳板层级超过上限（%d 级）", config.MaxJumpDepth)
	}

	jump, ok := m.store.GetHost(h.JumpHostID)
	if !ok {
		return nil, errors.New("跳板机不存在")
	}
	jumpClient, err := m.get(h.JumpHostID, chain)
	if err != nil {
		return nil, fmt.Errorf("连接跳板机「%s」失败: %w", jump.Name, err)
	}

	m.log.Debug("ssh dial", "host", h.Name, "addr", addr, "user", h.User, "via", jump.Name)
	dialCtx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	conn, err := jumpClient.DialContext(dialCtx, "tcp", addr)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("经跳板「%s」拨号 %s 失败（请确认跳板机能访问该地址）: %w", jump.Name, addr, err)
	}
	client, err := newClientWithTimeout(conn, addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("经跳板「%s」握手失败: %w", jump.Name, err)
	}
	m.log.Info("ssh connected", "host", h.Name, "addr", addr, "user", h.User, "via", jump.Name)
	return client, nil
}

// Get 返回到 hostID 的可用 SSH 客户端，优先复用池中连接，否则建立新连接。
func (m *Pool) Get(hostID string) (*ssh.Client, error) {
	return m.get(hostID, nil)
}

// Preconnect 在后台预热到 hostID 的连接，调用立即返回。已连接或正在连接时不做任何事。
func (m *Pool) Preconnect(hostID string) {
	if hostID == "" {
		return
	}
	if c := m.pooled(hostID); c != nil {
		return
	}
	go func() {
		if _, err := m.Get(hostID); err != nil {
			m.log.Debug("ssh preconnect failed", "host", hostID, "error", err.Error())
		}
	}()
}

func (m *Pool) get(hostID string, chain []string) (*ssh.Client, error) {
	h, ok := m.store.GetHost(hostID)
	if !ok {
		return nil, errors.New("host not found")
	}

	if c := m.pooled(hostID); c != nil {
		return c, nil
	}

	m.mu.Lock()
	if m.dials == nil {
		m.dials = map[string]*dialCall{}
	}
	if call, ok := m.dials[hostID]; ok {
		m.mu.Unlock()
		<-call.done
		if c := m.pooled(hostID); c != nil {
			return c, nil
		}
		if call.err != nil {
			return nil, call.err
		}
		return nil, errors.New("ssh 连接不可用")
	}
	call := &dialCall{done: make(chan struct{})}
	m.dials[hostID] = call
	m.mu.Unlock()

	client, err := m.dialHost(h, hostID, chain)

	call.err = err
	close(call.done)
	m.mu.Lock()
	delete(m.dials, hostID)
	m.mu.Unlock()

	if err != nil {
		return nil, err
	}
	return client, nil
}

func (m *Pool) dialHost(h config.Host, hostID string, chain []string) (*ssh.Client, error) {
	next := append(append([]string{}, chain...), hostID)
	client, err := m.dialVia(h, next)
	if err != nil {
		m.log.Warn("ssh connect failed", "host", h.Name, "error", err.Error())
		return nil, err
	}

	e := &entry{client: client, done: make(chan struct{})}

	m.mu.Lock()
	if m.closed {

		m.mu.Unlock()
		e.close()
		_ = client.Close()
		return nil, errors.New("ssh pool closed")
	}
	old, exists := m.conns[hostID]
	if exists && !old.isClosed() {

		m.mu.Unlock()
		e.close()
		_ = client.Close()
		return old.client, nil
	}
	m.conns[hostID] = e
	m.mu.Unlock()

	go m.keepalive(hostID, e)
	return client, nil
}

func (m *Pool) pooled(hostID string) *ssh.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.conns[hostID]
	if !ok {
		return nil
	}
	if e.isClosed() {
		delete(m.conns, hostID)
		return nil
	}
	return e.client
}

// DialOnce 建立一次性的 SSH 连接，不放入连接池，由调用方负责关闭。
// 常用于测试与探测场景。
func (m *Pool) DialOnce(h config.Host) (*ssh.Client, error) {
	return m.dialVia(h, nil)
}

// ProbeWithOS 连接主机并测量 TCP 与握手耗时，同时探测远端操作系统。
// 非跳板场景返回 tcpMs 与 handshakeMs；跳板场景只返回 handshakeMs（tcpMs 为 -1）。
func (m *Pool) ProbeWithOS(h config.Host) (tcpMs, handshakeMs int64, os OSInfo, err error) {
	return m.probe(h)
}

func (m *Pool) probe(h config.Host) (tcpMs, handshakeMs int64, os OSInfo, err error) {
	addr := net.JoinHostPort(h.Address, fmt.Sprintf("%d", h.Port))
	cfg, err := m.clientConfig(h, addr)
	if err != nil {
		return -1, -1, osFallback, err
	}

	if h.JumpHostID == "" {
		start := time.Now()
		conn, derr := net.DialTimeout("tcp", addr, dialTimeout)
		if derr != nil {
			return -1, -1, osFallback, derr
		}
		tcpMs = time.Since(start).Milliseconds()
		hStart := time.Now()
		client, herr := newClientWithTimeout(conn, addr, cfg)
		if herr != nil {
			return tcpMs, -1, osFallback, herr
		}
		handshakeMs = time.Since(hStart).Milliseconds()
		os = detectOS(client)
		_ = client.Close()
		return tcpMs, handshakeMs, os, nil
	}

	start := time.Now()
	client, err := m.dialVia(h, nil)
	if err != nil {
		return -1, -1, osFallback, err
	}
	handshakeMs = time.Since(start).Milliseconds()
	os = detectOS(client)
	_ = client.Close()
	return -1, handshakeMs, os, nil
}

func (m *Pool) keepalive(hostID string, e *entry) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.done:
			return
		case <-t.C:
			_, _, err := e.client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				m.log.Warn("ssh keepalive failed, dropping connection", "host", hostID, "error", err.Error())
				m.Invalidate(hostID)
				return
			}
		}
	}
}

// Invalidate 关闭 hostID 的连接，并级联失效所有以它为跳板机的下游主机，
// 最终对每个受影响的主机触发一次失效回调。
func (m *Pool) Invalidate(hostID string) {
	seen := make(map[string]bool)
	m.invalidate(hostID, seen)
	for id := range seen {
		m.notifyInvalidate(id)
	}
}

func (m *Pool) invalidate(hostID string, seen map[string]bool) {
	if seen[hostID] {
		return
	}
	seen[hostID] = true

	for _, dep := range m.dependents(hostID) {
		m.invalidate(dep, seen)
	}
	m.mu.Lock()
	e, ok := m.conns[hostID]
	if ok {
		delete(m.conns, hostID)
	}
	m.mu.Unlock()
	if ok {
		e.close()
		_ = e.client.Close()
	}
}

func (m *Pool) dependents(hostID string) []string {
	return m.store.JumpDependents(hostID)
}

// CloseAll 关闭所有连接并将连接池标记为已关闭，之后 Get 会拒绝建立新连接。
func (m *Pool) CloseAll() {
	m.mu.Lock()
	m.closed = true
	conns := m.conns
	m.conns = map[string]*entry{}
	m.mu.Unlock()
	for _, e := range conns {
		e.close()
		_ = e.client.Close()
	}
}
