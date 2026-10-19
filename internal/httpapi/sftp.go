package httpapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type fileInfo struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"modTime"`
	IsDir   bool      `json:"isDir"`
	UID     uint32    `json:"uid,omitempty"`
	GID     uint32    `json:"gid,omitempty"`
}

func elevatedFromQuery(r *http.Request) bool {
	v := r.URL.Query().Get("elevated")
	return v == "1" || v == "true"
}

const elevatedProbe = `U=$(id -u 2>/dev/null || echo -1)
echo "uid=$U"
SY=$(uname -s 2>/dev/null)
echo "uname=$SY"
SUDO=""
for c in /usr/bin/sudo /bin/sudo /usr/sbin/sudo /usr/local/bin/sudo; do
  if [ -x "$c" ]; then SUDO="$c"; break; fi
done
if [ -z "$SUDO" ]; then SUDO=$(command -v sudo 2>/dev/null); fi
echo "sudo=$SUDO"
REAL=1
case "$SY" in MINGW*|MSYS*|CYGWIN*) REAL=0 ;; esac
case "$SUDO" in
  "") REAL=0 ;;
  *.exe|*.EXE) REAL=0 ;;
  /c/*|/mnt/[A-Za-z]/*|/cygdrive/*) REAL=0 ;;
  *[Ww]indows*|*[Ss]ystem32*) REAL=0 ;;
  /*) ;;
  *) REAL=0 ;;
esac
echo "sudoreal=$REAL"
SRV=""
for p in "$(command -v sftp-server 2>/dev/null)" /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/local/libexec/sftp-server; do
  if [ -n "$p" ] && [ -x "$p" ]; then SRV="$p"; break; fi
done
echo "server=$SRV"
if [ "$U" = "0" ]; then
  echo "nopass=1"
elif [ -n "$SRV" ] && [ -n "$SUDO" ] && "$SUDO" -n -l "$SRV" >/dev/null 2>&1; then
  echo "nopass=1"
else
  echo "nopass=0"
fi`

type elevatedInfo struct {
	UID      int
	Uname    string
	SudoBin  string
	SudoReal bool
	Server   string
	Nopass   bool
}

func probeElevated(client *ssh.Client) (elevatedInfo, error) {
	out, err := runSSHCmd(client, elevatedProbe)
	if err != nil {
		return elevatedInfo{}, fmt.Errorf("探测远端提权条件失败：%w", err)
	}
	var info elevatedInfo
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "uid":
			info.UID, _ = strconv.Atoi(v)
		case "uname":
			info.Uname = v
		case "sudo":
			info.SudoBin = v
		case "sudoreal":
			info.SudoReal = v == "1"
		case "server":
			info.Server = v
		case "nopass":
			info.Nopass = v == "1"
		}
	}
	return info, nil
}

func (info elevatedInfo) notUnixSudoError() error {
	uname := info.Uname
	if uname == "" {
		uname = "未知"
	}
	path := info.SudoBin
	if path == "" {
		path = "未找到"
	}
	extra := ""
	switch up := strings.ToUpper(uname); {
	case strings.Contains(up, "MINGW") || strings.Contains(up, "MSYS"):
		extra = "；该主机是 Windows 上的 Git Bash/MSYS 环境"
	case strings.Contains(up, "CYGWIN"):
		extra = "；该主机是 Windows 上的 Cygwin 环境"
	case strings.Contains(up, "BSD") || strings.Contains(up, "DARWIN"):
		extra = "；该主机不是 Linux，sudo 行为可能不同"
	}
	return fmt.Errorf("远端不支持管理员模式：解析到的 sudo 是 %s，不是 Unix sudo（uname=%s%s）",
		path, uname, extra)
}

var errElevSession = errors.New("无法建立管理员会话（sudo 凭据可能已失效，请重新输入密码）")

type handshakeGuard struct {
	pr    *io.PipeReader
	timer *time.Timer
}

func newHandshakeGuard(r io.Reader, d time.Duration) *handshakeGuard {
	pr, pw := io.Pipe()
	g := &handshakeGuard{pr: pr}
	go func() { _, err := io.Copy(pw, r); _ = pw.CloseWithError(err) }()
	g.timer = time.AfterFunc(d, func() {
		_ = pw.CloseWithError(errors.New("远端 sftp-server 握手超时"))
	})
	return g
}

func (g *handshakeGuard) Read(p []byte) (int, error) { return g.pr.Read(p) }
func (g *handshakeGuard) disarm()                    { g.timer.Stop() }

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func elevatedAttempts(info elevatedInfo, password string) ([]string, error) {
	if info.Server == "" {
		return nil, errors.New("远端未找到 sftp-server（该 OpenSSH 可能未安装此组件）")
	}
	if info.UID != 0 && !info.SudoReal {
		return nil, info.notUnixSudoError()
	}
	server := shellQuote(info.Server)
	sudo := shellQuote(info.SudoBin)
	switch {
	case info.UID == 0:
		return []string{server}, nil
	case info.Nopass:
		return []string{sudo + " -n -p '' " + server}, nil
	case password == "":
		return nil, errors.New("远端 sudo 需要密码，请先输入 sudo 密码")
	}
	return []string{
		sudo + " -S -p '' " + server,
		sudo + " -S -p '' -v >/dev/null 2>&1 && " + sudo + " -n -p '' " + server + "; :",
	}, nil
}

func tryElevated(client *ssh.Client, command, password string) (*sftp.Client, func(), string) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, nil, err.Error()
	}
	errBuf := &syncBuf{}
	sess.Stderr = errBuf
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return nil, nil, err.Error()
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return nil, nil, err.Error()
	}
	if err := sess.Start(command); err != nil {
		_ = sess.Close()
		return nil, nil, "启动管理员 sftp-server 失败：" + err.Error()
	}
	if password != "" {
		if _, err := io.WriteString(stdin, password+"\n"); err != nil {
			_ = sess.Close()
			return nil, nil, "写入 sudo 密码失败：" + err.Error()
		}
	}
	guard := newHandshakeGuard(stdout, 15*time.Second)
	sc, err := sftp.NewClientPipe(guard, stdin)
	guard.disarm()
	if err != nil {
		_ = sess.Close()
		detail := strings.TrimSpace(errBuf.String())
		if detail != "" {
			return nil, nil, firstLine(detail)
		}
		return nil, nil, err.Error()
	}
	return sc, func() { _ = sc.Close(); _ = sess.Close() }, ""
}

func elevatedClient(client *ssh.Client, info elevatedInfo, password string) (*sftp.Client, func(), error) {
	attempts, err := elevatedAttempts(info, password)
	if err != nil {
		return nil, nil, err
	}
	needPassword := info.UID != 0 && !info.Nopass

	detail := ""
	for _, command := range attempts {
		sc, done, d := tryElevated(client, command, password)
		if d == "" {
			return sc, done, nil
		}
		detail = d
	}
	env := fmt.Sprintf("uname=%s, uid=%d, sudo=%s, server=%s",
		orDash(info.Uname), info.UID, orDash(info.SudoBin), orDash(info.Server))
	if needPassword {
		return nil, nil, fmt.Errorf("%w：%s（环境：%s）", errElevSession, detail, env)
	}
	return nil, nil, fmt.Errorf("%s（环境：%s）", detail, env)
}

type (
	sftpPathReq struct {
		Host     string `json:"host"`
		Path     string `json:"path"`
		Elevated bool   `json:"elevated"`
	}

	sftpMoveReq struct {
		Host     string `json:"host"`
		From     string `json:"from"`
		To       string `json:"to"`
		Elevated bool   `json:"elevated"`
	}

	sftpRemoveReq struct {
		sftpPathReq
		Recursive bool `json:"recursive"`
	}
)

func (a *Gateway) sftpWith(w http.ResponseWriter, r *http.Request, req any) (*sftp.Client, func(), bool) {
	if err := decodeJSON(r, req); err != nil {
		writeOpErr(w, err)
		return nil, nil, false
	}
	host, elevated := sftpTarget(req)
	sc, done, err := a.sftpClient(host, elevated)
	if err != nil {
		writeOpErr(w, err)
		return nil, nil, false
	}
	return sc, done, true
}

func sftpTarget(req any) (host string, elevated bool) {
	switch v := req.(type) {
	case *sftpPathReq:
		return v.Host, v.Elevated
	case *sftpMoveReq:
		return v.Host, v.Elevated
	case *sftpRemoveReq:
		return v.Host, v.Elevated
	default:
		panic(fmt.Sprintf("sftpWith: 不认识的请求类型 %T", req))
	}
}

const (
	sftpSharedLifetime = 10 * time.Minute
	elevInfoTTL        = 5 * time.Minute
)

type sftpShared struct {
	parent *ssh.Client
	sc     *sftp.Client
	at     time.Time
}

type elevCacheEntry struct {
	info elevatedInfo
	at   time.Time
}

func (a *Gateway) dropHostCache(hostID string) {
	a.sftpMu.Lock()
	sh, ok := a.sftpClients[hostID]
	if ok {
		delete(a.sftpClients, hostID)
	}
	a.sftpMu.Unlock()
	if ok {
		go func() { _ = sh.sc.Close() }()
	}

	a.elevMu.Lock()
	delete(a.elevInfo, hostID)
	a.elevMu.Unlock()
}

func (a *Gateway) closeSftpClients() {
	a.sftpMu.Lock()
	all := a.sftpClients
	a.sftpClients = map[string]*sftpShared{}
	a.sftpMu.Unlock()
	for _, sh := range all {
		_ = sh.sc.Close()
	}
}

func sftpLinkAlive(sc *sftp.Client) bool {
	_, err := sc.Stat(".")
	if err == nil {
		return true
	}
	var serr *sftp.StatusError
	return errors.As(err, &serr)
}

func (a *Gateway) sharedSftp(hostID string, sshClient *ssh.Client) (*sftp.Client, error) {
	now := time.Now()
	a.sftpMu.Lock()
	if sh, ok := a.sftpClients[hostID]; ok {
		if sh.parent == sshClient && now.Sub(sh.at) <= sftpSharedLifetime {
			a.sftpMu.Unlock()
			if sftpLinkAlive(sh.sc) {
				return sh.sc, nil
			}
			a.sftpMu.Lock()
			if cur, ok := a.sftpClients[hostID]; ok && cur == sh {
				delete(a.sftpClients, hostID)
			}
			a.sftpMu.Unlock()
			go func() { _ = sh.sc.Close() }()
			return a.sharedSftp(hostID, sshClient)
		}
		delete(a.sftpClients, hostID)
		a.sftpMu.Unlock()
		go func() { _ = sh.sc.Close() }()
	} else {
		a.sftpMu.Unlock()
	}

	sc, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, err
	}
	sh := &sftpShared{parent: sshClient, sc: sc, at: time.Now()}
	a.sftpMu.Lock()
	if prev, dup := a.sftpClients[hostID]; dup {
		a.sftpMu.Unlock()
		_ = sc.Close()
		return prev.sc, nil
	}
	a.sftpClients[hostID] = sh
	a.sftpMu.Unlock()
	return sc, nil
}

func (a *Gateway) elevatedInfoFor(hostID string, sshClient *ssh.Client) (elevatedInfo, error) {
	a.elevMu.Lock()
	e, ok := a.elevInfo[hostID]
	a.elevMu.Unlock()
	if ok && time.Since(e.at) <= elevInfoTTL {
		return e.info, nil
	}
	info, err := probeElevated(sshClient)
	if err != nil {
		return elevatedInfo{}, err
	}
	a.cacheElevatedInfo(hostID, info)
	return info, nil
}

func (a *Gateway) cacheElevatedInfo(hostID string, info elevatedInfo) {
	if hostID == "" {
		return
	}
	a.elevMu.Lock()
	a.elevInfo[hostID] = elevCacheEntry{info: info, at: time.Now()}
	a.elevMu.Unlock()
}

func (a *Gateway) sftpClient(hostID string, elevated bool) (*sftp.Client, func(), error) {
	sshClient, err := a.mgr.Get(hostID)
	if err != nil {
		return nil, nil, err
	}
	if elevated {
		pw := a.sudoPassword(hostID)
		info, err := a.elevatedInfoFor(hostID, sshClient)
		if err != nil {
			a.log.Warn("sudo elevate probe failed", "host", hostID, "error", err.Error())
			return nil, nil, fmt.Errorf("管理员模式：%w", err)
		}
		sc, done, err := elevatedClient(sshClient, info, pw)
		if err != nil {
			if pw != "" && errors.Is(err, errElevSession) {
				a.clearSudoPassword(hostID)
			}
			a.log.Warn("sudo elevated session failed", "host", hostID, "error", err.Error())
			return nil, nil, fmt.Errorf("管理员模式：%w", err)
		}
		return sc, done, nil
	}
	sc, err := a.sharedSftp(hostID, sshClient)
	if err != nil {
		a.mgr.Invalidate(hostID)
		return nil, nil, fmt.Errorf("sftp: %w", err)
	}
	return sc, func() {}, nil
}

func cleanPath(p string) string {
	if p == "" {
		return "."
	}
	p = strings.ReplaceAll(p, "\\", "/")
	if !strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "~") {
		p = "/" + p
	}
	return path.Clean(p)
}

func (a *Gateway) handleSftpList(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("host")
	p := cleanPath(r.URL.Query().Get("path"))
	sc, done, err := a.sftpClient(hostID, elevatedFromQuery(r))
	if err != nil {
		writeOpErr(w, err)
		return
	}
	defer done()

	if p == "/~" || p == "~" {
		if home, err := sc.Getwd(); err == nil {
			p = home
		}
	}
	entries, err := sc.ReadDir(p)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	dirs := make([]fileInfo, 0, len(entries))
	var rest []fileInfo
	for _, e := range entries {
		fi := fileInfo{
			Name:    e.Name(),
			Size:    e.Size(),
			Mode:    e.Mode().String(),
			ModTime: e.ModTime(),
			IsDir:   e.IsDir(),
		}

		if st, ok := e.Sys().(*sftp.FileStat); ok {
			fi.UID, fi.GID = st.UID, st.GID
		}
		if e.IsDir() {
			dirs = append(dirs, fi)
		} else {
			rest = append(rest, fi)
		}
	}
	files := append(dirs, rest...)
	writeJSON(w, sftpListResp{Path: p, Files: files})
}

func (a *Gateway) handleSftpMkdir(w http.ResponseWriter, r *http.Request) {
	var req sftpPathReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()
	if err := sc.MkdirAll(cleanPath(req.Path)); err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSftpRemove(w http.ResponseWriter, r *http.Request) {
	var req sftpRemoveReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()
	p := cleanPath(req.Path)
	if p == "/" {
		writeOpErr(w, errors.New("refusing to remove /"))
		return
	}
	var err error
	if req.Recursive {
		err = removeRecursive(sc, p)
	} else {
		err = sc.Remove(p)
	}
	if err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func removeRecursive(sc *sftp.Client, p string) error {
	fi, err := sc.Stat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return sc.Remove(p)
	}
	entries, err := sc.ReadDir(p)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := removeRecursive(sc, path.Join(p, e.Name())); err != nil {
			return err
		}
	}
	return sc.RemoveDirectory(p)
}

func (a *Gateway) handleSftpRename(w http.ResponseWriter, r *http.Request) {
	var req sftpMoveReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()
	if err := sc.Rename(cleanPath(req.From), cleanPath(req.To)); err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSftpDownload(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("host")
	p := cleanPath(r.URL.Query().Get("path"))
	sc, done, err := a.sftpClient(hostID, elevatedFromQuery(r))
	if err != nil {
		writeOpErr(w, err)
		return
	}
	defer done()

	fi, err := sc.Stat(p)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	if fi.IsDir() {
		archive := r.URL.Query().Get("archive")
		if archive == "" {
			archive = "tar.gz"
		}
		a.streamDirectoryArchive(w, sc, p, fi.Name(), archive)
		return
	}
	f, err := sc.Open(p)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	defer f.Close()

	name := path.Base(p)

	disp := "attachment"
	if r.URL.Query().Get("inline") == "1" {
		disp = "inline"
		if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disp, name))
	if fi.Size() > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	}
	_, _ = io.Copy(w, f)
}

func (a *Gateway) streamDirectoryArchive(w http.ResponseWriter, sc *sftp.Client, dirPath, dirName, format string) {
	if dirName == "" || dirName == "." || dirName == "/" {
		dirName = "archive"
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", dirName+".tar.gz"))

	gw := gzip.NewWriter(w)
	defer gw.Close()
	tw := tar.NewWriter(gw)
	defer tw.Close()

	var writeDir func(curPath, relPrefix string) error
	writeDir = func(curPath, relPrefix string) error {
		entries, err := sc.ReadDir(curPath)
		if err != nil {
			return err
		}
		for _, e := range entries {
			subPath := path.Join(curPath, e.Name())
			subRel := path.Join(relPrefix, e.Name())
			if e.IsDir() {
				hdr := &tar.Header{
					Name:     subRel + "/",
					Mode:     int64(e.Mode().Perm()),
					ModTime:  e.ModTime(),
					Typeflag: tar.TypeDir,
				}
				if err := tw.WriteHeader(hdr); err != nil {
					return err
				}
				if err := writeDir(subPath, subRel); err != nil {
					return err
				}
			} else {
				hdr := &tar.Header{
					Name:     subRel,
					Mode:     int64(e.Mode().Perm()),
					Size:     e.Size(),
					ModTime:  e.ModTime(),
					Typeflag: tar.TypeReg,
				}
				if err := tw.WriteHeader(hdr); err != nil {
					return err
				}
				f, err := sc.Open(subPath)
				if err != nil {
					continue
				}
				_, _ = io.Copy(tw, f)
				_ = f.Close()
			}
		}
		return nil
	}

	_ = tw.WriteHeader(&tar.Header{
		Name:     dirName + "/",
		Mode:     0o755,
		ModTime:  time.Now(),
		Typeflag: tar.TypeDir,
	})
	if err := writeDir(dirPath, dirName); err != nil {
		a.log.Warn("stream directory archive interrupted", "dir", dirPath, "error", err.Error())
	}
}

func copyPath(sc *sftp.Client, from, to string) error {
	fi, err := sc.Stat(from)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		if err := sc.MkdirAll(to); err != nil {
			return err
		}
		entries, err := sc.ReadDir(from)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyPath(sc, path.Join(from, e.Name()), path.Join(to, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	src, err := sc.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := sc.Create(to)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}

func (a *Gateway) handleSftpCopy(w http.ResponseWriter, r *http.Request) {
	var req sftpMoveReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()
	if err := copyPath(sc, cleanPath(req.From), cleanPath(req.To)); err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSftpMove(w http.ResponseWriter, r *http.Request) {
	var req sftpMoveReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()
	from, to := cleanPath(req.From), cleanPath(req.To)
	if err := sc.Rename(from, to); err == nil {
		writeJSON(w, okResp{OK: true})
		return
	}
	if err := copyPath(sc, from, to); err != nil {
		writeOpErr(w, err)
		return
	}
	if err := removeRecursive(sc, from); err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSftpUpload(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("host")
	dest := cleanPath(r.URL.Query().Get("path"))
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeOpErr(w, err)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeOpErr(w, errors.New("missing file field"))
		return
	}
	defer file.Close()

	sc, done, err := a.sftpClient(hostID, elevatedFromQuery(r))
	if err != nil {
		writeOpErr(w, err)
		return
	}
	defer done()

	target := dest
	if st, err := sc.Stat(dest); err == nil && st.IsDir() {

		name := path.Clean(hdr.Filename)
		if name == "." || name == ".." || strings.Contains(name, "/") {
			writeOpErr(w, errors.New("上传文件名非法"))
			return
		}
		target = path.Join(dest, name)
	}
	dst, err := sc.Create(target)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		writeOpErr(w, err)
		return
	}
	writeJSON(w, okPathResp{OK: true, Path: target})
}

type statResult struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	PermOct string    `json:"permOct,omitempty"`
	ModTime time.Time `json:"modTime"`
	IsDir   bool      `json:"isDir"`
	Symlink bool      `json:"symlink,omitempty"`
	LinkTo  string    `json:"linkTo,omitempty"`
	UID     uint32    `json:"uid,omitempty"`
	GID     uint32    `json:"gid,omitempty"`
	Owner   string    `json:"owner,omitempty"`
	Group   string    `json:"group,omitempty"`
	SELinux string    `json:"selinux,omitempty"`
	Note    string    `json:"note,omitempty"`
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func runSSHCmd(client *ssh.Client, cmd string) (string, error) {
	return runSSH(client, cmd, "", 10*time.Second, false)
}

func runSSHCmdIn(client *ssh.Client, cmd, in string, d time.Duration) (string, error) {
	return runSSH(client, cmd, in, d, false)
}

func runSSHCmdStrict(client *ssh.Client, cmd, in string, d time.Duration) (string, error) {
	return runSSH(client, cmd, in, d, true)
}

func runSSH(client *ssh.Client, cmd, in string, d time.Duration, strict bool) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	if in != "" {
		sess.Stdin = strings.NewReader(in)
	}

	cw := &capWriter{max: execOutputHardCap, onFull: func() {
		_ = sess.Signal(ssh.SIGKILL)
		_ = sess.Close()
	}}
	sess.Stdout = cw
	sess.Stderr = cw
	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()
	select {
	case e := <-done:
		if e != nil {
			if strict || strings.TrimSpace(cw.String()) == "" {
				return cw.String(), e
			}
		}
		return cw.String(), nil
	case <-time.After(d):
		_ = sess.Signal(ssh.SIGKILL)
		_ = sess.Close()

		return "", errSSHTimeout
	}
}

var errSSHTimeout = errors.New("远端命令超时")

func atoiU32(s string) uint32 {
	n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 32)
	if err != nil {
		return 0
	}
	return uint32(n)
}

var selinuxRe = regexp.MustCompile(`^[A-Za-z_][\w.-]*:[\w.-]+:[\w.-]+(:[\w.,:-]+)?$`)

func (a *Gateway) fillUnixAttrs(hostID, p string, res *statResult) {
	client, err := a.mgr.Get(hostID)
	if err != nil {
		res.Note = "无法读取详细属性：" + err.Error()
		return
	}
	q := shellQuote(p)

	out, _ := runSSHCmd(client, "LC_ALL=C stat -c '%U|%G|%u|%g|%a|%s|%F|%y|%C' -- "+q+" 2>/dev/null")
	f := strings.SplitN(strings.TrimSpace(firstLine(out)), "|", 9)
	if len(f) == 9 && strings.TrimSpace(f[0]) != "" {
		res.Owner = strings.TrimSpace(f[0])
		res.Group = strings.TrimSpace(f[1])
		res.UID, res.GID = atoiU32(f[2]), atoiU32(f[3])
		res.PermOct = strings.TrimSpace(f[4])
		if c := strings.TrimSpace(f[8]); c != "" && c != "?" {
			res.SELinux = c
		}
		return
	}

	for _, args := range []string{"ls -ldZ -- ", "ls -ld -- "} {
		o, _ := runSSHCmd(client, "LC_ALL=C "+args+q+" 2>/dev/null")
		line := strings.TrimSpace(firstLine(o))
		cols := strings.Fields(line)
		if len(cols) < 4 || len(cols[0]) < 10 {
			continue
		}
		res.Owner, res.Group = cols[2], cols[3]
		for i := 4; i < len(cols); i++ {
			if c := strings.TrimSuffix(cols[i], "."); selinuxRe.MatchString(c) {
				res.SELinux = c
				break
			}
		}
		return
	}
	res.Note = "该服务器不支持 stat / ls -l，仅显示基础属性"
}

func (a *Gateway) handleSftpStat(w http.ResponseWriter, r *http.Request) {
	var req sftpPathReq
	sc, done, ok := a.sftpWith(w, r, &req)
	if !ok {
		return
	}
	defer done()

	p := cleanPath(req.Path)
	fi, err := sc.Lstat(p)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	res := statResult{
		Name: path.Base(p), Path: p, Size: fi.Size(), Mode: fi.Mode().String(),
		ModTime: fi.ModTime(), IsDir: fi.IsDir(),
	}
	if st, ok := fi.Sys().(*sftp.FileStat); ok {
		res.UID, res.GID = st.UID, st.GID
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		res.Symlink = true
		if t, e := sc.ReadLink(p); e == nil {
			res.LinkTo = t
		}
		if tf, e := sc.Stat(p); e == nil {
			res.IsDir, res.Size = tf.IsDir(), tf.Size()
		}
	}
	a.fillUnixAttrs(req.Host, p, &res)
	writeJSON(w, res)
}

var (
	reOctalMode = regexp.MustCompile(`^[0-7]{3,4}$`)
	reOwnerName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,31}$`)
	reSelinux   = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_:\-.,]{1,127}$`)
)

type attrOp struct {
	Op    string `json:"op"`
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type sftpAttrsReq struct {
	Host      string `json:"host"`
	Path      string `json:"path"`
	Mode      string `json:"mode"`
	Owner     string `json:"owner"`
	Group     string `json:"group"`
	SELinux   string `json:"selinux"`
	Recursive bool   `json:"recursive"`
	Sudo      bool   `json:"sudo"`
	Elevated  bool   `json:"elevated"`
}

func (a *Gateway) handleSftpAttrs(w http.ResponseWriter, r *http.Request) {
	var req sftpAttrsReq
	if err := decodeJSON(r, &req); err != nil {
		writeOpErr(w, err)
		return
	}
	p := cleanPath(req.Path)
	if p == "/" {
		writeOpErr(w, errors.New("refusing to modify /"))
		return
	}
	if req.Mode == "" && req.Owner == "" && req.Group == "" && req.SELinux == "" {
		writeOpErr(w, errors.New("没有需要修改的属性"))
		return
	}

	if req.Mode != "" && !reOctalMode.MatchString(req.Mode) {
		writeOpErr(w, errors.New("非法权限值（应为 3-4 位八进制，如 644 / 0755）"))
		return
	}
	if req.Owner != "" && !reOwnerName.MatchString(req.Owner) {
		writeOpErr(w, errors.New("非法所有者（仅允许字母/数字/_.-）"))
		return
	}
	if req.Group != "" && !reOwnerName.MatchString(req.Group) {
		writeOpErr(w, errors.New("非法属组（仅允许字母/数字/_.-）"))
		return
	}
	if req.SELinux != "" && !reSelinux.MatchString(req.SELinux) {
		writeOpErr(w, errors.New("非法 SELinux 上下文"))
		return
	}

	client, err := a.mgr.Get(req.Host)
	if err != nil {
		writeOpErr(w, err)
		return
	}

	flag := ""
	if req.Recursive {
		flag = "-R "
	}

	pre, sudoIn := a.sudoPrefix(req.Host, req.Sudo || req.Elevated)
	quoted := shellQuote(p)

	type job struct{ op, cmd string }
	jobs := make([]job, 0, 3)
	if req.Mode != "" {
		jobs = append(jobs, job{"chmod", pre + "chmod " + flag + req.Mode + " -- " + quoted})
	}
	if req.Owner != "" || req.Group != "" {
		spec := req.Owner
		if req.Group != "" {
			spec = req.Owner + ":" + req.Group
		}
		jobs = append(jobs, job{"chown", pre + "chown " + flag + spec + " -- " + quoted})
	}
	if req.SELinux != "" {
		jobs = append(jobs, job{"chcon", pre + "chcon " + flag + shellQuote(req.SELinux) + " -- " + quoted})
	}

	results := make([]attrOp, 0, len(jobs))
	allOK := true
	for _, jb := range jobs {
		out, err := runSSHCmdIn(client, jb.cmd+" 2>&1", sudoIn, 60*time.Second)
		res := attrOp{Op: jb.op, Ok: true}
		switch {
		case err != nil:
			res.Ok, res.Error, allOK = false, err.Error(), false
		case strings.TrimSpace(out) != "":

			res.Ok, res.Error, allOK = false, firstLine(strings.TrimSpace(out)), false
		}
		results = append(results, res)
	}
	writeJSON(w, sftpAttrOpResp{OK: allOK, Results: results})
}
