package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

const (
	execDefaultTimeout = 30 * time.Second
	execMaxTimeout     = 300 * time.Second
	execStreamTimeout  = time.Hour
	execMaxArgvBytes   = 256 << 10
	execMaxStdinBytes  = 1 << 20
	execMaxOutputBytes = 1 << 20

	execOutputHardCap = execMaxOutputBytes + 1024
	execBGErrCap      = 8 << 10
	execBGKeepExited  = 16
	execBgMax         = 64
	execGracePeriod   = 700 * time.Millisecond
)

type execRunReq struct {
	Host        string   `json:"host"`
	Argv        []string `json:"argv"`
	Stdin       string   `json:"stdin"`
	Cwd         string   `json:"cwd"`
	Timeout     int      `json:"timeout"`
	Elevated    bool     `json:"elevated"`
	Background  bool     `json:"background"`
	Credentials string   `json:"credentials"`
}

func (a *Gateway) handleExecRun(w http.ResponseWriter, r *http.Request) {
	var req execRunReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := validateExecArgv(req.Argv); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Stdin) > execMaxStdinBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, errors.New("stdin 过长（上限 1MB）"))
		return
	}

	if req.Credentials != "" {
		writeErr(w, http.StatusBadRequest,
			errors.New("credentials 已移除，请改用 hosts/credential 取回凭据后自行使用"))
		return
	}

	spec, ok := a.newExecSpec(w, r, req)
	if !ok {
		return
	}

	if req.Background {
		if !spec.Local {
			writeErr(w, http.StatusBadRequest, errors.New("后台执行仅支持本机（host 留空）"))
			return
		}
		res, err := a.startBackground(spec.Argv, spec.Cwd, spec.Elevated)
		if err != nil {
			writeOpErr(w, err)
			return
		}
		writeJSON(w, res)
		return
	}

	out, err := a.execRun(spec)
	out, truncated := execTrim(out, execMaxOutputBytes)
	if err == nil {
		writeJSON(w, execRunResp{
			OK: true, Output: out, Error: "", Exit: 0, Truncated: truncated,
		})
		return
	}
	if execRan(err) {
		writeJSON(w, execRunResp{
			OK: false, Output: out, Error: execErrText(out, err), Exit: execExitCode(err),
			Truncated: truncated,
		})
		return
	}
	if isExecTimeout(err) {
		writeErr(w, http.StatusRequestTimeout, err)
		return
	}
	writeOpErr(w, err)
}

func (a *Gateway) handleExecStream(w http.ResponseWriter, r *http.Request) {
	var req execRunReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := validateExecArgv(req.Argv); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Stdin) > execMaxStdinBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, errors.New("stdin 过长（上限 1MB）"))
		return
	}
	if req.Background {
		writeErr(w, http.StatusBadRequest, errors.New("流式执行不支持 background"))
		return
	}
	if req.Credentials != "" {
		writeErr(w, http.StatusBadRequest, errors.New("credentials 已移除，请改用 hosts/credential"))
		return
	}
	spec, ok := a.newExecSpec(w, r, req)
	if !ok {
		return
	}
	a.execStream(w, r, spec)
}

func (a *Gateway) handleExecStatus(w http.ResponseWriter, r *http.Request) {
	if !a.requireLocalExecPerm(w, r) {
		return
	}
	p := a.lookupBackground(r.URL.Query().Get("id"))
	if p == nil {
		writeJSON(w, execGoneResp{Gone: true, Running: false})
		return
	}
	writeJSON(w, p.snapshot())
}

func (a *Gateway) handleExecKill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id required"))
		return
	}
	if !a.requireLocalExecPerm(w, r) {
		return
	}
	p := a.lookupBackground(req.ID)
	if p == nil {
		writeJSON(w, execKillResp{OK: true, Gone: true})
		return
	}
	a.dropBackground(req.ID)
	p.kill()
	a.log.Info("background exec killed", "id", req.ID, "pid", p.PID)
	writeJSON(w, okResp{OK: true})
}

