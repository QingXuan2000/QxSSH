package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"qxssh/internal/webui"
)

type appManifest struct {
	ID             string        `json:"id"`
	Name           localizedText `json:"name"`
	NameKey        string        `json:"nameKey,omitempty"`
	Icon           string        `json:"icon,omitempty"`
	Version        string        `json:"version,omitempty"`
	Description    localizedText `json:"description,omitzero"`
	DescriptionKey string        `json:"descriptionKey,omitempty"`
	Author         string        `json:"author,omitempty"`
	Category       localizedText `json:"category,omitzero"`
	CategoryKey    string        `json:"categoryKey,omitempty"`
	Keywords       []string      `json:"keywords,omitempty"`

	Languages   []string `json:"languages,omitempty"`
	Entry       string   `json:"entry"`
	Permissions []string `json:"permissions,omitempty"`
	SystemApp   bool     `json:"systemApp,omitempty"`

	Disableable   bool         `json:"disableable,omitempty"`
	Singleton     bool         `json:"singleton,omitempty"`
	PreferredSize *appPrefSize `json:"preferredSize,omitempty"`

	Apis []appAPIDecl `json:"apis,omitempty"`
}

type appAPIDecl struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
	NeedsWindow bool   `json:"needsWindow,omitempty"`
	Launch      string `json:"launch,omitempty"`
	Perm        string `json:"perm,omitempty"`
}

type appPrefSize struct {
	Width     int `json:"width,omitempty"`
	Height    int `json:"height,omitempty"`
	MinWidth  int `json:"minWidth,omitempty"`
	MinHeight int `json:"minHeight,omitempty"`
}

var appIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9\-_]{0,63}$`)

var appAPINameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9._\-]{0,63}$`)

var appLangRe = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)

const (
	maxAppZipBytes      = 50 << 20
	maxAppFileCount     = 500
	maxAppDownloadBytes = 50 << 20

	maxAppLanguages = 20

	maxAppAPIs    = 64
	maxAppAPIDesc = 400
)

func normalizeAPIDecls(in []appAPIDecl) ([]appAPIDecl, error) {
	if len(in) == 0 {
		return nil, nil
	}
	if len(in) > maxAppAPIs {
		return nil, fmt.Errorf("manifest.apis 条目过多（上限 %d）", maxAppAPIs)
	}
	seen := make(map[string]bool, len(in))
	out := make([]appAPIDecl, 0, len(in))
	for _, d := range in {
		d.Name = strings.TrimSpace(d.Name)
		if !appAPINameRe.MatchString(d.Name) {
			return nil, fmt.Errorf("manifest.apis 含非法 API 名：%q", d.Name)
		}
		if seen[d.Name] {
			return nil, fmt.Errorf("manifest.apis 重复声明：%q", d.Name)
		}
		seen[d.Name] = true
		if len(d.Description) > maxAppAPIDesc {
			return nil, fmt.Errorf("manifest.apis[%s].description 过长（上限 %d）", d.Name, maxAppAPIDesc)
		}
		switch d.Launch = strings.TrimSpace(d.Launch); d.Launch {
		case "", "window", "background":
		default:
			return nil, fmt.Errorf("manifest.apis[%s].launch 取值非法（window / background / 空）", d.Name)
		}
		if p := strings.TrimSpace(d.Perm); p != "" {
			p = PermNormalize(p)
			if !permKnown(p) {
				return nil, fmt.Errorf("manifest.apis[%s].perm 含未知权限：%q", d.Name, d.Perm)
			}
			d.Perm = p
		} else {
			d.Perm = ""
		}
		out = append(out, d)
	}
	return out, nil
}

var (
	systemApps             = loadSystemApps()
	systemAppIDs           = systemAppIDsFrom(systemApps)
	disableableSystemAppID = disableableIDsFrom(systemApps)
)

