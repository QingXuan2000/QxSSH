package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type cmdRunner interface {
	run(cmd string) (string, error)
}

var jobIDRe = regexp.MustCompile(`^j-[0-9a-f]{16}$`)

const (
	jobDirRel = ".qxssh/jobs"

	jobCmdTimeout = 15 * time.Second

	jobOutputMax     = 1 << 20
	jobOutputDefault = 256 << 10

	jobNameMax = 120
)

func newJobID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "j-" + hex.EncodeToString(b), nil
}

type jobMeta struct {
	ID        string   `json:"id"`
	Name      string   `json:"name,omitempty"`
	App       string   `json:"app,omitempty"`
	Argv      []string `json:"argv"`
	Cwd       string   `json:"cwd,omitempty"`
	StartedAt int64    `json:"startedAt"`
}

type jobStatus struct {
	ID        string   `json:"id"`
	Name      string   `json:"name,omitempty"`
	App       string   `json:"app,omitempty"`
	Argv      []string `json:"argv,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	Running   bool     `json:"running"`
	Exit      *int     `json:"exit"`
	Pid       int      `json:"pid"`
	StartedAt int64    `json:"startedAt"`
	EndedAt   int64    `json:"endedAt,omitempty"`
	Bytes     int64    `json:"bytes"`
}

func jobShellPrelude(id string) string {
	return `d="$HOME/` + jobDirRel + `/` + id + `"; `
}

func jobStartCmd(id string, meta jobMeta) (string, error) {
	mj, err := json.Marshal(meta)
	if err != nil {
		return "", err
	}
	inner := `echo $$ > "$QXD/pid"; ` + execShellCmd(meta.Argv, meta.Cwd) + `; e=$?; echo $e > "$QXD/exit"; date +%s > "$QXD/ended"; exit $e`
	var b strings.Builder
	b.WriteString(jobShellPrelude(id))
	b.WriteString(`umask 077; mkdir -p "$d" || exit 90; `)
	b.WriteString(`printf '%s' ` + shellQuote(string(mj)) + ` > "$d/meta.json"; `)
	b.WriteString(`date +%s > "$d/started"; : > "$d/out.log"; `)
	b.WriteString(`export QXD="$d"; `)
	b.WriteString(`if command -v setsid >/dev/null 2>&1; then setsid sh -c ` + shellQuote(inner) + ` </dev/null >"$d/out.log" 2>&1 & `)
	b.WriteString(`else nohup sh -c ` + shellQuote(inner) + ` </dev/null >"$d/out.log" 2>&1 & fi; `)

	b.WriteString(`i=0; while [ ! -s "$d/pid" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; cat "$d/pid" 2>/dev/null`)
	return b.String(), nil
}

func jobStatusCmd(id string) string {
	return jobShellPrelude(id) + `[ -d "$d" ] || { echo MISSING; exit 0; }; ` + jobStatusLine()
}

func jobStatusLine() string {
	return `pid=$(cat "$d/pid" 2>/dev/null); ex=$(cat "$d/exit" 2>/dev/null); ` +
		`if [ -n "$ex" ]; then run=0; elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then run=1; else run=0; fi; ` +
		`printf '%s %s %s %s %s %s\n' "$run" "${ex:--}" "$(cat "$d/started" 2>/dev/null || echo 0)" "$(cat "$d/ended" 2>/dev/null || echo 0)" "$(wc -c < "$d/out.log" 2>/dev/null | tr -d ' ' || echo 0)" "${pid:-0}"; ` +
		`cat "$d/meta.json" 2>/dev/null; echo`
}

func parseJobStatus(id, out string) (jobStatus, error) {
	out = strings.TrimSpace(out)
	if out == "" || out == "MISSING" {
		return jobStatus{}, fmt.Errorf("任务不存在：%s", id)
	}
	line, metaLine, _ := strings.Cut(out, "\n")
	f := strings.Fields(line)
	if len(f) < 6 {
		return jobStatus{}, fmt.Errorf("任务状态输出无法解析：%q", line)
	}
	st := jobStatus{ID: id}
	st.Running = f[0] == "1"
	if f[1] != "-" {
		if n, err := strconv.Atoi(f[1]); err == nil {
			st.Exit = &n
		}
	}
	st.StartedAt, _ = strconv.ParseInt(f[2], 10, 64)
	st.EndedAt, _ = strconv.ParseInt(f[3], 10, 64)
	st.Bytes, _ = strconv.ParseInt(f[4], 10, 64)
	st.Pid, _ = strconv.Atoi(f[5])
	var meta jobMeta
	if err := json.Unmarshal([]byte(strings.TrimSpace(metaLine)), &meta); err == nil {
		st.Name, st.App, st.Argv, st.Cwd = meta.Name, meta.App, meta.Argv, meta.Cwd
		if st.StartedAt == 0 {
			st.StartedAt = meta.StartedAt
		}
	}
	return st, nil
}

type jobStartReq struct {
	Host string   `json:"host"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
	Name string   `json:"name"`
}

func (a *Gateway) jobClient(w http.ResponseWriter, r *http.Request, host string) (cmdRunner, bool) {
	if host == "" {
		writeErr(w, http.StatusBadRequest, errors.New("job/* 只支持远端主机：host 必填（本机后台进程走 exec/run 的 background）"))
		return nil, false
	}
	if a.mgr == nil {
		writeErr(w, http.StatusInternalServerError, errors.New("ssh pool not initialized"))
		return nil, false
	}
	client, err := a.mgr.Get(host)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return nil, false
	}
	return sshRunner{client: client}, true
}