func validateExecArgv(argv []string) error {
	if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		return errors.New("argv 不能为空")
	}
	n := 0
	for _, a := range argv {
		if strings.ContainsRune(a, 0) {
			return errors.New("argv 含非法字符")
		}
		n += len(a)
	}
	if n > execMaxArgvBytes {
		return errors.New("命令过长（上限 256KB）")
	}
	return nil
}

func execShellCmd(argv []string, cwd string) string {
	var b strings.Builder
	if cwd != "" {
		b.WriteString("cd -- ")
		b.WriteString(shellQuote(cwd))
		b.WriteString(" && ")
	}
	b.WriteString(`export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH" &&`)
	for _, a := range argv {
		b.WriteByte(' ')
		b.WriteString(shellQuote(a))
	}
	return b.String()
}

type execSpec struct {
	Host     string
	Argv     []string
	Cwd      string
	Stdin    string
	Elevated bool
	Timeout  time.Duration
	Local    bool
}

func timeoutSeconds(sec int, def, max time.Duration) time.Duration {
	if sec <= 0 {
		return def
	}
	if max > 0 && time.Duration(sec) > max/time.Second {
		return max
	}
	return time.Duration(sec) * time.Second
}

func (a *Gateway) newExecSpec(w http.ResponseWriter, r *http.Request, req execRunReq) (execSpec, bool) {
	timeout := timeoutSeconds(req.Timeout, execDefaultTimeout, execMaxTimeout)
	if !a.requireExecPerm(w, r, req.Host) {
		return execSpec{}, false
	}
	return execSpec{
		Host:     req.Host,
		Argv:     req.Argv,
		Cwd:      req.Cwd,
		Stdin:    req.Stdin,
		Elevated: req.Elevated,
		Timeout:  timeout,
		Local:    req.Host == "",
	}, true
}

func (a *Gateway) sudoPrefix(host string, elevated bool) (prefix, stdinInit string) {
	if !elevated {
		return "", ""
	}
	if pw := a.sudoPassword(host); pw != "" {
		return "sudo -S -p '' ", pw + "\n"
	}

	return "sudo -n ", ""
}

func (a *Gateway) execWrapSudo(host string, elevated bool, cmd, stdin string) (string, string) {
	pre, pw := a.sudoPrefix(host, elevated)
	if pre == "" {
		return cmd, stdin
	}
	return pre + "sh -c " + shellQuote(cmd), pw + stdin
}

func (a *Gateway) remoteCommand(s execSpec) (cmd string, stdin string) {
	return a.execWrapSudo(s.Host, s.Elevated, execShellCmd(s.Argv, s.Cwd), s.Stdin)
}

func execLocalCmd(ctx context.Context, argv []string, elevated bool) *exec.Cmd {
	if elevated {
		return exec.CommandContext(ctx, "sudo", append([]string{"-n"}, argv...)...)
	}
	return exec.CommandContext(ctx, argv[0], argv[1:]...)
}

func (a *Gateway) execRun(s execSpec) (string, error) {
	if s.Local {
		return a.execRunLocal(s)
	}
	return a.execRunRemote(s)
}

func (a *Gateway) execRunRemote(s execSpec) (string, error) {
	client, err := a.mgr.Get(s.Host)
	if err != nil {
		return "", err
	}
	cmd, in := a.remoteCommand(s)
	return runSSHCmdStrict(client, cmd, in, s.Timeout)
}

func (a *Gateway) execRunLocal(s execSpec) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), s.Timeout)
	defer cancel()
	cmd := execLocalCmd(ctx, s.Argv, s.Elevated)
	cmd.Dir = s.Cwd
	if s.Stdin != "" {
		cmd.Stdin = strings.NewReader(s.Stdin)
	}
	cw := &capWriter{max: execOutputHardCap, onFull: cancel}
	cmd.Stdout = cw
	cmd.Stderr = cw
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return cw.String(), errors.New("timeout")
	}
	return cw.String(), err
}

