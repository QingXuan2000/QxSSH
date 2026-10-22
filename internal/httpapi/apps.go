package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
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

// appManifest 是应用清单（manifest.json）的完整结构，同时用作安装、校验、列表
// 接口的响应载荷；localizedText / appIconSpec 字段带自定义序列化，与前端约定一致。
type appManifest struct {
	ID             string        `json:"id"`
	Name           localizedText `json:"name"`
	NameKey        string        `json:"nameKey,omitempty"`
	Icon           appIconSpec   `json:"icon,omitzero"`
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

// appIconSpec 描述应用图标的取值，支持两种清单写法：
//
//	"icon": "logo.svg"                                 亮暗共用一个图标
//	"icon": { "light": "logo.svg", "dark": "logo-d.svg" }  按主题分色
//
// 序列化时会归一：只有一种取值时输出字符串，两种都有时输出对象，
// 因此旧客户端读到字符串、新客户端读到对象都能各自处理。
type appIconSpec struct {
	Light string `json:"light,omitempty"`
	Dark  string `json:"dark,omitempty"`
}

// UnmarshalJSON 同时接受两种清单写法：字符串归一为 Light；对象只允许 light / dark
// 两个键，出现其他键直接报错，避免拼写错误被静默吞掉。
func (s *appIconSpec) UnmarshalJSON(b []byte) error {
	t := bytes.TrimSpace(b)
	if len(t) == 0 || string(t) == "null" {
		*s = appIconSpec{}
		return nil
	}
	if t[0] == '"' {
		var v string
		if err := json.Unmarshal(t, &v); err != nil {
			return err
		}
		*s = appIconSpec{Light: strings.TrimSpace(v)}
		return nil
	}
	if t[0] != '{' {
		return fmt.Errorf("manifest.icon 只接受字符串或 {light, dark} 对象")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(t, &raw); err != nil {
		return fmt.Errorf("manifest.icon 不是合法对象：%w", err)
	}
	pick := func(k string) (string, error) {
		v, ok := raw[k]
		if !ok {
			return "", nil
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return "", fmt.Errorf("manifest.icon.%s 必须是字符串", k)
		}
		return strings.TrimSpace(s), nil
	}
	light, err := pick("light")
	if err != nil {
		return err
	}
	dark, err := pick("dark")
	if err != nil {
		return err
	}
	for k := range raw {
		if k != "light" && k != "dark" {
			return fmt.Errorf("manifest.icon 含未知字段 %q（只支持 light / dark）", k)
		}
	}
	*s = appIconSpec{Light: light, Dark: dark}
	return nil
}

// MarshalJSON 反向归一：dark 为空或与 light 相同时输出字符串，只有双色时输出对象。
func (s appIconSpec) MarshalJSON() ([]byte, error) {
	if s.Dark == "" || s.Dark == s.Light {
		return json.Marshal(s.Light)
	}
	return json.Marshal(struct {
		Light string `json:"light,omitempty"`
		Dark  string `json:"dark"`
	}{Light: s.Light, Dark: s.Dark})
}

// empty 表示清单没有声明图标，前端回退到应用 id 对应的内置图标。
func (s appIconSpec) empty() bool { return s.Light == "" && s.Dark == "" }

// IsZero 让 `json:"icon,omitzero"` 在未声明图标时整键省略。
func (s appIconSpec) IsZero() bool { return s.empty() }

// appAPIDecl 是应用对外声明的一个可调用 API：name 全局唯一，launch 决定打开
// 窗口还是后台执行，perm 是调用该 API 所需的系统权限键（可空）。
type appAPIDecl struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
	NeedsWindow bool   `json:"needsWindow,omitempty"`
	Launch      string `json:"launch,omitempty"`
	Perm        string `json:"perm,omitempty"`
}

// appPrefSize 是应用窗口的建议尺寸与最小尺寸（CSS 像素），全部可选。
type appPrefSize struct {
	Width     int `json:"width,omitempty"`
	Height    int `json:"height,omitempty"`
	MinWidth  int `json:"minWidth,omitempty"`
	MinHeight int `json:"minHeight,omitempty"`
}

// appIDRe 限定应用 id：字母数字开头，总长 1~64，允许 - 与 _。
var appIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9\-_]{0,63}$`)

// appAPINameRe 限定对外 API 名：字母开头，总长 1~64，允许 . _ -。
var appAPINameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9._\-]{0,63}$`)

