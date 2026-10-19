package config

import (
	"bufio"
	"io"
	"strconv"
	"strings"
)

// SSHConfigEntry 是从 OpenSSH 配置中解析出的一条主机条目。
type SSHConfigEntry struct {
	Alias        string // Host 别名
	HostName     string // 实际主机名（缺省时等于 Alias）
	User         string // 登录用户名
	Port         int    // 端口（缺省 22）
	IdentityFile string // 私钥文件路径
	ProxyJump    string // 跳板机
}

// ParseSSHConfig 解析 OpenSSH ~/.ssh/config 风格的文本，返回可用的主机条目。
// 它会忽略通配别名（含 * 或 ?），并为缺省的主机名与端口填充默认值。
func ParseSSHConfig(r io.Reader) []SSHConfigEntry {
	var entries []SSHConfigEntry
	var current *SSHConfigEntry

	flush := func() {
		if current != nil && current.Alias != "" && !strings.ContainsAny(current.Alias, "*?") {
			if current.HostName == "" {
				current.HostName = current.Alias
			}
			if current.Port <= 0 {
				current.Port = 22
			}
			entries = append(entries, *current)
		}
		current = nil
	}

	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.ToLower(parts[0])
		val := parts[1]

		if key == "host" {
			flush()
			current = &SSHConfigEntry{
				Alias: val,
				Port:  22,
			}
			continue
		}
		if current == nil {
			continue
		}
		switch key {
		case "hostname":
			current.HostName = val
		case "user":
			current.User = val
		case "port":
			if p, err := strconv.Atoi(val); err == nil && p > 0 {
				current.Port = p
			}
		case "identityfile":
			current.IdentityFile = val
		case "proxyjump":
			current.ProxyJump = val
		}
	}
	flush()
	return entries
}
