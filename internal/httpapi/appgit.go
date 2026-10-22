package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/storage/memory"
)

// appGitMarker 是写入应用目录的 Git 安装元数据文件名；存在该文件说明应用由 Git
// 仓库安装，列表接口据此回填 entry.Git 并把 source 标为 git。
// gitCacheTTL 是临时克隆缓存的复用时长：同一 URL+分支在 TTL 内不重复克隆。
const (
	appGitMarker = ".qx-git"
	gitCacheTTL  = 5 * time.Minute
)

// appGitMeta 是随应用一起落盘的安装来源快照，写在 <appDir>/.qx-git 里。
// URL 与 Branch 供「更新」按钮原样重装；Commit 是与远端比对的当前版本凭据；
// Path 记录应用在仓库中的子目录；InstalledAt 只用于展示，不参与任何判定。
type appGitMeta struct {
	URL         string `json:"url"`
	Branch      string `json:"branch,omitempty"`
	Commit      string `json:"commit,omitempty"`
	Path        string `json:"path,omitempty"`
	InstalledAt int64  `json:"installedAt,omitempty"`
}

// appPackageReq 是 apps/validate 与 apps/install 共用的 JSON 请求体，三种载荷形态：
//
//	{"url":"https://…/app.qxp"}                        下载链接
//	{"git":"…","branch":"main","path":"apps/docker"}   Git 仓库（branch/path 可空）
//	{"url":"…git","type":"git"}                         Git 仓库的等价写法
//
// 判定顺序见 handleInstallApp：Git 字段非空 → type=git → url 形似仓库地址；
// 三者都不命中才按下载链接处理。前端必须把 git 三字段原样发出，不能降级成单个 url。
type appPackageReq struct {
	URL    string `json:"url,omitempty"`
	Git    string `json:"git,omitempty"`
	Type   string `json:"type,omitempty"`
	Branch string `json:"branch,omitempty"`
	Path   string `json:"path,omitempty"`
}

// isGitURL 判断地址是否形似 Git 仓库：.git 后缀，或 git@ / git:// / ssh://git@ 前缀。
// 只用于把「把仓库地址粘进下载框」的情况导流到克隆分支，不做权威解析——
// https://host/owner/repo 这种不带 .git 的网页地址无法据此识别。
func isGitURL(u string) bool {
	u = strings.TrimSpace(u)
	lower := strings.ToLower(u)
	if strings.HasSuffix(lower, ".git") {
		return true
	}
	if strings.HasPrefix(lower, "git@") || strings.HasPrefix(lower, "git://") || strings.HasPrefix(lower, "ssh://git@") {
		return true
	}
	return false
}

// cleanGitURL 校验并规范化仓库地址，产出 go-git 可直接使用的形式：
// 缺协议的 host/owner/repo 补 https://，scp 形式 git@host:path 转 ssh://git@host/path。
// 拒绝空值、以连字符开头的值与无法识别的形态，避免地址被当成命令参数注入。
func cleanGitURL(raw string) (string, error) {
	u := strings.TrimSpace(raw)
	if u == "" {
		return "", errors.New("Git 仓库地址不能为空")
	}
	if strings.HasPrefix(u, "-") {
		return "", errors.New("非法 Git 仓库地址（不能以连字符开头）")
	}
	lower := strings.ToLower(u)
	if !strings.HasPrefix(lower, "http://") &&
		!strings.HasPrefix(lower, "https://") &&
		!strings.HasPrefix(lower, "git@") &&
		!strings.HasPrefix(lower, "git://") &&
		!strings.HasPrefix(lower, "ssh://") &&
		!strings.HasPrefix(lower, "file://") {
		if strings.Contains(u, "/") && !strings.Contains(u, "://") && !strings.HasPrefix(u, "\\") {
			u = "https://" + u
		} else {
			return "", errors.New("Git 仓库地址格式不支持，请使用 http(s):// 或 git@ 开头的地址")
		}
	}
	// scp 形式 git@host:path 转成 go-git 需要的 ssh://git@host/path
	if strings.HasPrefix(lower, "git@") && !strings.Contains(u, "://") {
		if i := strings.Index(u, ":"); i > 0 {
			u = "ssh://" + u[:i] + "/" + strings.TrimPrefix(u[i+1:], "/")
		}
	}
	return u, nil
}

