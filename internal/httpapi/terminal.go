package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     sameOrigin,
}

const wsMaxSessions = 64

// WS 保活参数（QX-034）：半开连接在 pongWait 内被检出并释放 wsSlots，
// 防止 64 条死连接耗尽长连接名额；写超时防泵 goroutine 卡死在死 TCP 上。
const (
	wsPongWait   = 60 * time.Second
	wsPingPeriod = 25 * time.Second
	wsWriteWait  = 10 * time.Second
)

// wsKeepalive 为连接设置读限期 + pong 重置 + 周期 ping。stop 关闭时停止
// ping；ping 失败触发 onDead 结束会话。浏览器 WS 客户端自动回 pong。
func wsKeepalive(conn *websocket.Conn, stop <-chan struct{}, onDead func()) {
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})
	go func() {
		t := time.NewTicker(wsPingPeriod)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteWait)); err != nil {
					if onDead != nil {
						onDead()
					}
					return
				}
			}
		}
	}()
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		// 空 Origin（非浏览器客户端）与字面量 "null"（无 allow-same-origin 的 sandbox 应用帧，
		// 其源不透明）都放行。WebSocket 端点的真正凭据是查询串里的会话令牌，
		// 由 sysDispatch 按应用身份逐次校验；这里的源检查只是纵深防御。
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func (a *Gateway) acquireWSSlot(w http.ResponseWriter) (release func(), ok bool) {
	select {
	case a.wsSlots <- struct{}{}:
		return func() { <-a.wsSlots }, true
	default:
		http.Error(w, "并发长连接数已达上限，请先关掉一些终端或连接", http.StatusServiceUnavailable)
		return nil, false
	}
}

func wsPump(wr *wsWriter, r io.Reader, onWriteErr, onReadErr func()) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := wr.binary(buf[:n]); werr != nil {
				if onWriteErr != nil {
					onWriteErr()
				}
				return
			}
		}
		if err != nil {
			if onReadErr != nil {
				onReadErr()
			}
			return
		}
	}
}

type inMsg struct {
	T string `json:"t"`
	D string `json:"d"`
	C int    `json:"c"`
	R int    `json:"r"`
}

type outMsg struct {
	T    string `json:"t"`
	Code int    `json:"code,omitempty"`
	M    string `json:"m,omitempty"`
}

type wsWriter struct {
	mu sync.Mutex
	c  *websocket.Conn
}

func (w *wsWriter) binary(b []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return w.c.WriteMessage(websocket.BinaryMessage, b)
}

func (w *wsWriter) json(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return w.c.WriteJSON(v)
}

func (a *Gateway) serveTerminalWS(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("host")
	if hostID == "" {
		http.Error(w, "missing host", http.StatusBadRequest)
		return
	}
	a.serveSessionWS(w, r, hostID, "", r.URL.Query().Get("cwd"), "")
}

func wsSize(r *http.Request) (int, int) {
	cols, rows := 80, 24
	if v := r.URL.Query().Get("cols"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &cols)
	}
	if v := r.URL.Query().Get("rows"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &rows)
	}
	if cols < 20 {
		cols = 20
	}
	if rows < 5 {
		rows = 5
	}
	return cols, rows
}

func (a *Gateway) serveSessionWS(w http.ResponseWriter, r *http.Request, hostID, command, cwd, stdinInit string) {

	release, ok := a.acquireWSSlot(w)
	if !ok {
		return
	}
	defer release()
	client, err := a.mgr.Get(hostID)
	if err != nil {
		http.Error(w, "ssh connect: "+err.Error(), http.StatusBadGateway)
		return
	}

	sess, err := client.NewSession()
	if err != nil {
		a.mgr.Invalidate(hostID)
		http.Error(w, "session: "+err.Error(), http.StatusBadGateway)
		return
	}
	success := false
	defer func() {
		if !success {
			_ = sess.Close()
		}
	}()

	cols, rows := wsSize(r)

	loc := posixLocale(r.URL.Query().Get("lang"))
	if err := sess.Setenv("COLORTERM", "truecolor"); err != nil {
		a.log.Debug("terminal COLORTERM not accepted by sshd (AcceptEnv)", "error", err.Error())
	}

	// QXS-37：stdinInit 非空意味着我们要在会话开始前预喂一段秘密（目前只有
	// sudo 密码）。此时必须关闭 pty 回显，否则密码会被远端回显、经 wsPump 送回
	// 客户端并留在滚动缓冲区/日志里。交互式终端走 command=="" 分支，stdinInit
	// 恒为空，因此不会误关用户按键回显。
	echo := uint32(1)
	if stdinInit != "" {
		echo = 0
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          echo,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		http.Error(w, "pty: "+err.Error(), http.StatusBadGateway)
		return
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		http.Error(w, "stdin: "+err.Error(), http.StatusBadGateway)
		return
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		http.Error(w, "stdout: "+err.Error(), http.StatusBadGateway)
		return
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		http.Error(w, "stderr: "+err.Error(), http.StatusBadGateway)
		return
	}

	if command == "" {
		command = terminalCommand(cwd, loc)
	}
	err = sess.Start(command)
	if err != nil {
		http.Error(w, "shell: "+err.Error(), http.StatusBadGateway)
		return
	}
	if stdinInit != "" {
		if _, err := io.WriteString(stdin, stdinInit); err != nil {
			a.log.Warn("session stdin init write failed", "error", err.Error())
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		a.log.Error("terminal ws upgrade failed", "error", err.Error())
		return
	}
	success = true
	defer conn.Close()

	wr := &wsWriter{c: conn}
	conn.SetReadLimit(1 << 20)

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	wsKeepalive(conn, done, finish)

	go wsPump(wr, stdout, finish, finish)
	go wsPump(wr, stderr, finish, nil)

	go func() {
		defer finish()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg inMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			switch msg.T {
			case "in":
				if _, err := io.WriteString(stdin, msg.D); err != nil {
					return
				}
			case "resize":
				if msg.C > 0 && msg.R > 0 {
					_ = sess.WindowChange(msg.R, msg.C)
				}
			}
		}
	}()

	exitCh := make(chan error, 1)
	go func() { exitCh <- sess.Wait() }()

	select {
	case <-done:
		_ = sess.Close()
		conn.Close()
		return
	case err := <-exitCh:
		code := 0
		if ee, ok := err.(*ssh.ExitError); ok {
			code = ee.ExitStatus()
		} else if err != nil {
			a.mgr.Invalidate(hostID)
		}
		_ = wr.json(outMsg{T: "exit", Code: code})
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(2*time.Second))
		return
	}
}
