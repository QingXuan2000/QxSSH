package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const appSourceMarker = ".qx-source"

func (a *Gateway) appRoot(id string) (string, bool) {
	root := filepath.Join(a.appsDir(), id)
	b, err := os.ReadFile(filepath.Join(root, appSourceMarker))
	if err != nil {
		return root, false
	}
	src := strings.TrimSpace(string(b))
	if src == "" || !filepath.IsAbs(src) {
		return root, false
	}
	if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
		return root, false
	}
	return src, true
}

func validateDirManifest(dir string) (appManifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return appManifest{}, fmt.Errorf("读取 manifest.json 失败：%w", err)
	}
	if len(b) > 64<<10 {
		return appManifest{}, errors.New("manifest.json 过大（上限 64KB）")
	}
	var m appManifest
	if err := json.Unmarshal(b, &m); err != nil {
		return appManifest{}, fmt.Errorf("manifest.json 解析失败: %w", err)
	}
	if m.SystemApp {
		return appManifest{}, errors.New("该应用声明为系统内置应用，不允许以开发模式加载")
	}
	if m.Disableable {
		return appManifest{}, errors.New("manifest.disableable 仅系统内置应用可用，用户应用不应声明")
	}
	entryName := strings.ReplaceAll(strings.TrimPrefix(strings.TrimSpace(m.Entry), "./"), "\\", "/")
	if entryName == "" {
		entryName = "index.html"
	}
	if !strings.HasSuffix(entryName, ".html") && !strings.HasSuffix(entryName, ".htm") {
		return appManifest{}, errors.New("manifest.entry 必须是应用入口 HTML（默认 index.html）")
	}
	if strings.Contains(entryName, "..") {
		return appManifest{}, errors.New("manifest.entry 不能含 ..")
	}
	if m.ID == "" {
		m.ID = "app-" + strings.ToLower(strings.TrimSuffix(filepath.Base(entryName), ".html"))
	}
	if !appIDRe.MatchString(m.ID) {
		return appManifest{}, errors.New("manifest.id 非法（仅允许字母数字、-、_）")
	}
	if systemAppIDs[m.ID] {
		return appManifest{}, fmt.Errorf("「%s」与内置应用冲突，请换一个 id", m.ID)
	}
	if m.Name.IsZero() {
		m.Name = localizedText{text: m.ID}
	}
	if len(m.Permissions) > 0 {
		seen := make(map[string]bool, len(m.Permissions))
		clean := make([]string, 0, len(m.Permissions))
		for _, p := range m.Permissions {
			p = PermNormalize(strings.TrimSpace(p))
			if p == "" {
				continue
			}
			if !permKnown(p) {
				return appManifest{}, fmt.Errorf("manifest.permissions 含未知权限：%q", p)
			}
			if !seen[p] {
				seen[p] = true
				clean = append(clean, p)
			}
		}
		m.Permissions = clean
	}
	if len(m.Languages) > maxAppLanguages {
		return appManifest{}, fmt.Errorf("manifest.languages 语言过多（上限 %d）", maxAppLanguages)
	}
	for _, lg := range m.Languages {
		if !appLangRe.MatchString(lg) {
			return appManifest{}, fmt.Errorf("manifest.languages 含非法语言代码：%q", lg)
		}
	}
	apis, err := normalizeAPIDecls(m.Apis)
	if err != nil {
		return appManifest{}, err
	}
	m.Apis = apis
	if fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(entryName))); err != nil || fi.IsDir() {
		return appManifest{}, fmt.Errorf("manifest.entry 指定的文件 %q 不存在于目录", entryName)
	}
	m.Entry = entryName
	return m, nil
}

func (a *Gateway) handleLinkApp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	dir := filepath.Clean(strings.TrimSpace(req.Dir))
	if dir == "" || !filepath.IsAbs(dir) {
		writeErr(w, http.StatusBadRequest, errors.New("dir 必须是绝对路径"))
		return
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		writeErr(w, http.StatusBadRequest, errors.New("目录不存在"))
		return
	}
	m, err := validateDirManifest(dir)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	root := filepath.Join(a.appsDir(), m.ID)
	if fi, err := os.Stat(root); err == nil && fi.IsDir() {
		if _, linked := a.appRoot(m.ID); !linked {
			writeErr(w, http.StatusConflict, fmt.Errorf("「%s」已作为正式安装存在，先卸载再以开发模式加载", m.ID))
			return
		}
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(filepath.Join(root, appSourceMarker), []byte(dir+"\n"), 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	a.audit.record(auditEntry{AppID: m.ID, Type: auditAPICall, Target: "apps/link", Detail: dir, Result: "ok"})
	a.log.Info("app linked (dev mode)", "id", m.ID, "dir", dir)
	entry := a.appEntryOf(m, "store")
	entry.Dev = true
	entry.SourceDir = dir
	writeJSON(w, entry)
}