// cleanGitBranch 校验并清理分支或标签名
func cleanGitBranch(b string) (string, error) {
	b = strings.TrimSpace(b)
	if b == "" {
		return "", nil
	}
	if strings.HasPrefix(b, "-") {
		return "", errors.New("非法 Git 分支/标签名（不能以连字符开头）")
	}
	if strings.ContainsAny(b, " \t\r\n~^:?*[\x00-\x1f") {
		return "", errors.New("Git 分支/标签名包含非法字符")
	}
	return b, nil
}

// cleanSubPath 校验并清理子目录路径
func cleanSubPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	clean := path.Clean(p)
	if clean == "." || clean == "" {
		return "", nil
	}
	if strings.HasPrefix(clean, "..") || strings.Contains(clean, "/../") {
		return "", errors.New("子目录路径越界")
	}
	return clean, nil
}

// cloneOrGetCachedGitRepo 获取缓存的克隆目录，或执行浅克隆。纯 Go 实现，
// 经 go-git 直接走 http(s)/git/ssh/file 传输，不依赖外部 git 命令。
func cloneOrGetCachedGitRepo(ctx context.Context, rawURL, branch string) (string, string, error) {
	cleanURL, err := cleanGitURL(rawURL)
	if err != nil {
		return "", "", err
	}
	cleanBr, err := cleanGitBranch(branch)
	if err != nil {
		return "", "", err
	}

	h := sha256.Sum256([]byte(cleanURL + "\x00" + cleanBr))
	cacheKey := fmt.Sprintf("%x", h[:8])
	cacheDir := filepath.Join(os.TempDir(), "qxssh-git-cache", cacheKey)

	// 若存在近期缓存则直接复用
	if fi, err := os.Stat(cacheDir); err == nil && fi.IsDir() {
		if time.Since(fi.ModTime()) < gitCacheTTL {
			return cacheDir, getRepoCommit(cacheDir), nil
		}
	}

	_ = os.RemoveAll(cacheDir)
	if err := os.MkdirAll(filepath.Dir(cacheDir), 0o755); err != nil {
		return "", "", fmt.Errorf("创建临时缓存目录失败: %w", err)
	}

	opts := &git.CloneOptions{
		URL:          cleanURL,
		Depth:        1,
		SingleBranch: true,
		Tags:         git.NoTags,
	}
	if cleanBr != "" {
		opts.ReferenceName = plumbing.NewBranchReferenceName(cleanBr)
	}
	if _, err := git.PlainCloneContext(ctx, cacheDir, false, opts); err != nil {
		_ = os.RemoveAll(cacheDir)
		return "", "", fmt.Errorf("Git 克隆失败: %w", err)
	}

	return cacheDir, getRepoCommit(cacheDir), nil
}

// getRepoCommit 取仓库当前提交的短哈希，用于写入安装元数据；失败返回空串，不影响安装。
func getRepoCommit(repoDir string) string {
	repo, err := git.PlainOpen(repoDir)
	if err != nil {
		return ""
	}
	ref, err := repo.Head()
	if err != nil {
		return ""
	}
	h := ref.Hash().String()
	if len(h) > 8 {
		h = h[:8]
	}
	return h
}