func loadSystemApps() []appManifest {
	manifests, err := fs.Glob(webui.FS, "apps/*/manifest.json")
	if err != nil {
		return nil
	}
	apps := make([]appManifest, 0, len(manifests))
	for _, name := range manifests {
		b, err := fs.ReadFile(webui.FS, name)
		if err != nil {
			continue
		}
		var m appManifest
		if json.Unmarshal(b, &m) != nil || !m.SystemApp {
			continue
		}
		if m.ID == "" {
			m.ID = path.Base(path.Dir(name))
		}

		apis, err := normalizeAPIDecls(m.Apis)
		if err != nil {
			panic(fmt.Sprintf("apps: 内置应用 %s 的 %v", name, err))
		}
		m.Apis = apis
		if appIDRe.MatchString(m.ID) {
			apps = append(apps, m)
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].ID < apps[j].ID })
	return apps
}

func systemAppIDsFrom(apps []appManifest) map[string]bool {
	ids := make(map[string]bool, len(apps))
	for _, m := range apps {
		ids[m.ID] = true
	}
	return ids
}

func disableableIDsFrom(apps []appManifest) map[string]bool {
	ids := make(map[string]bool, len(apps))
	for _, m := range apps {
		if m.Disableable {
			ids[m.ID] = true
		}
	}
	return ids
}

func canDisable(id string) bool {
	if !systemAppIDs[id] {
		return true
	}
	return disableableSystemAppID[id]
}

func (a *Gateway) appsDir() string {
	return filepath.Join(a.configDir, "apps")
}

type appEntry struct {
	appManifest
	Disabled bool `json:"disabled"`

	Source string `json:"source"`

	Dev       bool   `json:"dev,omitempty"`
	SourceDir string `json:"sourceDir,omitempty"`
}

func (a *Gateway) handleListUserApps(w http.ResponseWriter, r *http.Request) {
	dir := a.appsDir()
	entries, err := os.ReadDir(dir)
	out := make([]appEntry, 0, len(systemApps)+8)
	for _, m := range systemApps {
		out = append(out, a.appEntryOf(m, "builtin"))
	}
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, appsListResp{Apps: out})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}

		root, dev := a.appRoot(e.Name())
		b, err := os.ReadFile(filepath.Join(root, "manifest.json"))
		if err != nil {
			continue
		}
		var m appManifest
		if err := json.Unmarshal(b, &m); err != nil {
			continue
		}
		if m.SystemApp || m.ID != e.Name() {
			continue
		}

		m.SystemApp = false
		m.Disableable = false
		if apis, err := normalizeAPIDecls(m.Apis); err == nil {
			m.Apis = apis
		} else {
			m.Apis = nil
		}
		entry := a.appEntryOf(m, "store")
		if dev {
			entry.Dev = true
			entry.SourceDir = root
		}
		out = append(out, entry)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeJSON(w, appsListResp{Apps: out})
}

func (a *Gateway) appEntryOf(m appManifest, source string) appEntry {
	return appEntry{
		appManifest: m,
		Disabled:    canDisable(m.ID) && a.appState.isDisabled(m.ID),
		Source:      source,
	}
}

