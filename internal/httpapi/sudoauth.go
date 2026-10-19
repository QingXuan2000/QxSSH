package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const sudoCredTTL = 30 * time.Minute

type sudoCred struct {
	pw string
	at time.Time
}

func (a *Gateway) sudoPassword(hostID string) string {
	a.sudoMu.Lock()
	defer a.sudoMu.Unlock()
	c, ok := a.sudoCreds[hostID]
	if !ok {
		return ""
	}
	if time.Since(c.at) > sudoCredTTL {
		delete(a.sudoCreds, hostID)
		return ""
	}
	return c.pw
}

func (a *Gateway) setSudoPassword(hostID, pw string) {
	a.sudoMu.Lock()
	defer a.sudoMu.Unlock()
	if a.sudoCreds == nil {
		a.sudoCreds = make(map[string]sudoCred)
	}
	a.sudoCreds[hostID] = sudoCred{pw: pw, at: time.Now()}
}

func (a *Gateway) clearSudoPassword(hostID string) {
	a.sudoMu.Lock()
	defer a.sudoMu.Unlock()
	if hostID == "" {
		a.sudoCreds = make(map[string]sudoCred)
		return
	}
	delete(a.sudoCreds, hostID)
}

type sudoAuthResult struct {
	OK       bool   `json:"ok"`
	Mode     string `json:"mode,omitempty"`
	Server   string `json:"server,omitempty"`
	NeedPass bool   `json:"needPass,omitempty"`
}

func (a *Gateway) handleSudoAuth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host     string `json:"host"`
		Password string `json:"password"`

		Submit bool `json:"submit"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if strings.ContainsAny(req.Password, "\r\n") {
		writeErr(w, http.StatusBadRequest, errors.New("密码不能包含换行符"))
		return
	}
	client, err := a.mgr.Get(req.Host)
	if err != nil {
		a.fail(w, req.Host, err)
		return
	}
	info, err := probeElevated(client)
	if err != nil {
		a.fail(w, req.Host, err)
		return
	}
	a.cacheElevatedInfo(req.Host, info)

	a.log.Debug("sudo probe", "host", req.Host, "uname", orDash(info.Uname), "uid", info.UID,
		"sudo", orDash(info.SudoBin), "sudoreal", info.SudoReal, "nopass", info.Nopass, "server", orDash(info.Server))

	if info.Server == "" {
		a.fail(w, req.Host, errors.New("远端未找到 sftp-server（该 OpenSSH 可能未安装此组件），无法启用管理员模式"))
		return
	}

	if info.UID != 0 && !info.SudoReal {
		a.fail(w, req.Host, info.notUnixSudoError())
		return
	}

	switch {
	case info.UID == 0:
		a.clearSudoPassword(req.Host)
		writeJSON(w, sudoAuthResult{OK: true, Mode: "root", Server: info.Server})

	case info.Nopass:
		a.clearSudoPassword(req.Host)
		writeJSON(w, sudoAuthResult{OK: true, Mode: "nopass", Server: info.Server})

	case req.Password == "" && !req.Submit:
		writeJSON(w, sudoAuthResult{Server: info.Server, NeedPass: true})

	default:
		nonce, err := sudoNonce()
		if err != nil {
			a.fail(w, req.Host, err)
			return
		}
		ok := "QX_SUDO_OK:" + nonce
		bad := "QX_SUDO_FAIL:" + nonce + ":"
		bin := shellQuote(info.SudoBin)
		script := "OUT=$(" + bin + " -S -p '' -v 2>&1); RC=$?; " +
			"if [ \"$RC\" = \"0\" ]; then echo \"" + ok + "\"; else echo \"" + bad + "$RC:$(printf '%s' \"$OUT\" | tr '\\n' ' ')\"; fi"
		out, err := runSSHCmdStrict(client, script, req.Password+"\n", 20*time.Second)

		env := fmt.Sprintf("uname=%s, uid=%d, sudo=%s", orDash(info.Uname), info.UID, orDash(info.SudoBin))
		text := strings.TrimSpace(out)
		switch {
		case hasLine(text, ok):
			a.setSudoPassword(req.Host, req.Password)
			a.log.Info("sudo auth ok (password)", "host", req.Host, "sudo", orDash(info.SudoBin))
			writeJSON(w, sudoAuthResult{OK: true, Mode: "password", Server: info.Server})
		case strings.Contains(text, bad):
			detail := text[strings.Index(text, bad):]
			a.fail(w, req.Host, fmt.Errorf("sudo 密码校验失败（%s）（环境：%s）", detail, env))
		default:
			a.fail(w, req.Host, fmt.Errorf(
				"sudo 密码校验失败：远端未返回预期结果（原始输出 %q，本地错误 %v；环境：%s）",
				text, err, env))
		}
	}
}

func sudoNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func hasLine(text, want string) bool {
	for _, ln := range strings.Split(text, "\n") {
		if strings.TrimSpace(ln) == want {
			return true
		}
	}
	return false
}

func (a *Gateway) fail(w http.ResponseWriter, host string, err error) {
	a.log.Warn("sudo unavailable", "host", host, "error", err.Error())
	writeErr(w, http.StatusBadRequest, err)
}

func (a *Gateway) handleSudoForget(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	if r.URL.Query().Get("all") == "1" || r.URL.Query().Get("all") == "true" {
		host = ""
	}
	a.clearSudoPassword(host)
	writeJSON(w, okResp{OK: true})
}