// normalizeDirAppIcon 校验目录形式安装的图标声明，规则与 zip 包的 normalizeAppIcon 一致：
// 有扩展名的取值必须在 dir 内真实存在且属于白名单类型；不含扩展名的取值当作内置图标名
// 放行（前端回退到 id 对应的图标）。亮暗两值相同或只给一个时收敛为单值。
func normalizeDirAppIcon(spec appIconSpec, dir string) (appIconSpec, error) {
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
		target := filepath.Join(dir, filepath.FromSlash(clean))
		fi, err := os.Stat(target)
		if err != nil || fi.IsDir() {
			return "", fmt.Errorf("manifest.icon%s 指定的文件 %q 不存在", field, ic)
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

// validateGitAppDir 校验目录形式的应用并统计规模，返回清单、文件数与总字节。
// 除 manifest 合法性外沿用 zip 包的三条上限：文件数 maxAppFileCount、单文件 maxAppZipBytes、
// 总量 100MB，保证两种安装来源的准入标准一致。.git 目录与 .qx-* 元数据不计入统计。
func validateGitAppDir(appDir string) (appManifest, int, int64, error) {
	manifestPath := filepath.Join(appDir, "manifest.json")
	if fi, err := os.Stat(manifestPath); err != nil || fi.IsDir() {
		return appManifest{}, 0, 0, errors.New("仓库中未找到 manifest.json（如果应用在子目录中，请指定子目录路径）")
	}

	m, err := validateDirManifest(appDir)
	if err != nil {
		return appManifest{}, 0, 0, err
	}

	icon, err := normalizeDirAppIcon(m.Icon, appDir)
	if err != nil {
		return appManifest{}, 0, 0, err
	}
	m.Icon = icon

	fileCount := 0
	var totalBytes int64

	err = filepath.WalkDir(appDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".qx-") {
			return nil
		}
		fileCount++
		if fileCount > maxAppFileCount {
			return fmt.Errorf("应用目录内文件过多（上限 %d）", maxAppFileCount)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxAppZipBytes {
			return fmt.Errorf("单个文件 %q 过大", name)
		}
		totalBytes += info.Size()
		if totalBytes > maxAppZipBytes*2 {
			return errors.New("应用文件总大小超出限制（上限 100 MB）")
		}
		return nil
	})
	if err != nil {
		return appManifest{}, 0, 0, err
	}

	return m, fileCount, totalBytes, nil
}

// copyAppDir 把缓存克隆里的应用目录搬到安装目录。排除 .git（体积大且带远端地址）
// 与 .qx-*（安装元数据，由安装流程自己重写），其余文件保持相对路径原样复制。
func copyAppDir(srcDir, destDir string) error {
	return filepath.WalkDir(srcDir, func(srcPath string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".qx-") {
			return nil
		}
		rel, err := filepath.Rel(srcDir, srcPath)
		if err != nil {
			return err
		}
		destPath := filepath.Join(destDir, rel)
		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return err
		}
		return copyFile(srcPath, destPath)
	})
}

// copyFile 按 0o644 复制单个文件。权限固定为 0644：来源是克隆缓存，
// 其权限位不受控，统一成「可读不可执行」避免带进可执行位。
func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

// installAppFromGit 克隆仓库、定位应用目录并安装到 apps/<id>。
// 顺序：消毒三个入参 → 取缓存克隆（含短哈希）→ 定位子目录 → 校验清单与规模 →
// 覆盖写目标目录 → 回写 manifest 与 .qx-git 元数据 → 清缓存。
// 目标目录先删后建，复制或写元数据任一步失败都会回滚掉 targetDir，不留半个应用。
func (a *Gateway) installAppFromGit(ctx context.Context, repoURL, branch, subPath string) (appManifest, error) {
	cleanURL, err := cleanGitURL(repoURL)
	if err != nil {
		return appManifest{}, err
	}
	cleanBr, err := cleanGitBranch(branch)
	if err != nil {
		return appManifest{}, err
	}
	cleanPath, err := cleanSubPath(subPath)
	if err != nil {
		return appManifest{}, err
	}

	cacheDir, commit, err := cloneOrGetCachedGitRepo(ctx, cleanURL, cleanBr)
	if err != nil {
		return appManifest{}, err
	}

	appDir := cacheDir
	if cleanPath != "" {
		appDir = filepath.Join(cacheDir, filepath.FromSlash(cleanPath))
		fi, err := os.Stat(appDir)
		if err != nil || !fi.IsDir() {
			return appManifest{}, fmt.Errorf("仓库内找不到目录 %q", cleanPath)
		}
	}

	m, _, _, err := validateGitAppDir(appDir)
	if err != nil {
		return appManifest{}, err
	}

	targetDir := filepath.Join(a.appsDir(), m.ID)
	_ = os.RemoveAll(targetDir)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return appManifest{}, err
	}

	if err := copyAppDir(appDir, targetDir); err != nil {
		_ = os.RemoveAll(targetDir)
		return appManifest{}, fmt.Errorf("复制应用文件失败: %w", err)
	}

	m.SystemApp = false
	mb, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		_ = os.RemoveAll(targetDir)
		return appManifest{}, err
	}
	if err := os.WriteFile(filepath.Join(targetDir, "manifest.json"), mb, 0o644); err != nil {
		_ = os.RemoveAll(targetDir)
		return appManifest{}, err
	}

	meta := appGitMeta{
		URL:         cleanURL,
		Branch:      cleanBr,
		Commit:      commit,
		Path:        cleanPath,
		InstalledAt: time.Now().Unix(),
	}
	if gb, err := json.MarshalIndent(meta, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(targetDir, appGitMarker), gb, 0o644)
	}

	// 安装成功后清理缓存目录
	_ = os.RemoveAll(cacheDir)

	return m, nil
}

