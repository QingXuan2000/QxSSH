// UDP 转发实现。
//
// SSH 通道只能承载 TCP 流，所以 UDP 转发不是一条 -L/-R 规则，而是三段接力：
// 本机 UDP 套接字 → 帧化 TCP（装在 SSH 会话的 direct-tcpip 通道里，仍然走 22 端口
// 那条连接）→ 远端临时目录里的中继进程 → 真实 UDP 服务。
//
// 中继进程就是本包内嵌的 udpagent.py：启动转发时上传到远端 $TMPDIR（缺省 /tmp），
// 以 0700 落盘后执行，报告自己的监听端口；停止转发时连同临时文件一起清掉。

package tunnel

import (
	"bufio"
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

//go:embed udpagent.py
var udpAgentSource []byte

const (
	// udpFrameLimit 是单帧载荷上限，等于 UDP 数据报的理论上限。
	udpFrameLimit = 65535
	// udpPeerIdleTTL 是单个客户端会话的空闲回收时间。
	udpPeerIdleTTL = 90 * time.Second
	// udpJanitorEvery 是空闲会话的扫描周期。
	udpJanitorEvery = 20 * time.Second
	// udpAgentBootTTL 是从启动远端中继到它报告监听端口的等待上限。
	udpAgentBootTTL = 25 * time.Second
)

var shellSafeRe = regexp.MustCompile("^[A-Za-z0-9_./-]+$")

// shellQuote 把任意字符串包成 POSIX shell 的单引号字面量。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// syncBuffer 是带锁的 bytes.Buffer，用于并发收集远端 stderr。
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(b.buf.String())
}

// udpAgent 是远端临时目录里那个中继进程的句柄。
type udpAgent struct {
	client   *ssh.Client
	session  *ssh.Session
	path     string
	pid      int
	port     int
	target   string
	shutdown chan struct{}
	once     sync.Once
}

// close 关闭 SSH 会话，并在远端尽力清理进程与临时文件。
func (ag *udpAgent) close() {
	ag.once.Do(func() {
		close(ag.shutdown)
		_ = ag.session.Close()
		if ag.path == "" {
			return
		}
		clean := "rm -f " + shellQuote(ag.path)
		if ag.pid > 0 {
			clean = "kill -9 " + strconv.Itoa(ag.pid) + " 2>/dev/null; " + clean
		}
		sess, err := ag.client.NewSession()
		if err != nil {
			return
		}
		_ = sess.Run("sh -c " + shellQuote(clean))
		_ = sess.Close()
	})
}

