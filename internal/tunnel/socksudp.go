// SOCKS5 的 UDP 转发（UDP ASSOCIATE）实现。
//
// 动态转发默认只接 CONNECT，浏览器里 QUIC / WebRTC / 局域网设备探测这类 UDP 流量
// 走不出去。这条路径补上 SOCKS5 的 CMD=3：客户端把封装好的数据报（RSV|FRAG|ATYP
// |ADDR|PORT|DATA）发到本机关联端口，本机拆出目标地址，帧化后经 direct-tcpip 通道
// 送到远端临时目录里的 --any 中继，由真正的 UDP socket 发出去；回包按同样的头
// 打包回客户端。
//
// 中继进程按 SSH 客户端共享一个，而不是按目标地址各起一个：--any 模式的中继每帧
// 自带目的地址，一条中继就能服务任意目的地。浏览一个站点常要解析出几十个域名，
// 按目标建进程会立刻失控。

package tunnel

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	// socksAssocIdleTTL 是一条 UDP 关联的空闲时限：控制连接还在但一条数据报都没有。
	socksAssocIdleTTL = 5 * time.Minute
	// socksAgentIdleTTL 是某个 SSH 客户端上 --any 中继的空闲回收时间。
	socksAgentIdleTTL = 10 * time.Minute
	// socksJanitorEvery 是空闲中继的扫描周期。
	socksJanitorEvery = 30 * time.Second
)

// socksUDP 挂在一条动态转发上，负责 UDP ASSOCIATE 的公共部分：共享的远端中继。
type socksUDP struct {
	client *ssh.Client
	done   chan struct{}

	mu     sync.Mutex
	agent  *udpAgent
	assocs int
	seen   time.Time
	closed bool
	once   sync.Once
}

// newSocksUDP 为一条动态转发准备 UDP 转发面：中继按需懒建，不在这里起进程。
func newSocksUDP(client *ssh.Client) *socksUDP {
	su := &socksUDP{client: client, done: make(chan struct{})}
	go su.janitor()
	return su
}

// close 停止这条动态转发上的全部 UDP 转发，并清理远端中继。
func (su *socksUDP) close() {
	su.once.Do(func() {
		close(su.done)
		su.mu.Lock()
		su.closed = true
		ag := su.agent
		su.agent = nil
		su.mu.Unlock()
		if ag != nil {
			ag.close()
		}
	})
}

// relay 取（或懒建）共享的远端中继。
func (su *socksUDP) relay() (*udpAgent, error) {
	su.mu.Lock()
	if su.closed {
		su.mu.Unlock()
		return nil, errors.New("这条动态转发的 UDP 转发已停止")
	}
	if ag := su.agent; ag != nil {
		su.seen = time.Now()
		su.mu.Unlock()
		return ag, nil
	}
	su.mu.Unlock()

	ag, err := launchUDPAgentAny(su.client)
	if err != nil {
		return nil, err
	}

	su.mu.Lock()
	if su.closed {
		su.mu.Unlock()
		ag.close()
		return nil, errors.New("这条动态转发的 UDP 转发已停止")
	}
	if su.agent != nil {
		done := su.agent
		su.seen = time.Now()
		su.mu.Unlock()
		ag.close()
		return done, nil
	}
	su.agent = ag
	su.seen = time.Now()
	su.mu.Unlock()
	return ag, nil
}

// beginAssoc / endAssoc 维护活跃关联计数，janitor 靠它判断中继是否还有人用。
func (su *socksUDP) beginAssoc() bool {
	su.mu.Lock()
	defer su.mu.Unlock()
	if su.closed {
		return false
	}
	su.assocs++
	su.seen = time.Now()
	return true
}

func (su *socksUDP) endAssoc() {
	su.mu.Lock()
	if su.assocs > 0 {
		su.assocs--
	}
	su.seen = time.Now()
	su.mu.Unlock()
}

func (su *socksUDP) janitor() {
	tick := time.NewTicker(socksJanitorEvery)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			su.mu.Lock()
			var ag *udpAgent
			if su.agent != nil && su.assocs == 0 && time.Since(su.seen) > socksAgentIdleTTL {
				ag = su.agent
				su.agent = nil
			}
			su.mu.Unlock()
			if ag != nil {
				ag.close()
			}
		case <-su.done:
			return
		}
	}
}