func (a *Gateway) readAppPackage(r *http.Request) ([]byte, int, error) {
	if ct := r.Header.Get("Content-Type"); strings.HasPrefix(ct, "multipart/form-data") {
		f, fh, err := r.FormFile("file")
		if err != nil {
			return nil, http.StatusBadRequest, errors.New("缺少应用包文件（multipart 字段 file）")
		}
		defer f.Close()
		if fh == nil || !strings.HasSuffix(strings.ToLower(fh.Filename), ".qxp") {
			return nil, http.StatusBadRequest, errors.New("应用包后缀须为 .qxp（zip 格式）")
		}
		data, err := io.ReadAll(io.LimitReader(f, maxAppZipBytes+1))
		if err != nil {
			return nil, http.StatusBadRequest, err
		}
		if len(data) > maxAppZipBytes {
			return nil, http.StatusBadRequest, fmt.Errorf("压缩包过大（上限 %d MB）", maxAppZipBytes>>20)
		}
		return data, 0, nil
	}

	var req struct {
		URL string `json:"url"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return nil, http.StatusBadRequest, err
	}
	if req.URL == "" {
		return nil, http.StatusBadRequest, errors.New("url 为必填项")
	}
	u := req.URL
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "https://" + u
	}
	cl := &http.Client{Timeout: 30 * time.Second}
	resp, err := cl.Get(u)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, http.StatusBadGateway, fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAppDownloadBytes+1))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if len(data) > maxAppDownloadBytes {
		return nil, http.StatusBadRequest, fmt.Errorf("压缩包过大（上限 %d MB）", maxAppDownloadBytes>>20)
	}
	return data, 0, nil
}

func (a *Gateway) handleInstallApp(w http.ResponseWriter, r *http.Request) {
	data, st, err := a.readAppPackage(r)
	if err != nil {
		writeErr(w, st, err)
		return
	}

	m, err := a.installAppZip(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	if len(m.Permissions) > 0 {
		if err := a.store.Grant(m.ID, m.Permissions); err != nil {
			a.log.Warn("grant manifest permissions failed", "id", m.ID, "err", err.Error())
		} else {
			a.audit.record(auditEntry{
				AppID:  m.ID,
				Type:   auditPermGrant,
				Target: "apps/install",
				Detail: strings.Join(m.Permissions, ","),
				Result: "ok",
			})
		}
	}
	a.log.Info("app installed", "id", m.ID, "name", m.Name.Get(defaultLang), "version", m.Version)
	writeJSON(w, m)
}

func (a *Gateway) handleValidateApp(w http.ResponseWriter, r *http.Request) {
	data, st, err := a.readAppPackage(r)
	if err != nil {
		writeErr(w, st, err)
		return
	}

	m, byName, err := a.parseAppZip(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	installed := false
	if fi, err := os.Stat(filepath.Join(a.appsDir(), m.ID)); err == nil && fi.IsDir() {
		installed = true
	}
	a.log.Info("app package validated", "id", m.ID, "name", m.Name.Get(defaultLang), "version", m.Version, "installed", installed)
	writeJSON(w, appValidateResp{
		App:       m,
		Installed: installed,
		FileCount: len(byName),
		Size:      len(data),
	})
}

func (a *Gateway) parseAppZip(r io.ReaderAt, size int64) (appManifest, map[string]*zip.File, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return appManifest{}, nil, errors.New("不是有效的 zip 文件")
	}
	if len(zr.File) == 0 {
		return appManifest{}, nil, errors.New("压缩包为空")
	}
	if len(zr.File) > maxAppFileCount {
		return appManifest{}, nil, fmt.Errorf("压缩包内文件过多（上限 %d）", maxAppFileCount)
	}

	byName := map[string]*zip.File{}
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		name = strings.TrimPrefix(name, "./")
		if f.FileInfo().IsDir() {
			continue
		}
		if strings.HasPrefix(name, "/") || strings.Contains(name, "..") || name == "" {
			return appManifest{}, nil, fmt.Errorf("压缩包含非法路径: %q", f.Name)
		}
		byName[name] = f
	}

	mf, ok := byName["manifest.json"]
	if !ok {
		return appManifest{}, nil, errors.New("缺少 manifest.json")
	}
	mrc, err := mf.Open()
	if err != nil {
		return appManifest{}, nil, err
	}
	defer mrc.Close()
	var m appManifest
	if err := json.NewDecoder(io.LimitReader(mrc, 64<<10)).Decode(&m); err != nil {
		return appManifest{}, nil, fmt.Errorf("manifest.json 解析失败: %w", err)
	}
	if m.SystemApp {
		return appManifest{}, nil, errors.New("该应用包声明为系统内置应用，不允许从应用管理器安装")
	}

	if m.Disableable {
		return appManifest{}, nil, errors.New("manifest.disableable 仅系统内置应用可用，用户应用包不应声明")
	}
	entryName := strings.ReplaceAll(strings.TrimPrefix(strings.TrimSpace(m.Entry), "./"), "\\", "/")
	if entryName == "" {
		entryName = "index.html"
	}
	if !strings.HasSuffix(entryName, ".html") && !strings.HasSuffix(entryName, ".htm") {
		return appManifest{}, nil, errors.New("manifest.entry 必须是应用入口 HTML（默认 index.html）")
	}
	if m.ID == "" {
		m.ID = "app-" + strings.ToLower(strings.TrimSuffix(filepath.Base(entryName), ".html"))
	}
	if !appIDRe.MatchString(m.ID) {
		return appManifest{}, nil, errors.New("manifest.id 非法（仅允许字母数字、-、_）")
	}
	if systemAppIDs[m.ID] {
		return appManifest{}, nil, fmt.Errorf("「%s」与内置应用冲突，请换一个 id", m.ID)
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
				return appManifest{}, nil, fmt.Errorf("manifest.permissions 含未知权限：%q", p)
			}
			if !seen[p] {
				seen[p] = true
				clean = append(clean, p)
			}
		}
		m.Permissions = clean
	}

	if len(m.Languages) > maxAppLanguages {
		return appManifest{}, nil, fmt.Errorf("manifest.languages 语言过多（上限 %d）", maxAppLanguages)
	}
	for _, lg := range m.Languages {
		if !appLangRe.MatchString(lg) {
			return appManifest{}, nil, fmt.Errorf("manifest.languages 含非法语言代码：%q", lg)
		}
	}
	apis, err := normalizeAPIDecls(m.Apis)
	if err != nil {
		return appManifest{}, nil, err
	}
	m.Apis = apis
	if _, ok := byName[entryName]; !ok {
		return appManifest{}, nil, fmt.Errorf("manifest.entry 指定的文件 %q 不存在于压缩包", m.Entry)
	}
	m.Entry = entryName

	if ic := strings.TrimSpace(m.Icon); ic != "" {
		icPath := strings.TrimPrefix(strings.ReplaceAll(ic, "\\", "/"), "./")
		if strings.Contains(path.Base(icPath), ".") {
			clean := path.Clean(icPath)
			switch strings.ToLower(path.Ext(clean)) {
			case ".ico", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp":
			default:
				return appManifest{}, nil, fmt.Errorf("manifest.icon 文件类型不受支持（.ico/.png/.jpg/.svg/.gif/.webp）: %q", ic)
			}
			if _, ok := byName[clean]; !ok {
				return appManifest{}, nil, fmt.Errorf("manifest.icon 指定的文件 %q 不存在于应用包", ic)
			}
			m.Icon = clean
		} else {
			m.Icon = icPath
		}
	}
	return m, byName, nil
}

func (a *Gateway) installAppZip(r io.ReaderAt, size int64) (appManifest, error) {
	m, byName, err := a.parseAppZip(r, size)
	if err != nil {
		return appManifest{}, err
	}

	root := filepath.Join(a.appsDir(), m.ID)
	_ = os.RemoveAll(root)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return appManifest{}, err
	}
	var total int64
	for name, zf := range byName {
		if name == "manifest.json" {
			continue
		}
		if zf.UncompressedSize64 > maxAppZipBytes {
			return appManifest{}, fmt.Errorf("文件 %q 过大", name)
		}
		rc, err := zf.Open()
		if err != nil {
			return appManifest{}, err
		}
		dest := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			rc.Close()
			return appManifest{}, err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			rc.Close()
			return appManifest{}, err
		}
		n, err := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return appManifest{}, err
		}
		total += n
		if total > maxAppZipBytes*2 {
			return appManifest{}, errors.New("解压后总大小超出限制")
		}
	}

	m.SystemApp = false
	mb, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return appManifest{}, err
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), mb, 0o644); err != nil {
		return appManifest{}, err
	}
	return m, nil
}

func (a *Gateway) handleUninstallApp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	id := req.ID
	if !appIDRe.MatchString(id) {
		writeErr(w, http.StatusBadRequest, errors.New("应用 id 非法"))
		return
	}
	if systemAppIDs[id] {
		writeErr(w, http.StatusBadRequest, errors.New("内置应用不可卸载"))
		return
	}
	root := filepath.Join(a.appsDir(), id)
	if b, err := os.ReadFile(filepath.Join(root, "manifest.json")); err == nil {
		var m appManifest
		if json.Unmarshal(b, &m) == nil && m.SystemApp {
			writeErr(w, http.StatusBadRequest, errors.New("系统内置应用不可卸载"))
			return
		}
	}
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusBadRequest, errors.New("应用不存在"))
		return
	}
	if err := os.RemoveAll(root); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.store.ClearGrants(id); err != nil {
		a.log.Warn("clear grants failed", "id", id, "err", err.Error())
	}

	if _, err := a.appState.setEnabled(id, true); err != nil {
		a.log.Warn("clear app state failed", "id", id, "err", err.Error())
	}
	// 卸载即整体撤销：递增令牌世代，旧访问令牌当场失效，刷新令牌一并作废。
	a.revokeAppTokens(id, "app_uninstalled")
	a.log.Info("app uninstalled", "id", id)
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSetAppEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Enabled bool   `json:"enabled"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !appIDRe.MatchString(req.ID) {
		writeErr(w, http.StatusBadRequest, errors.New("应用 id 非法"))
		return
	}

	if !req.Enabled && !canDisable(req.ID) {
		writeErr(w, http.StatusBadRequest, errors.New("该系统内置应用不可禁用"))
		return
	}
	if !a.appExists(req.ID) {
		writeErr(w, http.StatusBadRequest, errors.New("应用不存在"))
		return
	}
	if _, err := a.appState.setEnabled(req.ID, req.Enabled); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	// 禁用等同于卸载：应用不应再能调用任何 API，因此立即整体撤销其令牌。
	// 重新启用不影响已签发的令牌之外的状态（世代号只增不减，无需回退）。
	if !req.Enabled {
		a.revokeAppTokens(req.ID, "app_disabled")
	}
	a.log.Info("app enabled state changed", "id", req.ID, "enabled", req.Enabled)
	writeJSON(w, appEnabledResp{OK: true, ID: req.ID, Enabled: req.Enabled})
}

var appFileTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".htm":   "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".gif":   "image/gif",
	".ico":   "image/x-icon",
	".json":  "application/json; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".mp3":   "audio/mpeg",
	".mp4":   "video/mp4",
	".wasm":  "application/wasm",
}