func (a *Gateway) startJob(run cmdRunner, app string, req jobStartReq) (jobStatus, error) {
	if err := validateExecArgv(req.Argv); err != nil {
		return jobStatus{}, err
	}
	id, err := newJobID()
	if err != nil {
		return jobStatus{}, err
	}
	name := strings.TrimSpace(req.Name)
	if len(name) > jobNameMax {
		name = name[:jobNameMax]
	}
	meta := jobMeta{ID: id, Name: name, App: app, Argv: req.Argv, Cwd: req.Cwd, StartedAt: time.Now().Unix()}
	cmd, err := jobStartCmd(id, meta)
	if err != nil {
		return jobStatus{}, err
	}
	out, err := run.run(cmd)
	if err != nil {
		return jobStatus{}, fmt.Errorf("起任务失败：%w", err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(out))
	if pid <= 0 {
		return jobStatus{}, errors.New("起任务失败：远端没有回 pid（目录不可写或 sh 不可用）")
	}
	return jobStatus{ID: id, Name: name, App: app, Argv: req.Argv, Cwd: req.Cwd, Running: true, Pid: pid, StartedAt: meta.StartedAt}, nil
}

func (a *Gateway) handleJobStart(w http.ResponseWriter, r *http.Request) {
	var req jobStartReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	run, ok := a.jobClient(w, r, req.Host)
	if !ok {
		return
	}
	st, err := a.startJob(run, callerApp(r), req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	a.log.Info("job started", "host", req.Host, "id", st.ID, "pid", st.Pid, "app", callerApp(r))
	writeJSON(w, st)
}

func jobIDParam(w http.ResponseWriter, id string) bool {
	if !jobIDRe.MatchString(id) {
		writeErr(w, http.StatusBadRequest, errors.New("任务 id 非法"))
		return false
	}
	return true
}

func (a *Gateway) handleJobStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !jobIDParam(w, id) {
		return
	}
	run, ok := a.jobClient(w, r, r.URL.Query().Get("host"))
	if !ok {
		return
	}
	out, err := run.run(jobStatusCmd(id))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	st, err := parseJobStatus(id, out)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, st)
}

