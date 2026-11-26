package httpapi

import (
	"regexp"
	"strings"
)

// terminalCommand 构造交互终端的启动命令。
//
// 两个要点：
//  1. 必须同时加 -l 与 -i。只加 -l 是非交互登录 shell：Ubuntu 的 .bashrc 开头的
//     "case $- in *i*) ;; *) return;; esac" 会直接返回，oh-my-bash 一类配置整个不生效，
//     终端看起来就是没有任何主题与补全的裸 bash。
//  2. locale 先在目标机上探测再导出：远端往往没有 zh_CN.UTF-8，强设 LC_ALL 只会让
//     每条命令都刷 setlocale 警告；探测不到时退回 C.UTF-8。
func terminalCommand(cwd, loc string) string {
	var b strings.Builder
	if cwd != "" {
		b.WriteString("cd -- " + shellQuote(cwd) + "; ")
	}
	if loc != "" {
		base := loc
		if i := strings.IndexByte(base, '.'); i > 0 {
			base = base[:i]
		}
		pattern := "^" + regexp.QuoteMeta(strings.ToLower(base)) + `(\.utf-?8)?$`
		b.WriteString("if locale -a 2>/dev/null | tr 'A-Z' 'a-z' | grep -qxE " + shellQuote(pattern) + "; then ")
		b.WriteString("export LANG=" + shellQuote(loc) + " LC_ALL=" + shellQuote(loc) + "; ")
		b.WriteString("else export LANG=C.UTF-8; fi; ")
	}
	b.WriteString(`exec "${SHELL:-/bin/sh}" -l -i`)
	return b.String()
}
