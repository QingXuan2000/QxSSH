// Package tunnel 管理 SSH 端口转发。
//
// 支持三种转发：本地转发（local，本机监听并经 SSH 通道连远端目标）、
// 远程转发（remote，远端监听并转发回本机）与动态转发（dynamic，本机监听作
// SOCKS5 代理）。本地/动态转发出于安全只允许绑定回环地址。
// Registry 负责转发实例的启动、停止、列举，以及某个主机失效时停止其全部转发。
package tunnel

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"qxssh/internal/config"
	"qxssh/internal/sshpool"
)

// Options 是启动一条端口转发的参数。
type Options struct {
	HostID string `json:"hostId"`
	Type   string `json:"type"`
	Bind   string `json:"bind"`
	Port   int    `json:"port"`
	Target string `json:"target"`
	// Proto 是承载协议：tcp（缺省）或 udp。udp 只支持 Type=local，
	// 由 startUDP 起一条「本机 UDP ↔ SSH 通道 ↔ 远端中继」的接力转发。
	Proto string `json:"proto"`
	// UDP 打开动态转发的 SOCKS5 UDP ASSOCIATE（CMD=3）：浏览器把 UDP 数据报直接交给
	// 代理，由这条动态转发经 SSH 中继出去。只有 Type=dynamic 时有效。
	UDP bool `json:"udp"`

}

// Running 描述一条正在运行的端口转发。cancel 用于内部停止该转发的监听循环。
type Running struct {
	ID       string `json:"id"`
	HostID   string `json:"hostId"`
	HostName string `json:"hostName"`
	Type     string `json:"type"`
	Proto    string `json:"proto"`
	// UDP 表示这条动态转发额外提供 SOCKS5 UDP ASSOCIATE。
	UDP    bool   `json:"udp,omitempty"`
	Listen string `json:"listen"`
	Target string `json:"target,omitempty"`
	Proxy  string `json:"proxy,omitempty"`
	// Agent / AgentPort 只对 UDP 转发有意义：远端临时目录里的中继文件路径，
	// 以及它绑在远端回环上的 TCP 端口（本机的 datagram 都从这条通道进去）。
	Agent     string `json:"agent,omitempty"`
	AgentPort int    `json:"agentPort,omitempty"`
	StartedAt    time.Time `json:"startedAt"`

	cancel func()
}

// Registry 是端口转发注册表，并发安全。
type Registry struct {
	mu    sync.Mutex
	items map[string]*Running
	mgr   *sshpool.Pool
	store *config.Store
	seq   int
}

// New 创建一个端口转发注册表。
func New(mgr *sshpool.Pool, store *config.Store) *Registry {
	return &Registry{
		items: map[string]*Running{},
		mgr:   mgr,
		store: store,
	}
}

// List 返回所有运行中的转发副本。
func (m *Registry) List() []Running {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Running, 0, len(m.items))
	for _, it := range m.items {
		cp := *it
		cp.cancel = nil
		out = append(out, cp)
	}
	return out
}

// Get 按 id 查询转发，第二个返回值表示是否存在。
func (m *Registry) Get(id string) (Running, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok {
		return Running{}, false
	}
	cp := *it
	cp.cancel = nil
	return cp, true
}

// Stop 停止指定 id 的转发。
func (m *Registry) Stop(id string) error {
	m.mu.Lock()
	it, ok := m.items[id]
	if ok {
		delete(m.items, id)
	}
	m.mu.Unlock()
	if !ok {
		return errors.New("tunnel not found")
	}
	it.cancel()
	return nil
}

// StopAll 停止全部转发。
func (m *Registry) StopAll() {
	m.mu.Lock()
	all := m.items
	m.items = map[string]*Running{}
	m.mu.Unlock()
	for _, it := range all {
		it.cancel()
	}
}

// StopByHost 停止某主机上的全部转发，返回停止的数量。
func (m *Registry) StopByHost(hostID string) int {
	m.mu.Lock()
	var stopped []*Running
	for id, it := range m.items {
		if it.HostID == hostID {
			delete(m.items, id)
			stopped = append(stopped, it)
		}
	}
	m.mu.Unlock()
	for _, it := range stopped {
		it.cancel()
	}
	return len(stopped)
}

var loopbackOnly = map[string]bool{
	"127.0.0.1": true,
	"localhost": true,
	"::1":       true,
	"[::1]":     true,
}

func normalizeBind(b string) string {
	if b == "" {
		return "127.0.0.1"
	}
	return b
}