func (a *Gateway) handleJobOutput(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	if !jobIDParam(w, id) {
		return
	}
	offset, _ := strconv.ParseInt(q.Get("offset"), 10, 64)
	if offset < 0 {
		offset = 0
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = jobOutputDefault
	}
	if limit > jobOutputMax {
		limit = jobOutputMax
	}
	run, ok := a.jobClient(w, r, q.Get("host"))
	if !ok {
		return
	}

	cmd := jobShellPrelude(id) + `[ -d "$d" ] || { echo MISSING; exit 0; }; ` +
		`sz=$(wc -c < "$d/out.log" 2>/dev/null | tr -d ' '); ex=$(cat "$d/exit" 2>/dev/null); ` +
		`echo "SIZE ${sz:-0} ${ex:--}"; tail -c +` + strconv.FormatInt(offset+1, 10) + ` "$d/out.log" 2>/dev/null | head -c ` + strconv.Itoa(limit)
	out, err := run.run(cmd)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	if strings.HasPrefix(out, "MISSING") {
		writeErr(w, http.StatusNotFound, fmt.Errorf("任务不存在：%s", id))
		return
	}
	head, data, _ := strings.Cut(out, "\n")
	f := strings.Fields(head)
	var size int64
	exited := false
	if len(f) >= 3 && f[0] == "SIZE" {
		size, _ = strconv.ParseInt(f[1], 10, 64)
		exited = f[2] != "-"
	}
	next := offset + int64(len(data))
	writeJSON(w, jobOutputResp{
		Data:   data,
		Offset: offset,
		Next:   next,
		Size:   size,
		Done:   exited && next >= size,
	})
}

func (a *Gateway) handleJobKill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host   string `json:"host"`
		ID     string `json:"id"`
		Signal string `json:"signal"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !jobIDParam(w, req.ID) {
		return
	}
	sig := "TERM"
	if strings.EqualFold(req.Signal, "KILL") {
		sig = "KILL"
	}
	run, ok := a.jobClient(w, r, req.Host)
	if !ok {
		return
	}
	cmd := jobShellPrelude(req.ID) + `pid=$(cat "$d/pid" 2>/dev/null); [ -n "$pid" ] || { echo NOPID; exit 0; }; ` +
		`kill -` + sig + ` -- -"$pid" 2>/dev/null || kill -` + sig + ` "$pid" 2>/dev/null; echo OK`
	out, err := run.run(cmd)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, okResp{OK: strings.Contains(out, "OK")})
}

func (a *Gateway) handleJobList(w http.ResponseWriter, r *http.Request) {
	run, ok := a.jobClient(w, r, r.URL.Query().Get("host"))
	if !ok {
		return
	}
	cmd := `root="$HOME/` + jobDirRel + `"; [ -d "$root" ] || exit 0; for d in "$root"/j-*/; do [ -d "$d" ] || continue; d=${d%/}; echo "JOB ${d##*/}"; ` + jobStatusLine() + `; done`
	out, err := run.run(cmd)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	jobs := make([]jobStatus, 0, 8)
	for _, chunk := range strings.Split(out, "JOB ") {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		id, rest, _ := strings.Cut(chunk, "\n")
		id = strings.TrimSpace(id)
		if !jobIDRe.MatchString(id) {
			continue
		}
		if st, err := parseJobStatus(id, rest); err == nil {
			jobs = append(jobs, st)
		}
	}

	for i, j := 0, len(jobs)-1; i < j; i, j = i+1, j-1 {
		jobs[i], jobs[j] = jobs[j], jobs[i]
	}
	writeJSON(w, jobsListResp{Jobs: jobs})
}

func (a *Gateway) handleJobRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
		ID   string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !jobIDParam(w, req.ID) {
		return
	}
	run, ok := a.jobClient(w, r, req.Host)
	if !ok {
		return
	}
	cmd := jobShellPrelude(req.ID) + `pid=$(cat "$d/pid" 2>/dev/null); [ -z "$pid" ] || [ -f "$d/exit" ] || kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; rm -rf -- "$d"; echo OK`
	if _, err := run.run(cmd); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

type sshRunner struct {
	client *ssh.Client
}

func (s sshRunner) run(cmd string) (string, error) {
	return runSSHCmdStrict(s.client, cmd, "", jobCmdTimeout)
}