// appLangRe 校验 manifest.languages，形如 zh、en、zh-CN 的 BCP-47 简化写法。
var appLangRe = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)

// 应用包的安全上限：上传 zip ≤50MB、包内文件 ≤500 个、远程下载 ≤50MB；
// languages ≤20 项、apis ≤64 个且单条 description ≤400 字节（解压总大小上限见 installAppZip）。
const (
	maxAppZipBytes      = 50 << 20
	maxAppFileCount     = 500
	maxAppDownloadBytes = 50 << 20

	maxAppLanguages = 20

	maxAppAPIs    = 64
	maxAppAPIDesc = 400
)

// normalizeAPIDecls 归一并校验 manifest.apis：名称合法且去重、description 限长、
// launch 只允许 window / background / 空、perm 归一后必须是已注册权限键。
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

// 内置应用三张索引表：清单列表、id 集合、可禁用 id 集合；进程启动时由
// loadSystemApps 从嵌入 FS 一次性构建。
var (
	systemApps             = loadSystemApps()
	systemAppIDs           = systemAppIDsFrom(systemApps)
	disableableSystemAppID = disableableIDsFrom(systemApps)
)

// loadSystemApps 扫描嵌入 FS 的 apps/*/manifest.json，只收录 systemApp=true 的清单；
// id 缺省取目录名。内置清单的 apis 不合法属于开发事故，直接 panic 拒绝启动。
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

// systemAppIDsFrom 收集内置应用 id 集合，用于禁止第三方包冒充内置。
func systemAppIDsFrom(apps []appManifest) map[string]bool {
	ids := make(map[string]bool, len(apps))
	for _, m := range apps {
		ids[m.ID] = true
	}
	return ids
}

// disableableIDsFrom 收集内置且声明 disableable 的应用 id 集合。
func disableableIDsFrom(apps []appManifest) map[string]bool {
	ids := make(map[string]bool, len(apps))
	for _, m := range apps {
		if m.Disableable {
			ids[m.ID] = true
		}
	}
	return ids
}

// canDisable 判定应用能否被禁用：第三方应用恒可，内置应用只看 disableable 白名单。
func canDisable(id string) bool {
	if !systemAppIDs[id] {
		return true
	}
	return disableableSystemAppID[id]
}

// appsDir 返回第三方应用的安装根目录 <configDir>/apps。
func (a *Gateway) appsDir() string {
	return filepath.Join(a.configDir, "apps")
}

// appEntry 是列表接口返回的单条应用：清单字段加运行态。Source 取值 builtin /
// store / git；dev 表示开发模式目录；Git 非空表示由 Git 仓库安装（读 .qx-git 得到）。
type appEntry struct {
	appManifest
	Disabled bool `json:"disabled"`

	Source string `json:"source"`

	Dev       bool        `json:"dev,omitempty"`
	SourceDir string      `json:"sourceDir,omitempty"`
	Git       *appGitMeta `json:"git,omitempty"`
}

// handleListUserApps 返回内置应用加 apps 目录下的第三方应用，按 id 排序；
// 单个目录清单损坏直接跳过，不让一个坏应用拖垮整个列表。
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
		} else if gb, err := os.ReadFile(filepath.Join(root, appGitMarker)); err == nil {
			var gm appGitMeta
			if json.Unmarshal(gb, &gm) == nil {
				entry.Git = &gm
				entry.Source = "git"
			}
		}
		out = append(out, entry)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeJSON(w, appsListResp{Apps: out})
}

// appEntryOf 组装列表条目：Disabled 只在应用可禁用且确实被禁用时为 true。
func (a *Gateway) appEntryOf(m appManifest, source string) appEntry {
	return appEntry{
		appManifest: m,
		Disabled:    canDisable(m.ID) && a.appState.isDisabled(m.ID),
		Source:      source,
	}
}