// associate 处理一条 SOCKS5 UDP ASSOCIATE：开本机中继套接字、把 BND 回给客户端，
// 然后按数据报头里的目的地逐包经 SSH 转出去。host/port 是客户端在请求里声明的
// 源地址，全零表示不限定。
func (su *socksUDP) associate(ctl net.Conn, host string, port int) {
	if !su.beginAssoc() {
		_, _ = ctl.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer su.endAssoc()

	sock, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		_, _ = ctl.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer sock.Close()

	laddr := sock.LocalAddr().(*net.UDPAddr)
	ip4 := laddr.IP.To4()
	if ip4 == nil {
		ip4 = net.IPv4(127, 0, 0, 1).To4()
	}
	reply := make([]byte, 10)
	reply[0], reply[1], reply[2], reply[3] = 0x05, 0x00, 0x00, 0x01
	copy(reply[4:8], ip4)
	binary.BigEndian.PutUint16(reply[8:], uint16(laddr.Port))
	if _, err := ctl.Write(reply); err != nil {
		return
	}

	assoc := &socksAssoc{su: su, sock: sock, pipes: map[string]*socksPipe{}}
	assoc.lockPeer(host, port, ctl)

	// 控制连接的生命周期就是关联的生命周期：它一断，UDP 侧跟着收摊。
	go func() {
		_, _ = io.Copy(io.Discard, ctl)
		_ = sock.Close()
	}()
	assoc.run()
	assoc.close()
}

// socksAssoc 是一条客户端与代理之间的 UDP 关联。
type socksAssoc struct {
	su   *socksUDP
	sock *net.UDPConn

	mu     sync.Mutex
	client *net.UDPAddr
	pipes  map[string]*socksPipe
	once   sync.Once
}

// lockPeer 记录这条关联允许的客户端地址：请求里点名了源地址就锁它，
// 否则只锁控制连接的 IP（端口由第一条数据报决定，允许浏览器换套接字）。
func (a *socksAssoc) lockPeer(host string, port int, ctl net.Conn) {
	if ip := net.ParseIP(host); ip != nil && port > 0 && !ip.IsUnspecified() {
		a.client = &net.UDPAddr{IP: ip, Port: port}
		return
	}
	if addr, ok := ctl.RemoteAddr().(*net.TCPAddr); ok && addr != nil {
		a.client = &net.UDPAddr{IP: addr.IP}
	}
}

// accept 判定这条数据报是否来自被允许的客户端地址。
func (a *socksAssoc) accept(from *net.UDPAddr) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client == nil {
		a.client = &net.UDPAddr{IP: from.IP, Port: from.Port}
		return true
	}
	if !a.client.IP.Equal(from.IP) {
		return false
	}
	return a.client.Port == 0 || a.client.Port == from.Port
}

// run 循环读客户端数据报；空闲超时或套接字被关就结束关联。
func (a *socksAssoc) run() {
	buf := make([]byte, udpFrameLimit)
	for {
		_ = a.sock.SetReadDeadline(time.Now().Add(socksAssocIdleTTL))
		n, from, err := a.sock.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if n < 4 {
			continue
		}
		if !a.accept(from) {
			continue
		}
		// SOCKS5 UDP 头：RSV(2) | FRAG(1) | ATYP|ADDR|PORT | DATA。
		// FRAG != 0 表示客户端要分片，这里不支持，直接丢。
		if buf[2] != 0 {
			continue
		}
		a.send(buf[3:n])
	}
}

// send 按数据报里的目的地挑管道，把「ATYP|ADDR|PORT|DATA」整体交给它。
func (a *socksAssoc) send(body []byte) {
	target, ok := socksTarget(body)
	if !ok {
		return
	}
	p, err := a.pipeFor(target)
	if err != nil || p == nil {
		return
	}
	_ = p.write(body)
}

