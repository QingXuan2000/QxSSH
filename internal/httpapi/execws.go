package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os/exec"
	"sync"
)

func (a *Gateway) serveExecWS(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	var argv []string
	if raw := r.URL.Query().Get("argv"); raw == "" {
		a.execWsFail(w, r, "缺少 argv 参数")
		return
	} else if err := json.Unmarshal([]byte(raw), &argv); err != nil {
		a.execWsFail(w, r, "argv 参数无效")
		return
	}
	if err := validateExecArgv(argv); err != nil {
		a.execWsFail(w, r, err.Error())
		return
	}

	spec, ok := a.newExecSpec(w, r, execRunReq{
		Host:     host,
		Argv:     argv,
		Cwd:      r.URL.Query().Get("cwd"),
		Stdin:    "",
		Elevated: r.URL.Query().Get("elevated") == "1",
		Timeout:  0,
	})
	if !ok {
		return
	}

	if spec.Local {
		cmd := execLocalCmd(context.Background(), spec.Argv, spec.Elevated)
		cmd.Dir = spec.Cwd
		a.serveLocalExecWS(w, r, cmd)
		return
	}

	cmd, stdinInit := a.remoteCommand(spec)
	a.serveSessionWS(w, r, spec.Host, cmd, "", stdinInit)
}

func (a *Gateway) serveLocalExecWS(w http.ResponseWriter, r *http.Request, cmd *exec.Cmd) {

	release, ok := a.acquireWSSlot(w)
	if !ok {
		return
	}
	defer release()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		a.execWsFail(w, r, "exec: "+err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.execWsFail(w, r, "exec: "+err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		a.execWsFail(w, r, "exec: "+err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		a.execWsFail(w, r, "exec: "+err.Error())
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		a.log.Error("exec ws upgrade failed", "error", err.Error())
		return
	}
	reaped := false
	defer func() {
		if !reaped {
			_ = stdin.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}()
	wr := &wsWriter{c: conn}
	conn.SetReadLimit(1 << 20)

	var goneOnce sync.Once
	gone := make(chan struct{})
	shutdown := func() {
		goneOnce.Do(func() {
			_ = stdin.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			close(gone)
		})
	}

	var pumps sync.WaitGroup
	pumps.Add(2)
	pump := func(rd io.Reader) {
		defer pumps.Done()
		wsPump(wr, rd, shutdown, nil)
	}
	go pump(stdout)
	go pump(stderr)

	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				shutdown()
				return
			}
			var msg inMsg
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			if msg.T == "in" {
				if _, err := io.WriteString(stdin, msg.D); err != nil {
					shutdown()
					return
				}
			}
		}
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	select {
	case werr := <-waitCh:
		reaped = true
		pumps.Wait()
		code := 0
		if ee, ok := werr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if werr != nil {
			code = -1
		}
		_ = wr.json(outMsg{T: "exit", Code: code})
		_ = conn.Close()
	case <-gone:
		<-waitCh
	}
}

func (a *Gateway) execWsFail(w http.ResponseWriter, r *http.Request, msg string) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		a.log.Warn("exec ws upgrade failed", "error", err.Error())
		return
	}
	_ = (&wsWriter{c: conn}).json(outMsg{T: "err", M: msg})
	_ = conn.Close()
}