// gitBranchesReq 是 apps/git-branches 的请求体：仅一个仓库地址字段。
type gitBranchesReq struct {
	URL string `json:"url"`
}

// gitBranchesResp 返回远端分支列表与推断出的默认分支（默认分支总在列表首位）。
type gitBranchesResp struct {
	DefaultBranch string   `json:"defaultBranch"`
	Branches      []string `json:"branches"`
}

// handleGitBranches 不落地克隆，只用内置 go-git 引擎枚举远端分支（上限 15 秒），
// 供安装界面的分支选择器使用；权限复用 apps:validate。
func (a *Gateway) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	var req gitBranchesReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, errors.New("无效的 JSON 请求体"))
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		writeErr(w, http.StatusBadRequest, errors.New("Git 仓库地址不能为空"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	def, branches, err := getRemoteGitBranches(ctx, req.URL)
	if err != nil {
		a.log.Warn("fetch git branches failed", "url", req.URL, "err", err)
		writeErr(w, http.StatusBadRequest, fmt.Errorf("检测分支失败: %w", err))
		return
	}
	writeJSON(w, gitBranchesResp{
		DefaultBranch: def,
		Branches:      branches,
	})
}

// getRemoteGitBranches 检测远程仓库的分支及默认分支。纯 Go 实现：用 go-git 的
// Remote.ListContext 直接读取远端 ref 列表（等价 git ls-remote），不依赖外部 git 命令。
func getRemoteGitBranches(ctx context.Context, rawURL string) (string, []string, error) {
	cleanURL, err := cleanGitURL(rawURL)
	if err != nil {
		return "", nil, err
	}

	remote := git.NewRemote(memory.NewStorage(), &config.RemoteConfig{
		Name: "origin",
		URLs: []string{cleanURL},
	})
	refs, err := remote.ListContext(ctx, &git.ListOptions{})
	if err != nil {
		return "", nil, fmt.Errorf("检测分支失败: %w", err)
	}

	var defaultBranch string
	branchSet := make(map[string]bool)
	var branches []string

	for _, ref := range refs {
		// HEAD 符号引用指向默认分支（等价 ls-remote --symref）
		if ref.Type() == plumbing.SymbolicReference && ref.Name() == plumbing.HEAD {
			defaultBranch = ref.Target().Short()
			continue
		}
		if !ref.Name().IsBranch() {
			continue
		}
		br := ref.Name().Short()
		if br != "" && !branchSet[br] {
			branchSet[br] = true
			branches = append(branches, br)
		}
	}

	sort.Strings(branches)

	if defaultBranch == "" {
		if branchSet["main"] {
			defaultBranch = "main"
		} else if branchSet["master"] {
			defaultBranch = "master"
		} else if len(branches) > 0 {
			defaultBranch = branches[0]
		}
	} else if !branchSet[defaultBranch] && defaultBranch != "" {
		branches = append([]string{defaultBranch}, branches...)
	}

	return defaultBranch, branches, nil
}
