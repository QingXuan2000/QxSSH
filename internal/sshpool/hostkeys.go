package sshpool

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// hostKeyError 表示某主机的 host key 与已记录指纹不一致（疑似中间人）。
// 其 Error 方法输出中文告警并提示处理方式。
type hostKeyError struct {
	Host           string
	OldKeyAlgo     string
	OldFingerprint string
	NewKeyAlgo     string
	NewFingerprint string
	Path           string
}

func (e *hostKeyError) Error() string {
	return fmt.Sprintf(
		"主机 %s 的 SSH host key 与已记录的指纹不一致（已记录 %s %s，本次 %s %s）。"+
			"若该主机确实重装过系统或换过密钥，请编辑 %s 删掉对应行后重试；"+
			"否则可能是中间人劫持，请勿输入密码。",
		e.Host, e.OldKeyAlgo, e.OldFingerprint, e.NewKeyAlgo, e.NewFingerprint, e.Path)
}

// knownHosts 维护 TOFU 式的主机公钥记录，格式与 OpenSSH known_hosts 兼容。
// 信任以主机地址为键：同一主机已记录的全部公钥构成信任集，任何未记录的
// 公钥——无论同算法换指纹还是换算法——一律拒绝，堵住「换一种主机键算法
// 即被静默 TOFU」的中间人绕过（QX-020）。首次信任仍是静默 TOFU（QX-021
// 的指纹确认交互待后续版本）。
type knownHosts struct {
	mu   sync.Mutex
	path string

	// entries: host -> algo -> base64(key)
	entries map[string]map[string]string
}

func newKnownHosts(configDir string) *knownHosts {
	kh := &knownHosts{entries: map[string]map[string]string{}}
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
		if kh.entries[fields[0]] == nil {
			kh.entries[fields[0]] = map[string]string{}
		}
		kh.entries[fields[0]][fields[1]] = fields[2]
	}
}

// callback 返回用于 ssh.ClientConfig 的主机密钥校验回调。
// 首次见到某主机时记录并信任其公钥，之后任何未记录的公钥都拒绝连接。
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
	trusted, known := kh.entries[hostname]

	if !known {
		kh.entries[hostname] = map[string]string{algo: encoded}
		kh.saveLocked()
		return nil
	}
	if recorded, ok := trusted[algo]; ok && recorded == encoded {
		return nil
	}
	// 已知主机出示未记录的公钥：同算法换指纹或换算法都拒绝（QX-020）。
	oldAlgo, oldEncoded := firstTrusted(trusted)
	return &hostKeyError{
		Host:           hostname,
		OldKeyAlgo:     oldAlgo,
		OldFingerprint: fingerprint(oldEncoded),
		NewKeyAlgo:     algo,
		NewFingerprint: fingerprint(encoded),
		Path:           kh.path,
	}
}

// firstTrusted 取信任集中排序后的第一条，用于告警文案的确定性展示。
func firstTrusted(trusted map[string]string) (algo, encoded string) {
	algos := make([]string, 0, len(trusted))
	for a := range trusted {
		algos = append(algos, a)
	}
	sort.Strings(algos)
	if len(algos) == 0 {
		return "", ""
	}
	return algos[0], trusted[algos[0]]
}

// pinnedAlgos 返回已知主机已记录的主机键算法（排序稳定）。拨号时优先提议
// 这些算法，使协商结果落在信任集内，避免合法主机因算法漂移被误拒（QX-020）。
func (kh *knownHosts) pinnedAlgos(hostname string) []string {
	kh.mu.Lock()
	defer kh.mu.Unlock()
	trusted := kh.entries[hostname]
	if len(trusted) == 0 {
		return nil
	}
	out := make([]string, 0, len(trusted))
	for algo := range trusted {
		out = append(out, algo)
	}
	sort.Strings(out)
	return out
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
	hosts := make([]string, 0, len(kh.entries))
	for h := range kh.entries {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	for _, h := range hosts {
		algos := make([]string, 0, len(kh.entries[h]))
		for a := range kh.entries[h] {
			algos = append(algos, a)
		}
		sort.Strings(algos)
		for _, a := range algos {
			sb.WriteString(h + " " + a + " " + kh.entries[h][a] + "\n")
		}
	}
	// 随机后缀临时文件 + 原子改名：避免多实例共用配置目录时固定 .tmp
	// 互相覆盖导致信任记录丢失（QX-052）。CreateTemp 默认 0600。
	tmp, err := os.CreateTemp(filepath.Dir(kh.path), filepath.Base(kh.path)+".tmp-*")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(sb.String()); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return
	}
	if err := os.Rename(tmpName, kh.path); err != nil {
		_ = os.Remove(tmpName)
	}
}
