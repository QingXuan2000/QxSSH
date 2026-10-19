package sshpool

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// hostKeyError 表示某主机的 host key 与已记录指纹不一致（疑似中间人）。
// 其 Error 方法输出中文告警并提示处理方式。
type hostKeyError struct {
	Host           string
	OldFingerprint string
	NewFingerprint string
	KeyAlgo        string
	Path           string
}

func (e *hostKeyError) Error() string {
	return fmt.Sprintf(
		"主机 %s 的 SSH host key 与已记录的指纹不一致（已记录 %s %s，本次 %s %s）。"+
			"若该主机确实重装过系统或换过密钥，请编辑 %s 删掉对应行后重试；"+
			"否则可能是中间人劫持，请勿输入密码。",
		e.Host, e.KeyAlgo, e.OldFingerprint, e.KeyAlgo, e.NewFingerprint, e.Path)
}

// knownHosts 维护 TOFU 式的主机公钥记录，格式与 OpenSSH known_hosts 兼容。
type knownHosts struct {
	mu   sync.Mutex
	path string

	entries map[string]string
}

func newKnownHosts(configDir string) *knownHosts {
	kh := &knownHosts{entries: map[string]string{}}
	if configDir == "" {
		return kh
	}
	kh.path = filepath.Join(configDir, "known_hosts")
	kh.load()
	return kh
}

func (kh *knownHosts) load() {
	b, err := os.ReadFile(kh.path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		kh.entries[fields[0]+" "+fields[1]] = fields[2]
	}
}

// callback 返回用于 ssh.ClientConfig 的主机密钥校验回调。
// 首次见到某主机时记录并信任其公钥，之后指纹不一致则拒绝连接。
func (kh *knownHosts) callback(hostname string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		return kh.verify(hostname, key)
	}
}

func (kh *knownHosts) verify(hostname string, key ssh.PublicKey) error {
	kh.mu.Lock()
	defer kh.mu.Unlock()

	algo := key.Type()
	encoded := base64.StdEncoding.EncodeToString(key.Marshal())
	hostKey := hostname + " " + algo
	recorded, ok := kh.entries[hostKey]

	if !ok {

		kh.entries[hostKey] = encoded
		kh.saveLocked()
		return nil
	}
	if recorded == encoded {
		return nil
	}
	return &hostKeyError{
		Host:           hostname,
		OldFingerprint: fingerprint(recorded),
		NewFingerprint: fingerprint(encoded),
		KeyAlgo:        algo,
		Path:           kh.path,
	}
}

func fingerprint(encodedBase64 string) string {
	raw, err := base64.StdEncoding.DecodeString(encodedBase64)
	if err != nil {
		return "（无法解析）"
	}
	sum := sha256.Sum256(raw)
	return "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
}

func (kh *knownHosts) saveLocked() {
	if kh.path == "" {
		return
	}
	var sb strings.Builder
	sb.WriteString("# QxSSH 记录的 SSH host key。格式同 OpenSSH known_hosts。\n")
	sb.WriteString("# 主机重装或换密钥后，删掉对应行再重连；不匹配时连接会被拒绝。\n")
	for k, v := range kh.entries {
		parts := strings.SplitN(k, " ", 2)
		if len(parts) != 2 {
			continue
		}
		sb.WriteString(parts[0] + " " + parts[1] + " " + v + "\n")
	}
	tmp := kh.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(sb.String()), 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, kh.path)
}