func (a *Gateway) handleServeAppFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	start := time.Now()
	rec := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	defer func() {

		a.audit.record(auditEntry{
			AppID:    id,
			Type:     auditAPICall,
			Target:   "GET apps/file/" + id + "/" + r.PathValue("path"),
			Result:   strconv.Itoa(rec.status),
			Duration: time.Since(start).Milliseconds(),
		})
	}()
	if !appIDRe.MatchString(id) {
		writeErr(rec, http.StatusBadRequest, errors.New("应用 id 非法"))
		return
	}
	raw := r.PathValue("path")
	rel := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	rel = strings.TrimPrefix(rel, "/")

	if rel == "" || strings.HasSuffix(rel, "/") {
		rel += "index.html"
	}

	root, _ := a.appRoot(id)
	dest := filepath.Join(root, filepath.FromSlash(path.Clean(rel)))
	if dest != root && !strings.HasPrefix(dest, root+string(os.PathSeparator)) {
		a.log.Warn("app file path rejected", "id", id, "path", raw)
		writeErr(rec, http.StatusBadRequest, fmt.Errorf("非法文件路径：%s", raw))
		return
	}
	fi, err := os.Stat(dest)
	if err == nil && fi.IsDir() {
		dest = filepath.Join(dest, "index.html")
		fi, err = os.Stat(dest)
	}
	if err != nil || fi.IsDir() {

		if data, ct, ok := embeddedAppFile(id, rel); ok {
			rec.Header().Set("Content-Type", ct)
			rec.Header().Set("Cache-Control", "no-cache")
			rec.Header().Set("Content-Length", strconv.Itoa(len(data)))
			_, _ = rec.Write(data)
			return
		}
		a.log.Warn("app file not found", "id", id, "path", raw)
		writeErr(rec, http.StatusNotFound, fmt.Errorf("应用文件不存在：%s", raw))
		return
	}
	f, err := os.Open(dest)
	if err != nil {
		writeErr(rec, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()
	ct := appFileTypes[strings.ToLower(filepath.Ext(rel))]
	if ct == "" {
		ct = "application/octet-stream"
	}

	rec.Header().Set("Content-Type", ct)
	rec.Header().Set("Cache-Control", "no-cache")

	http.ServeContent(rec, r, fi.Name(), fi.ModTime(), f)
}

func embeddedAppFile(id, rel string) ([]byte, string, bool) {
	if !systemAppIDs[id] {
		return nil, "", false
	}
	name := "apps/" + id + "/" + rel
	if !fs.ValidPath(name) {
		return nil, "", false
	}
	data, err := fs.ReadFile(webui.FS, name)
	if err != nil {
		return nil, "", false
	}
	ct := appFileTypes[strings.ToLower(path.Ext(rel))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	return data, ct, true
}