// detectUDPInterpreter 找出远端可用的 Python 解释器。
func detectUDPInterpreter(client *ssh.Client) (string, error) {
	tried := make([]string, 0, 2)
	for _, cand := range []string{"python3", "python"} {
		sess, err := client.NewSession()
		if err != nil {
			return "", fmt.Errorf("远端会话创建失败：%w", err)
		}
		out, qerr := sess.Output("sh -c " + shellQuote("command -v "+cand))
		_ = sess.Close()
		tried = append(tried, cand)
		if qerr != nil {
			continue
		}
		p := strings.TrimSpace(string(out))
		if p != "" && shellSafeRe.MatchString(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("远端没有可用的 Python 解释器（试过 %s）：UDP 中继需要目标机上的 python3（或 python）",
		strings.Join(tried, "、"))
}

func randSuffix() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// launchUDPAgent 把内嵌中继上传到远端临时目录、执行它，并等它报告监听端口。
// target 固定时中继只发往这一个目的地，每次收到的载荷就是完整数据报。
func launchUDPAgent(client *ssh.Client, target string) (*udpAgent, error) {
	return launchUDPAgentMode(client, target, false)
}

// launchUDPAgentAny 起 --any 模式的中继：每个数据报自带目的地（ATYP|ADDR|PORT），
// 一条中继就能服务任意目标地址，动态转发的 UDP ASSOCIATE 用它。
func launchUDPAgentAny(client *ssh.Client) (*udpAgent, error) {
	return launchUDPAgentMode(client, "", true)
}

func launchUDPAgentMode(client *ssh.Client, target string, anyTarget bool) (*udpAgent, error) {
	interp, err := detectUDPInterpreter(client)
	if err != nil {
		return nil, err
	}
	suffix, err := randSuffix()
	if err != nil {
		return nil, err
	}

	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("无法在远端开启会话：%w", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	errBuf := &syncBuffer{}
	sess.Stderr = errBuf

	argv := " --host 127.0.0.1 --port 0 --target \"$1\""
	if anyTarget {
		argv = " --host 127.0.0.1 --port 0 --any"
	}

	boot := "D=\"${TMPDIR:-/tmp}\"; " +
		"F=\"$D/qxssh-udp-" + suffix + ".py\"; " +
		"cat > \"$F\" || exit 3; " +
		"chmod 700 \"$F\" || exit 4; " +
		"printf 'QXFILE=%s\\n' \"$F\"; " +
		"printf 'QXPID=%s\\n' \"$$\"; " +
		"exec " + interp + " \"$F\"" + argv

	cmd := "sh -c " + shellQuote(boot) + " qxudp"
	if !anyTarget {
		cmd += " " + shellQuote(target)
	}
	if err := sess.Start(cmd); err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("远端中继启动失败：%w", err)
	}

	go func() {
		if _, werr := stdin.Write(udpAgentSource); werr != nil {
			_ = stdin.Close()
			return
		}
		_ = stdin.Close()
	}()

	type line struct {
		text string
	}
	lines := make(chan line, 8)
	go func() {
		br := bufio.NewReader(stdout)
		for {
			s, rerr := br.ReadString('\n')
			if s != "" {
				lines <- line{text: strings.TrimRight(s, "\r\n")}
			}
			if rerr != nil {
				close(lines)
				return
			}
		}
	}()

	ag := &udpAgent{
		client:   client,
		session:  sess,
		target:   target,
		shutdown: make(chan struct{}),
	}
	deadline := time.After(udpAgentBootTTL)
	for ag.path == "" || ag.port == 0 {
		select {
		case ln, ok := <-lines:
			if !ok {
				ag.close()
				msg := errBuf.String()
				if msg == "" {
					msg = "远端中继进程已退出，没有报告监听端口"
				}
				return nil, fmt.Errorf("UDP 中继部署失败：%s", msg)
			}
			switch {
			case strings.HasPrefix(ln.text, "QXFILE="):
				ag.path = strings.TrimSpace(strings.TrimPrefix(ln.text, "QXFILE="))
			case strings.HasPrefix(ln.text, "QXPID="):
				if pid, cerr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(ln.text, "QXPID="))); cerr == nil {
					ag.pid = pid
				}
			case strings.HasPrefix(ln.text, "QXPORT="):
				if port, cerr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(ln.text, "QXPORT="))); cerr == nil {
					ag.port = port
				}
			}
		case <-deadline:
			ag.close()
			msg := errBuf.String()
			return nil, fmt.Errorf("等待远端 UDP 中继就绪超时（%s），远端输出：%s", udpAgentBootTTL, msg)
		}
	}
	return ag, nil
}

// udpPeer 是一条客户端 IP:port 对应的 SSH 通道与其写锁。
type udpPeer struct {
	conn   net.Conn
	mu     sync.Mutex
	seen   time.Time
	closed sync.Once
}

func (p *udpPeer) send(payload []byte) error {
	frame := make([]byte, 2+len(payload))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(payload)))
	copy(frame[2:], payload)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = time.Now()
	_, err := p.conn.Write(frame)
	return err
}

func (p *udpPeer) touch() {
	p.mu.Lock()
	p.seen = time.Now()
	p.mu.Unlock()
}

func (p *udpPeer) idleFor() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return time.Since(p.seen)
}

func (p *udpPeer) close() {
	p.closed.Do(func() { _ = p.conn.Close() })
}

// udpRuntime 是一条运行中的 UDP 转发：本机 UDP 套接字 + 若干 SSH 通道。
type udpRuntime struct {
	agent *udpAgent
	sock  *net.UDPConn

	mu    sync.Mutex
	peers map[string]*udpPeer

	once sync.Once
}