// Start 按 Options 启动一条端口转发并返回其运行信息。
// 会校验类型、绑定地址（本地/动态仅允许回环）与目标格式。
func (m *Registry) Start(req Options) (*Running, error) {
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))

	req.Proto = strings.ToLower(strings.TrimSpace(req.Proto))
	if req.Proto == "" {
		req.Proto = "tcp"
	}
	if req.Proto != "tcp" && req.Proto != "udp" {
		return nil, errors.New("proto must be tcp|udp")
	}
	if req.Type != "local" && req.Type != "remote" && req.Type != "dynamic" {
		return nil, errors.New("type must be local|remote|dynamic")
	}
	if req.Port < 0 || req.Port > 65535 {
		return nil, errors.New("invalid port")
	}
	req.Bind = normalizeBind(req.Bind)

	// UDP 走的是另一条路径：先在同一台主机上部署远端中继，再开本机 UDP 监听。
	if req.Proto == "udp" {
		if req.Type != "local" {
			return nil, errors.New("UDP 转发只支持 type=local：SSH 通道只承载 TCP，远端 UDP 监听无法建立")
		}
		return m.startUDP(req)
	}

	if req.Type == "local" || req.Type == "dynamic" {
		if !loopbackOnly[req.Bind] {
			return nil, fmt.Errorf(
				"监听地址只允许 127.0.0.1 / ::1（收到 %q）：开在 0.0.0.0 上会让同网段"+
					"任何机器都连进来借道访问被控机内网，而转发没有认证", req.Bind)
		}
	}
	if req.Type != "dynamic" {
		if req.Target == "" {
			return nil, errors.New("target is required")
		}
		if _, _, err := net.SplitHostPort(req.Target); err != nil {
			return nil, errors.New("target must be host:port")
		}
	}

	host, ok := m.store.GetHost(req.HostID)
	if !ok {
		return nil, errors.New("host not found")
	}
	client, err := m.mgr.Get(req.HostID)
	if err != nil {
		return nil, err
	}

	// 打开 UDP 的动态转发要额外挂一层 SOCKS5 UDP ASSOCIATE 支持面。
	var su *socksUDP
	if req.Type == "dynamic" && req.UDP {
		su = newSocksUDP(client)
	}

	listen := net.JoinHostPort(req.Bind, strconv.Itoa(req.Port))

	var ln net.Listener
	var lerr error
	switch req.Type {
	case "local", "dynamic":
		ln, lerr = net.Listen("tcp", listen)
	case "remote":
		ln, lerr = client.Listen("tcp", listen)
	}
	if lerr != nil {
		if su != nil {
			su.close()
		}
		return nil, lerr
	}

	var closeOnce sync.Once
	closeFn := func() {
		closeOnce.Do(func() {
			_ = ln.Close()
			if su != nil {
				su.close()
			}
		})
	}

	listen = ln.Addr().String()

	m.mu.Lock()
	m.seq++
	id := fmt.Sprintf("t%d", m.seq)
	it := &Running{
		ID:        id,
		HostID:    req.HostID,
		HostName:  host.Name,
		Type:      req.Type,
		Proto:     "tcp",
		UDP:       su != nil,
		Listen:    listen,
		Target:    req.Target,
		StartedAt: time.Now(),
		cancel:    closeFn,
	}

	if req.Type == "local" || req.Type == "dynamic" {
		it.Proxy = socksURL(listen)
	}
	m.items[id] = it
	m.mu.Unlock()

	switch req.Type {
	case "local":
		go runLocal(ln, client, req.Target)
	case "remote":
		go runRemote(ln, req.Target)
	case "dynamic":
		go runDynamic(ln, client, su)
	}

	return it, nil
}

func socksURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return ""
	}
	if _, err := strconv.Atoi(port); err != nil {
		return ""
	}
	if ip := net.ParseIP(host); ip == nil || ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return "socks5://" + net.JoinHostPort(host, port)
}

func runLocal(ln net.Listener, client *ssh.Client, target string) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			d, err := client.Dial("tcp", target)
			if err != nil {
				_ = c.Close()
				return
			}
			proxy(c, d)
		}()
	}
}

func runRemote(ln net.Listener, target string) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			d, err := net.Dial("tcp", target)
			if err != nil {
				_ = c.Close()
				return
			}
			proxy(c, d)
		}()
	}
}

func runDynamic(ln net.Listener, client *ssh.Client, su *socksUDP) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handleSocks5(client, c, su)
	}
}

// handleSocks5 处理一条 SOCKS5 客户端连接：CONNECT 直接开 TCP 通道，
// UDP ASSOCIATE 交给 su（只有开了 UDP 的动态转发才非 nil）。
func handleSocks5(client *ssh.Client, c net.Conn, su *socksUDP) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))

	head := make([]byte, 2)
	if _, err := io.ReadFull(c, head); err != nil || head[0] != 5 {
		return
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	if _, err := c.Write([]byte{0x05, 0x00}); err != nil {
		return
	}

	req := make([]byte, 4)
	if _, err := io.ReadFull(c, req); err != nil {
		return
	}
	var host string
	switch req[3] {
	case 1:
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 3:
		lb := make([]byte, 1)
		if _, err := io.ReadFull(c, lb); err != nil {
			return
		}
		b := make([]byte, int(lb[0]))
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = string(b)
	case 4:
		b := make([]byte, 16)
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	default:
		_, _ = c.Write([]byte{0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(c, pb); err != nil {
		return
	}
	port := int(binary.BigEndian.Uint16(pb))

	switch req[1] {
	case 1: // CONNECT：一条 SSH 通道顶一段 TCP 连接
		target := net.JoinHostPort(host, strconv.Itoa(port))
		d, err := client.Dial("tcp", target)
		if err != nil {
			_, _ = c.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
			return
		}
		if _, err := c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
			_ = d.Close()
			return
		}
		_ = c.SetDeadline(time.Time{})
		proxy(c, d)
	case 3: // UDP ASSOCIATE：控制连接只当存活信号，数据走本机 UDP 中继
		if su == nil {
			_, _ = c.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
			return
		}
		_ = c.SetDeadline(time.Time{})
		su.associate(c, host, port)
	default: // BIND 等命令这里不提供
		_, _ = c.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	}
}

func proxy(a, b net.Conn) {
	defer a.Close()
	defer b.Close()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(b, a)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(a, b)
		done <- struct{}{}
	}()
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}