type capWriter struct {
	mu        sync.Mutex
	buf       []byte
	max       int
	truncated bool
	once      sync.Once
	onFull    func()
}

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	if room := w.max - len(w.buf); room > 0 {
		if room >= len(p) {
			w.buf = append(w.buf, p...)
		} else {
			w.buf = append(w.buf, p[:room]...)
			w.truncated = true
		}
	} else {
		w.truncated = true
	}
	full := w.truncated
	w.mu.Unlock()
	if full && w.onFull != nil {
		w.once.Do(func() { go w.onFull() })
	}
	return len(p), nil
}

func (w *capWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.buf)
}

func execRan(err error) bool {
	if err == nil {
		return true
	}
	var ee *ssh.ExitError
	if errors.As(err, &ee) {
		return true
	}
	var xe *exec.ExitError
	return errors.As(err, &xe)
}

func execExitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *ssh.ExitError
	if errors.As(err, &ee) {
		return ee.ExitStatus()
	}
	var xe *exec.ExitError
	if errors.As(err, &xe) {
		return xe.ExitCode()
	}
	return -1
}

func isExecTimeout(err error) bool {
	return err != nil && (errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errSSHTimeout))
}

func execErrText(out string, err error) string {
	if msg := strings.TrimSpace(out); msg != "" {
		return firstLine(msg)
	}
	return err.Error()
}

func execTrim(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	for max > 0 && !utf8.ValidString(s[:max]) {
		max--
	}
	return s[:max] + "\n…（输出已截断）", true
}

func (a *Gateway) execStream(w http.ResponseWriter, r *http.Request, s execSpec) {

	release, ok := a.acquireWSSlot(w)
	if !ok {
		return
	}
	defer release()
	if s.Local {
		ctx, cancel := context.WithTimeout(r.Context(), execStreamTimeout)
		defer cancel()
		cmd := execLocalCmd(ctx, s.Argv, s.Elevated)
		cmd.Dir = s.Cwd
		if s.Stdin != "" {
			cmd.Stdin = strings.NewReader(s.Stdin)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			writeOpErr(w, err)
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			writeOpErr(w, err)
			return
		}
		if err := cmd.Start(); err != nil {
			writeOpErr(w, err)
			return
		}
		defer func() { _ = cmd.Wait() }()
		a.pumpExecStream(w, r, stdout, stderr)
		return
	}

	client, err := a.mgr.Get(s.Host)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	sess, err := client.NewSession()
	if err != nil {
		a.mgr.Invalidate(s.Host)
		writeOpErr(w, err)
		return
	}
	defer sess.Close()
	cmd, in := a.remoteCommand(s)
	if in != "" {
		sess.Stdin = strings.NewReader(in)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		writeOpErr(w, err)
		return
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		writeOpErr(w, err)
		return
	}
	if err := sess.Start(cmd); err != nil {
		writeOpErr(w, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), execStreamTimeout)
	defer cancel()
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = sess.Close()
		case <-done:
		}
	}()
	a.pumpExecStream(w, r, stdout, stderr)
	close(done)
}

type syncWriter struct {
	mu sync.Mutex
	w  http.ResponseWriter
	f  http.Flusher
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.w.Write(p)
	if s.f != nil && n > 0 {
		s.f.Flush()
	}
	return n, err
}

func (a *Gateway) pumpExecStream(w http.ResponseWriter, r *http.Request, stdout, stderr io.Reader) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	sw := &syncWriter{w: w, f: flusher}
	pump := func(rc io.Reader) {
		buf := make([]byte, 16*1024)
		for {
			n, rerr := rc.Read(buf)
			if n > 0 {
				if _, werr := sw.Write(buf[:n]); werr != nil {
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pump(stdout) }()
	go func() { defer wg.Done(); pump(stderr) }()
	wg.Wait()
}

type bgProc struct {
	ID      string
	PID     int
	Argv    []string
	Started time.Time

	mu       sync.Mutex
	buf      bytes.Buffer
	exit     int
	errTxt   string
	finished bool
	done     chan struct{}
}

func (p *bgProc) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if rest := execBGErrCap - p.buf.Len(); rest > 0 {
		if len(b) > rest {
			b = b[:rest]
		}
		_, _ = p.buf.Write(b)
	}
	return len(b), nil
}

func (p *bgProc) snapshot() bgSnapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := bgSnapshot{
		ID:      p.ID,
		PID:     p.PID,
		Running: !p.finished,
		Argv:    p.Argv,
	}
	if p.finished {
		exit := p.exit
		out.Exit = &exit
		if s := p.buf.String(); s != "" {
			out.Output = &s
		}
		if p.errTxt != "" {
			errTxt := p.errTxt
			out.Error = &errTxt
		}
	}
	return out
}

