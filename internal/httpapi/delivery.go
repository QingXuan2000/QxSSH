package httpapi

import (
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// 内容投递策略（QXS-01 / QXS-02 / QXS-03）。
//
// 问题形态：多个"把文件内容回给浏览器"的端点（远端 SFTP 预览、应用私有存储、
// 宿主机本地文件）都按扩展名回填 Content-Type，于是一个由**非特权方**写入的
// .html / .svg 会以控制台同源文档的身份执行脚本，进而读到宿主令牌。
//
// 统一策略：
//  1. 默认一律 application/octet-stream + attachment（强制下载，永不作为文档渲染）；
//  2. 只有落在不可执行白名单里的类型才允许 inline；
//  3. 无论 inline 与否，可执行/可脚本化类型都强制降级为 text/plain；
//  4. inline 响应一律附加 CSP: sandbox; default-src 'none'，即使将来白名单
//     出现疏漏，文档也运行在不透明源里，读不到同源令牌。

// inlineSafeTypes 是可以安全内联预览的类型白名单：位图与 PDF 不执行脚本。
// 注意这里刻意不包含 image/svg+xml —— SVG 作为顶层文档时会执行脚本。
var inlineSafeTypes = map[string]string{
	"image/png":                "image/png",
	"image/jpeg":               "image/jpeg",
	"image/gif":                "image/gif",
	"image/webp":               "image/webp",
	"image/bmp":                "image/bmp",
	"image/x-icon":             "image/x-icon",
	"application/pdf":          "application/pdf",
	"text/plain":               "text/plain; charset=utf-8",
	"application/octet-stream": "application/octet-stream",
}

// inlineSafeExts 是 inlineSafeTypes 对应的扩展名集合，用于不依赖系统 mime 表
// （Windows 注册表可能被改写）地做扩展名判定。
var inlineSafeExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".pdf":  "application/pdf",
	".txt":  "text/plain; charset=utf-8",
	".log":  "text/plain; charset=utf-8",
	".md":   "text/plain; charset=utf-8",
}

// sandboxedContentCSP 关闭一切子资源加载与脚本执行：预览通道只需要"看得见"。
const sandboxedContentCSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"

// baseType 去掉参数部分并转小写，便于白名单比较。
func baseType(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.ToLower(strings.TrimSpace(ct))
}

// sniffedType 只对"看起来是文本/图片"的内容做探测，避免把二进制当文本读出。
func sniffedType(f *contentProbe) string {
	if f == nil {
		return ""
	}
	return baseType(http.DetectContentType(f.head))
}

// contentProbe 保存文件前 512 字节，用于内容嗅探。
type contentProbe struct {
	head []byte
}

// deliverFile 按统一策略设置 Content-Type / Content-Disposition / CSP。
//
//	name：呈现给客户端的文件名（只影响头部，不参与路径解析）
//	ext：用于查表的扩展名（调用方传入，避免再次解析路径）
//	inline：调用方是否请求内联预览
//	probe：文件头若干字节，可为 nil（此时退化为纯扩展名判定）
//
// 返回值说明是否真的以 inline 投递。
func deliverFile(h http.Header, name, ext string, inline bool, probe *contentProbe) bool {
	ext = strings.ToLower(ext)
	safe, ok := inlineSafeExts[ext]
	if !ok {
		// 扩展名不在白名单里时，仍允许"内容嗅探结果为安全类型"的少量情形，
		// 但要求扩展名本身不是可执行文档类型（.html/.svg/.js 等直接拒绝）。
		if isExecutableDocExt(ext) {
			inline = false
		}
	}

	ct := "application/octet-stream"
	allowInline := false
	if inline && ok {
		ct = safe
		allowInline = true
	} else if inline {
		// 扩展名未知：若内容嗅探明确落在安全白名单内才内联，否则强制下载。
		if st := sniffedType(probe); st != "" && inlineSafeTypes[st] != "" && !isExecutableDocExt(ext) {
			ct = inlineSafeTypes[st]
			allowInline = true
		}
	}

	disp := "attachment"
	if allowInline {
		disp = "inline"
		h.Set("Content-Security-Policy", sandboxedContentCSP)
	}
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Disposition", contentDisposition(disp, name))
	return allowInline
}

// isExecutableDocExt 报告扩展名是否会作为可执行文档渲染。
func isExecutableDocExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".html", ".htm", ".xhtml", ".xht", ".shtml", ".svg", ".svgz",
		".xml", ".xsl", ".xslt", ".js", ".mjs", ".cjs", ".swf",
		".htc", ".hta", ".mhtml", ".mht", ".wasm":
		return true
	}
	return false
}

// contentDisposition 生成同时兼容旧浏览器的头部：ASCII 兜底 + RFC 5987 UTF-8。
func contentDisposition(disp, name string) string {
	if name == "" {
		name = "download"
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "." || name == string(filepath.Separator) {
		name = "download"
	}
	ascii := make([]rune, 0, len(name))
	for _, r := range name {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			ascii = append(ascii, '_')
			continue
		}
		ascii = append(ascii, r)
	}
	fallback := string(ascii)
	if fallback == "" {
		fallback = "download"
	}
	return disp + `; filename="` + fallback + `"; filename*=UTF-8''` + pathEscape(name)
}

// pathEscape 实现 RFC 5987 的 percent-encoding（比 url.PathEscape 更保守）。
func pathEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// wantsInline 统一判定调用方是否请求内联预览（inline=1 或 disposition=inline）。
func wantsInline(r *http.Request) bool {
	if r == nil {
		return false
	}
	q := r.URL.Query()
	if q.Get("inline") == "1" || q.Get("inline") == "true" {
		return true
	}
	return strings.EqualFold(q.Get("disposition"), "inline")
}

// probeHead 读取文件头至多 512 字节用于内容嗅探，并把读指针交还给调用方。
// 只对尺寸已知且不太大的文件做探测，失败时返回 nil（退化为扩展名判定）。
func probeHead(f *os.File, size int64) *contentProbe {
	if f == nil || size <= 0 {
		return nil
	}
	buf := make([]byte, 512)
	n, err := f.Read(buf)
	if _, serr := f.Seek(0, io.SeekStart); serr != nil {
		return nil
	}
	if n <= 0 {
		return nil
	}
	if err != nil && err != io.EOF {
		return nil
	}
	return &contentProbe{head: buf[:n]}
}

// extOf 返回小写扩展名（含点），对空路径返回空串。
func extOf(p string) string {
	if p == "" {
		return ""
	}
	return strings.ToLower(path.Ext(strings.ReplaceAll(p, "\\", "/")))
}

// typeByExt 在不信任系统 mime 表的前提下给出一个保守的类型判定。
func typeByExt(p string) string {
	ext := extOf(p)
	if ct, ok := inlineSafeExts[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		if isExecutableDocExt(ext) {
			return "text/plain; charset=utf-8"
		}
		return ct
	}
	return "application/octet-stream"
}