// startUDP 启动一条 UDP 转发：部署远端中继 + 打开本机 UDP 监听。
func (m *Registry) startUDP(req Options) (*Running, error) {
	if !loopbackOnly[req.Bind] {
		return nil, fmt.Errorf(
			"监听地址只允许 127.0.0.1 / ::1（收到 %q）：UDP 转发没有认证，开在 0.0.0.0 "+
				"等于把被控机内网的 UDP 服务暴露给同网段任何机器", req.Bind)
	}
	if req.Target == "" {
		return nil, errors.New("target is required")
	}
	if _, _, err := net.SplitHostPort(req.Target); err != nil {
		return nil, errors.New("target must be host:port")
	}

	host, ok := m.store.GetHost(req.HostID)
	if !ok {
		return nil, errors.New("host not found")
	}
	client, err := m.mgr.Get(req.HostID)
	if err != nil {
		return nil, err
	}

	agent, err := launchUDPAgent(client, req.Target)
	if err != nil {
		return nil, err
	}

	uaddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(req.Bind, strconv.Itoa(req.Port)))
	if err != nil {
		agent.close()
		return nil, err
	}
	sock, err := net.ListenUDP("udp", uaddr)
	if err != nil {
		agent.close()
		return nil, err
	}

	rt := &udpRuntime{agent: agent, sock: sock, peers: map[string]*udpPeer{}}

	m.mu.Lock()
	m.seq++
	id := fmt.Sprintf("u%d", m.seq)
	it := &Running{
		ID:        id,
		HostID:    req.HostID,
		HostName:  host.Name,
		Type:      "local",
		Proto:     "udp",
		Listen:    sock.LocalAddr().String(),
		Target:    req.Target,
		Agent:     agent.path,
		AgentPort: agent.port,
		StartedAt: time.Now(),
		cancel:    rt.shutdown,
	}
	m.items[id] = it
	m.mu.Unlock()

	go rt.serve()
	go rt.janitor()
	return it, nil
}

// serve 接收本机 UDP 报文，按来源地址分派到各自的 SSH 通道。
func (rt *udpRuntime) serve() {
	buf := make([]byte, udpFrameLimit)
	for {
		n, from, err := rt.sock.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if n <= 0 {
			continue
		}
		p := rt.peer(from)
		if p == nil {
			continue
		}
		if err := p.send(buf[:n]); err != nil {
			rt.drop(from.String())
		}
	}
}

// peer 取（或新建）某个客户端地址对应的 SSH 通道。
func (rt *udpRuntime) peer(from *net.UDPAddr) *udpPeer {
	key := from.String()
	rt.mu.Lock()
	p := rt.peers[key]
	rt.mu.Unlock()
	if p != nil {
		return p
	}

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(rt.agent.port))
	conn, err := rt.agent.client.Dial("tcp", addr)
	if err != nil {
		return nil
	}
	fresh := &udpPeer{conn: conn, seen: time.Now()}

	rt.mu.Lock()
	if existing, ok := rt.peers[key]; ok {
		rt.mu.Unlock()
		fresh.close()
		return existing
	}
	rt.peers[key] = fresh
	rt.mu.Unlock()

	go rt.readPeer(key, fresh, from)
	return fresh
}

// readPeer 读通道上的回包帧，并把它发回原始客户端地址。
func (rt *udpRuntime) readPeer(key string, p *udpPeer, from *net.UDPAddr) {
	defer rt.drop(key)
	head := make([]byte, 2)
	for {
		if _, err := io.ReadFull(p.conn, head); err != nil {
			return
		}
		size := int(binary.BigEndian.Uint16(head))
		if size == 0 {
			continue
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(p.conn, payload); err != nil {
			return
		}
		p.touch()
		if _, err := rt.sock.WriteToUDP(payload, from); err != nil {
			return
		}
	}
}

func (rt *udpRuntime) drop(key string) {
	rt.mu.Lock()
	p := rt.peers[key]
	delete(rt.peers, key)
	rt.mu.Unlock()
	if p != nil {
		p.close()
	}
}

func (rt *udpRuntime) janitor() {
	tick := time.NewTicker(udpJanitorEvery)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			rt.mu.Lock()
			stale := make([]string, 0, 4)
			for key, p := range rt.peers {
				if p.idleFor() > udpPeerIdleTTL {
					stale = append(stale, key)
				}
			}
			rt.mu.Unlock()
			for _, key := range stale {
				rt.drop(key)
			}
		case <-rt.agent.shutdown:
			return
		}
	}
}

// shutdown 停止转发：关本机套接字、断所有通道、清理远端中继。
func (rt *udpRuntime) shutdown() {
	rt.once.Do(func() {
		_ = rt.sock.Close()
		rt.mu.Lock()
		peers := rt.peers
		rt.peers = map[string]*udpPeer{}
		rt.mu.Unlock()
		for _, p := range peers {
			p.close()
		}
		rt.agent.close()
	})
}