func (p *bgProc) kill() {
	p.mu.Lock()
	running := !p.finished
	p.mu.Unlock()
	if running && p.PID > 0 {
		if proc, err := os.FindProcess(p.PID); err == nil {
			_ = proc.Kill()
		}
	}
}

func (a *Gateway) startBackground(argv []string, cwd string, elevated bool) (bgStartResp, error) {
	a.bgMu.Lock()
	running := 0
	for _, p := range a.bgProcs {
		p.mu.Lock()
		if !p.finished {
			running++
		}
		p.mu.Unlock()
	}
	if running >= execBgMax {
		a.bgMu.Unlock()
		return bgStartResp{}, errors.New("后台进程数量已达上限，请先停止不再使用的后台进程")
	}
	a.bgSeq++
	id := fmt.Sprintf("bg%d", a.bgSeq)
	a.bgMu.Unlock()

	cmd := execLocalCmd(context.Background(), argv, elevated)
	cmd.Dir = cwd
	p := &bgProc{ID: id, Argv: argv, Started: time.Now(), done: make(chan struct{})}
	cmd.Stdout, cmd.Stderr = p, p
	if err := cmd.Start(); err != nil {
		return bgStartResp{}, err
	}
	p.PID = cmd.Process.Pid

	a.bgMu.Lock()
	a.bgProcs[id] = p
	a.pruneBackgroundLocked()
	a.bgMu.Unlock()

	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.exit = execExitCode(err)
		if err != nil && p.exit < 0 {
			p.errTxt = err.Error()
		}
		p.finished = true
		p.mu.Unlock()
		close(p.done)
		a.log.Debug("background exec exited", "id", id, "pid", p.PID, "exit", p.exit)
	}()

	select {
	case <-p.done:
		return bgStartResp{OK: p.exit == 0, bgSnapshot: p.snapshot()}, nil
	case <-time.After(execGracePeriod):
		a.log.Info("background exec started", "id", id, "pid", p.PID, "argv", strings.Join(argv, " "))
		return bgStartResp{OK: true, bgSnapshot: bgSnapshot{ID: id, PID: p.PID, Running: true}}, nil
	}
}

func (a *Gateway) lookupBackground(id string) *bgProc {
	if id == "" {
		return nil
	}
	a.bgMu.Lock()
	defer a.bgMu.Unlock()
	return a.bgProcs[id]
}

func (a *Gateway) dropBackground(id string) {
	a.bgMu.Lock()
	delete(a.bgProcs, id)
	a.bgMu.Unlock()
}

func (a *Gateway) pruneBackgroundLocked() {
	exited := make([]*bgProc, 0, len(a.bgProcs))
	for _, p := range a.bgProcs {
		p.mu.Lock()
		if p.finished {
			exited = append(exited, p)
		}
		p.mu.Unlock()
	}
	if len(exited) <= execBGKeepExited {
		return
	}
	sort.Slice(exited, func(i, j int) bool { return exited[i].Started.Before(exited[j].Started) })
	for i := 0; i < len(exited)-execBGKeepExited; i++ {
		delete(a.bgProcs, exited[i].ID)
	}
}

func (a *Gateway) closeBackground() {
	a.closeNetHTTPTransports()
	a.closeSftpClients()
	if a.sched != nil {
		a.sched.close()
	}
	a.audit.close()

	a.bgMu.Lock()
	procs := make([]*bgProc, 0, len(a.bgProcs))
	for _, p := range a.bgProcs {
		procs = append(procs, p)
	}
	a.bgProcs = map[string]*bgProc{}
	a.bgMu.Unlock()
	killed := 0
	for _, p := range procs {
		p.kill()
		killed++
	}
	if killed > 0 {
		a.log.Info("background exec stopped", "count", killed)
	}
}