// pipeFor 取（或新建）某个目的地对应的 SSH 通道。
func (a *socksAssoc) pipeFor(target string) (*socksPipe, error) {
	a.mu.Lock()
	if p := a.pipes[target]; p != nil {
		a.mu.Unlock()
		return p, nil
	}
	a.mu.Unlock()

	ag, err := a.su.relay()
	if err != nil {
		return nil, err
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(ag.port))
	conn, err := ag.client.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	fresh := &socksPipe{target: target, conn: conn, seen: time.Now()}

	a.mu.Lock()
	if existing := a.pipes[target]; existing != nil {
		a.mu.Unlock()
		fresh.close()
		return existing, nil
	}
	a.pipes[target] = fresh
	a.mu.Unlock()

	go a.readPipe(fresh)
	return fresh, nil
}

// readPipe 读中继回来的帧，补上 RSV/FRAG 后发给客户端。
func (a *socksAssoc) readPipe(p *socksPipe) {
	defer a.dropPipe(p.target, p)
	head := make([]byte, 2)
	for {
		if _, err := io.ReadFull(p.conn, head); err != nil {
			return
		}
		size := int(binary.BigEndian.Uint16(head))
		body := make([]byte, size)
		if _, err := io.ReadFull(p.conn, body); err != nil {
			return
		}
		p.touch()
		if size < 4 {
			continue
		}
		dgram := make([]byte, 3+len(body))
		copy(dgram[3:], body)
		a.forward(dgram)
	}
}

// forward 把打包好的数据报发给客户端。
func (a *socksAssoc) forward(dgram []byte) {
	a.mu.Lock()
	dst := a.client
	a.mu.Unlock()
	if dst == nil || dst.Port == 0 {
		return
	}
	_, _ = a.sock.WriteToUDP(dgram, dst)
}

func (a *socksAssoc) dropPipe(target string, p *socksPipe) {
	a.mu.Lock()
	if cur := a.pipes[target]; cur == p {
		delete(a.pipes, target)
	}
	a.mu.Unlock()
	p.close()
}

func (a *socksAssoc) close() {
	a.once.Do(func() {
		a.mu.Lock()
		pipes := a.pipes
		a.pipes = map[string]*socksPipe{}
		a.mu.Unlock()
		for _, p := range pipes {
			p.close()
		}
	})
}

// socksPipe 是一条通往远端中继的 SSH 通道，一条通道服务一个目的地。
type socksPipe struct {
	target string
	conn   net.Conn

	mu   sync.Mutex
	seen time.Time
	once sync.Once
}

// write 把「ATYP|ADDR|PORT|DATA」按 2 字节长度前缀封帧写进通道。
func (p *socksPipe) write(body []byte) error {
	if len(body) > udpFrameLimit {
		return errors.New("datagram too large")
	}
	frame := make([]byte, 2+len(body))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(body)))
	copy(frame[2:], body)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = time.Now()
	_, err := p.conn.Write(frame)
	return err
}

func (p *socksPipe) touch() {
	p.mu.Lock()
	p.seen = time.Now()
	p.mu.Unlock()
}

func (p *socksPipe) close() {
	p.once.Do(func() { _ = p.conn.Close() })
}

// socksTarget 从「ATYP|ADDR|PORT|DATA」里取出目标，格式化成 host:port 作为管道键。
func socksTarget(body []byte) (string, bool) {
	if len(body) < 4 {
		return "", false
	}
	var host string
	off := 0
	switch body[0] {
	case 1:
		if len(body) < 7 {
			return "", false
		}
		host = net.IP(body[1:5]).String()
		off = 5
	case 3:
		n := int(body[1])
		if n == 0 || len(body) < 2+n+2 {
			return "", false
		}
		host = string(body[2 : 2+n])
		off = 2 + n
	case 4:
		if len(body) < 19 {
			return "", false
		}
		host = net.IP(body[1:17]).String()
		off = 17
	default:
		return "", false
	}
	if host == "" {
		return "", false
	}
	port := binary.BigEndian.Uint16(body[off : off+2])
	if port == 0 {
		return "", false
	}
	return net.JoinHostPort(host, strconv.Itoa(int(port))), true
}