// readAppUpload 读取 multipart 上传的 .qxp 包，返回包字节和一个建议的 HTTP 状态码
// （第二个返回值非 0 时表示出错，直接用它响应）。
func readAppUpload(r *http.Request) ([]byte, int, error) {
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

// downloadAppZip 从远程地址拉取应用包字节，返回值同 readAppUpload。
// 地址未写协议时补 https://；先做语法校验（解析失败、主机为空、主机含空白或
// 方括号花括号一律 400），再发请求——这类畸形地址基本是调用方把对象当字符串发了。
// 下载整体 30 秒超时，读入上限 maxAppDownloadBytes。
func downloadAppZip(rawURL string) ([]byte, int, error) {
	if rawURL == "" {
		return nil, http.StatusBadRequest, errors.New("url 为必填项")
	}
	u := rawURL
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "https://" + u
	}
	// 先做一次语法校验：空白、方括号、花括号出现在主机名里基本都是调用方把对象当字符串发了
	// （例如 JS 的 String({}) → "[object Object]"），在这里拦下比等 http.Get 报错更好定位。
	parsed, perr := url.Parse(u)
	if perr != nil || parsed.Host == "" || strings.ContainsAny(parsed.Host, " \t\r\n\x00[]{}") {
		return nil, http.StatusBadRequest, fmt.Errorf("下载地址无效：%q 不是有效的 http(s) 链接", rawURL)
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

// handleInstallApp 安装第三方应用，按 Content-Type 与请求体分流三条路径：
// multipart 走 .qxp 包、JSON 带 git/type=git/仓库形态 url 走克隆、其余 JSON 按下载链接。
// 三条路径安装成功后都会把 manifest 声明的权限一次性授予（声明即预授权）。
// Git 分支总预算 2 分钟，含克隆、校验与拷贝；下载分支 30 秒。
func (a *Gateway) handleInstallApp(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		data, st, err := readAppUpload(r)
		if err != nil {
			writeErr(w, st, err)
			return
		}
		a.installAndGrantZip(w, data)
		return
	}

	var req appPackageReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	if req.Git != "" || strings.EqualFold(req.Type, "git") || (req.URL != "" && isGitURL(req.URL)) {
		if req.Git == "" {
			req.Git = req.URL
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		m, err := a.installAppFromGit(ctx, req.Git, req.Branch, req.Path)
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
		a.audit.record(auditEntry{
			AppID:  m.ID,
			Type:   auditAPICall,
			Target: "apps/install",
			Detail: "git:" + req.Git,
			Result: "ok",
		})
		a.log.Info("app installed from git", "id", m.ID, "name", m.Name.Get(defaultLang), "version", m.Version, "repo", req.Git)
		writeJSON(w, m)
		return
	}

	if req.URL != "" {
		data, st, err := downloadAppZip(req.URL)
		if err != nil {
			writeErr(w, st, err)
			return
		}
		a.installAndGrantZip(w, data)
		return
	}

	writeErr(w, http.StatusBadRequest, errors.New("缺少应用包文件、下载地址或 Git 仓库地址"))
}

// installAndGrantZip 解包安装内存中的 .qxp，并补做安装后置：授予清单声明的权限、
// 写权限审计与应用安装日志。供上传与下载两条路径共用，两者唯一的差别是字节来源。
func (a *Gateway) installAndGrantZip(w http.ResponseWriter, data []byte) {
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

// handleValidateApp 只校验不安装，与 handleInstallApp 同构地按三种载荷分流：
// 返回清单、是否已装同名应用、文件数与体积，供前端在落地前展示确认信息。
// Git 仓库此时会克隆到缓存目录，随后的安装可直接复用（gitCacheTTL 内）。
func (a *Gateway) handleValidateApp(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		data, st, err := readAppUpload(r)
		if err != nil {
			writeErr(w, st, err)
			return
		}
		a.validateZipData(w, data)
		return
	}

	var req appPackageReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	if req.Git != "" || strings.EqualFold(req.Type, "git") || (req.URL != "" && isGitURL(req.URL)) {
		if req.Git == "" {
			req.Git = req.URL
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		cleanURL, err := cleanGitURL(req.Git)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		cleanBr, err := cleanGitBranch(req.Branch)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		cleanPath, err := cleanSubPath(req.Path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		cacheDir, _, err := cloneOrGetCachedGitRepo(ctx, cleanURL, cleanBr)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		appDir := cacheDir
		if cleanPath != "" {
			appDir = filepath.Join(cacheDir, filepath.FromSlash(cleanPath))
			fi, err := os.Stat(appDir)
			if err != nil || !fi.IsDir() {
				writeErr(w, http.StatusBadRequest, fmt.Errorf("仓库内找不到目录 %q", cleanPath))
				return
			}
		}
		m, fileCount, totalBytes, err := validateGitAppDir(appDir)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		installed := false
		if fi, err := os.Stat(filepath.Join(a.appsDir(), m.ID)); err == nil && fi.IsDir() {
			installed = true
		}
		a.log.Info("app git repo validated", "id", m.ID, "name", m.Name.Get(defaultLang), "version", m.Version, "installed", installed)
		writeJSON(w, appValidateResp{
			App:       m,
			Installed: installed,
			FileCount: fileCount,
			Size:      int(totalBytes),
		})
		return
	}

	if req.URL != "" {
		data, st, err := downloadAppZip(req.URL)
		if err != nil {
			writeErr(w, st, err)
			return
		}
		a.validateZipData(w, data)
		return
	}

	writeErr(w, http.StatusBadRequest, errors.New("缺少应用包文件、下载地址或 Git 仓库地址"))
}

// validateZipData 对内存中的 zip 包做校验并写出确认信息，供上传与下载两种来源共用；
// 它不落盘，因此校验通过不代表已安装。
func (a *Gateway) validateZipData(w http.ResponseWriter, data []byte) {
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

// parseAppZip 只做校验不做解包：zip 有效性与体积、路径不含穿越、manifest 合法
// 且不伪装内置、entry 存在且为 HTML、id 不与内置冲突、权限归一去重。全部通过
// 才返回清单与按路径索引的文件表，任何一项失败都拒绝整个包。
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

	icon, err := normalizeAppIcon(m.Icon, byName)
	if err != nil {
		return appManifest{}, nil, err
	}
	m.Icon = icon
	return m, byName, nil
}

// normalizeAppIcon 校验并归一清单图标：文件型取值必须在包内、扩展名受支持；
// 只有一种取值时两种主题共用，两种相同时收敛为单一取值。
func normalizeAppIcon(spec appIconSpec, byName map[string]*zip.File) (appIconSpec, error) {
	if spec.empty() {
		return appIconSpec{}, nil
	}
	light, dark := spec.Light, spec.Dark
	if light == "" {
		light = dark
	}
	if dark == "" {
		dark = light
	}
	fix := func(field, raw string) (string, error) {
		ic := strings.TrimSpace(raw)
		if ic == "" {
			return "", nil
		}
		icPath := strings.TrimPrefix(strings.ReplaceAll(ic, "\\", "/"), "./")
		if !strings.Contains(path.Base(icPath), ".") {
			return icPath, nil
		}
		clean := path.Clean(icPath)
		switch strings.ToLower(path.Ext(clean)) {
		case ".ico", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp":
		default:
			return "", fmt.Errorf("manifest.icon%s 文件类型不受支持（.ico/.png/.jpg/.svg/.gif/.webp）: %q", field, ic)
		}
		if _, ok := byName[clean]; !ok {
			return "", fmt.Errorf("manifest.icon%s 指定的文件 %q 不存在于应用包", field, ic)
		}
		return clean, nil
	}
	light, err := fix("", light)
	if err != nil {
		return appIconSpec{}, err
	}
	dark, err = fix(".dark", dark)
	if err != nil {
		return appIconSpec{}, err
	}
	if dark == light {
		dark = ""
	}
	return appIconSpec{Light: light, Dark: dark}, nil
}

// installAppZip 把校验通过的包解到 apps/<id>，覆盖同名旧版本；单个文件超 50MB
// 或解压总量超 100MB 立即中止。写入磁盘前强制 SystemApp=false，防止第三方包
// 伪装内置应用。
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

// handleUninstallApp 删除应用目录、清除授权、复位禁用状态，并撤销该应用的全部
// 访问令牌。内置应用不可卸载；磁盘上 systemApp=true 的残包也一并拒绝，双保险。
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

// handleSetAppEnabled 启用或禁用应用；不可禁用的内置应用会被拒绝。
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

// appFileTypes 限定应用静态文件可响应的扩展名白名单及对应 Content-Type；
// 不在表内的文件一律 404，避免应用目录里的意外文件被当作可执行内容投递。
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

// handleServeAppFile 提供 apps/<id>/<path> 静态文件：拒绝隐藏文件段、目录自动补
// index.html、强制 no-cache；第三方应用目录里没有时，内置应用回退到嵌入 FS。
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

	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			a.log.Warn("app file path rejected", "id", id, "path", raw)
			writeErr(rec, http.StatusBadRequest, fmt.Errorf("非法文件路径：%s", raw))
			return
		}
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

// embeddedAppFile 从二进制的嵌入 FS 读取内置应用文件，仅限内置 id，返回字节与
// 白名单内的 Content-Type。
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
