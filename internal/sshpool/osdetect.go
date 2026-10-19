package sshpool

import (
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const osDetectCmd = `{ . /etc/os-release 2>/dev/null && echo "QXID=$ID" && echo "QXNICE=$PRETTY_NAME" && echo "QXCODENAME=$UBUNTU_CODENAME" && echo "QXIDLIKE=$ID_LIKE"; } ; echo "QXKERNEL=$(uname -s 2>/dev/null)"`

const osDetectTimeout = 4 * time.Second

const (
	osIconLinux = "linux"
	osIconNone  = ""
)

var osIconAliases = map[string]string{

	"arch": "arch", "archarm": "arch", "arch32": "arch", "manjaro": "manjaro",
	"endeavouros": "endeavouros", "garuda": "endeavouros", "antergos": "antergos",
	"arcolinux": "arcolinux", "chakra": "chakra", "kaos": "kaos", "korora": "korora",

	"debian": "debian", "devuan": "devuan", "deepin": "deepin", "raspbian": "debian",
	"elementary": "elementary", "linuxmint": "linuxmint", "mint": "linuxmint",
	"kali": "kali", "siduction": "siduction", "solus": "solus",

	"ubuntu": "ubuntu", "pop": "pop-os", "steamos": "steamos", "jupiter": "steamos",

	"fedora": "fedora", "mageia": "mageia", "rhel": "linux", "centos": "linux",

	"opensuse": "opensuse", "opensuse-leap": "opensuse",
	"opensuse-tumbleweed": "opensuse", "sles": "linux",

	"gentoo": "gentoo", "funtoo": "gentoo", "void": "void",
	"alpine": "linux", "nixos": "linux", "slackware": "linux",
}

var osUbuntuFlavors = map[string]string{
	"kubuntu": "kubuntu",
	"lubuntu": "lubuntu",
	"xubuntu": "xubuntu",
}

// OSInfo 描述远端操作系统，用于在界面展示图标与名称。
type OSInfo struct {
	Icon string // 图标标识，如 linux / ubuntu / windows / macosx
	Name string // 展示名称，如 "Ubuntu 22.04.3 LTS"
}

var osFallback = OSInfo{Icon: osIconLinux, Name: "Linux"}

// detectOS 在远端执行探测命令识别操作系统，超时或失败时回落到 Linux。
func detectOS(client *ssh.Client) OSInfo {
	sess, err := client.NewSession()
	if err != nil {
		return osFallback
	}
	defer func() { _ = sess.Close() }()

	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := sess.Output(osDetectCmd)
		ch <- result{out, err}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			return osFallback
		}
		return parseOSInfo(string(r.out))
	case <-time.After(osDetectTimeout):
		_ = sess.Close()
		return osFallback
	}
}

func parseOSInfo(raw string) OSInfo {
	fields := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		fields[k] = strings.Trim(strings.TrimSpace(v), `"'`)
	}

	icon := osIconFor(fields)

	name := fields["QXNICE"]
	if name == "" {
		name = icon
	}
	return OSInfo{Icon: icon, Name: name}
}

func osIconFor(fields map[string]string) string {
	k := strings.ToLower(fields["QXKERNEL"])
	switch {
	case strings.HasPrefix(k, "mingw"), strings.HasPrefix(k, "msys"),
		strings.HasPrefix(k, "cygwin"):
		return "windows"
	case strings.HasPrefix(k, "darwin"):
		return "macosx"
	}

	id := strings.ToLower(fields["QXID"])
	if id != "" {

		if id == "ubuntu" {
			if icon, ok := osUbuntuFlavors[strings.ToLower(fields["QXCODENAME"])]; ok {
				return icon
			}
		}
		if icon, ok := osIconAliases[id]; ok {
			return icon
		}
	}

	for _, like := range strings.Fields(strings.ToLower(fields["QXIDLIKE"])) {
		if icon, ok := osIconAliases[like]; ok {
			return icon
		}
	}

	if strings.Contains(k, "linux") {
		return osIconLinux
	}
	return osIconNone
}
