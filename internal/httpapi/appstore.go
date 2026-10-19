package httpapi

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

func (a *Gateway) appDataDir(appID string) (string, error) {
	if !appIDRe.MatchString(appID) {
		return "", errors.New("应用 id 非法")
	}
	root := filepath.Join(a.configDir, "appdata", appID)
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	base := filepath.Join(a.configDir, "appdata")

	if abs != base && !strings.HasPrefix(abs, base+string(os.PathSeparator)) {
		return "", errors.New("存储目录越界")
	}
	return abs, nil
}

func storeCaller(r *http.Request) (string, error) {
	app := callerApp(r)
	if app == "" || app == hostApp {
		return "", errors.New("该端点仅供应用使用")
	}
	return app, nil
}

func safeJoin(base, rel string) (string, error) {
	rel = strings.ReplaceAll(strings.TrimSpace(rel), "\\", "/")

	rel = strings.TrimLeft(rel, "/")
	if vol := filepath.VolumeName(rel); vol != "" {
		rel = strings.TrimPrefix(rel, vol)
		rel = strings.TrimLeft(rel, "/:")
	}
	joined := filepath.Join(base, filepath.FromSlash(rel))
	cleanBase := filepath.Clean(base)
	cleaned := filepath.Clean(joined)
	if cleaned != cleanBase && !strings.HasPrefix(cleaned, cleanBase+string(os.PathSeparator)) {
		return "", errors.New("路径越界：只能访问本应用的数据目录")
	}
	return cleaned, nil
}

func resolveNoSymlink(base, rel string) (string, error) {
	joined, err := safeJoin(base, rel)
	if err != nil {
		return "", err
	}
	segs, err := filepath.Rel(base, joined)
	if err != nil {
		return "", err
	}
	cur := base
	if segs == "." {
		return cur, nil
	}
	for _, seg := range strings.Split(segs, string(os.PathSeparator)) {
		if seg == "" || seg == "." {
			continue
		}
		next := filepath.Join(cur, seg)
		if isLinkPoint(next) {
			target, lerr := os.Readlink(next)
			if lerr != nil {
				return "", errors.New("路径越界：无法读取数据目录内的链接")
			}
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(next), target)
			}
			if !withinDir(cur, target) {
				return "", errors.New("路径越界：链接指向数据目录之外")
			}
			next = target
		}
		cur = next
	}
	return cur, nil
}

func isLinkPoint(p string) bool {
	li, err := os.Lstat(p)
	if err != nil {
		return false
	}
	if li.Mode()&os.ModeSymlink != 0 {
		return true
	}
	si, err := os.Stat(p)
	if err != nil {
		return false
	}
	return !os.SameFile(li, si)
}

func withinDir(dir, p string) bool {
	di, err := os.Stat(dir)
	if err != nil {
		return false
	}
	for {
		pi, err := os.Stat(p)
		if err != nil {
			return false
		}
		if os.SameFile(di, pi) {
			return true
		}
		parent := filepath.Dir(p)
		if parent == p {
			return false
		}
		p = parent
	}
}

type storeEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
}

func (a *Gateway) storePath(w http.ResponseWriter, r *http.Request, rel string) (dir, target string, ok bool) {
	app, err := storeCaller(r)
	if err != nil {
		writeErr(w, http.StatusForbidden, err)
		return "", "", false
	}
	dir, err = a.appDataDir(app)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return "", "", false
	}
	target, err = resolveNoSymlink(dir, rel)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return "", "", false
	}
	return dir, target, true
}

func (a *Gateway) handleStoreList(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	dir, target, ok := a.storePath(w, r, rel)
	if !ok {
		return
	}
	_ = os.MkdirAll(dir, 0o700)
	ents, err := os.ReadDir(target)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	out := make([]storeEntry, 0, len(ents))
	for _, e := range ents {
		info, ierr := e.Info()
		size := int64(0)
		mod := int64(0)
		if ierr == nil {
			size = info.Size()
			mod = info.ModTime().UnixMilli()
		}
		child := e.Name()
		if rel != "" {
			child = path.Join(strings.ReplaceAll(rel, "\\", "/"), e.Name())
		}
		out = append(out, storeEntry{
			Name: e.Name(), Path: child,
			IsDir: e.IsDir(), Size: size, ModTime: mod,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	writeJSON(w, pathEntriesResp{Path: normRel(rel), Entries: out})
}

func normRel(rel string) string {
	rel = strings.ReplaceAll(strings.TrimSpace(rel), "\\", "/")
	rel = strings.TrimLeft(rel, "/")
	if rel == "" {
		return ""
	}
	return path.Clean(rel)
}

func (a *Gateway) handleStoreRead(w http.ResponseWriter, r *http.Request) {
	_, target, ok := a.storePath(w, r, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	f, err := os.Open(target)
	if err != nil {
		if os.IsNotExist(err) {
			if r.URL.Query().Get("optional") == "1" || r.URL.Query().Get("orNull") == "1" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeErr(w, http.StatusNotFound, err)
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		writeErr(w, http.StatusBadRequest, errors.New("不是文件"))
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(target))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filepath.Base(target), st.ModTime(), f)
}

func (a *Gateway) handleStoreWrite(w http.ResponseWriter, r *http.Request) {

	var (
		rel     string
		content string
		appendM bool
		asJSON  bool
	)
	asJSON = strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
	if asJSON {
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
			Append  bool   `json:"append"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		rel, content, appendM = req.Path, req.Content, req.Append
	} else {
		rel = r.URL.Query().Get("path")
		if strings.TrimSpace(rel) == "" {
			writeErr(w, http.StatusBadRequest, errors.New("缺少 path"))
			return
		}
	}

	_, target, ok := a.storePath(w, r, rel)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}

	if asJSON {
		flags := os.O_CREATE | os.O_WRONLY
		if appendM {
			flags |= os.O_APPEND
		} else {
			flags |= os.O_TRUNC
		}
		f, err := os.OpenFile(target, flags, 0o600)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		_, werr := io.WriteString(f, content)
		f.Close()
		if werr != nil {
			writeErr(w, http.StatusInternalServerError, werr)
			return
		}
		writeJSON(w, okPathResp{OK: true, Path: normRel(rel)})
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodyBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(body) > maxJSONBodyBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, errors.New("内容过大"))
		return
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okPathResp{OK: true, Path: normRel(rel)})
}

func (a *Gateway) handleStoreRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	_, from, ok := a.storePath(w, r, req.From)
	if !ok {
		return
	}
	_, to, ok := a.storePath(w, r, req.To)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.Rename(from, to); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okFromToResp{OK: true, From: normRel(req.From), To: normRel(req.To)})
}

func (a *Gateway) handleStoreDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`

		Recursive bool `json:"recursive"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	dir, target, ok := a.storePath(w, r, req.Path)
	if !ok {
		return
	}

	if filepath.Clean(target) == filepath.Clean(dir) {
		writeErr(w, http.StatusBadRequest, errors.New("不能删除存储根目录"))
		return
	}
	if err := os.RemoveAll(target); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleStoreMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	_, target, ok := a.storePath(w, r, req.Path)
	if !ok {
		return
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okPathResp{OK: true, Path: normRel(req.Path)})
}

func (a *Gateway) localPath(r *http.Request, key string) (string, error) {
	p := strings.TrimSpace(r.URL.Query().Get(key))
	if p == "" {
		return "", fmt.Errorf("缺少 %s", key)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return abs, nil
}

type localReq struct {
	Path string `json:"path"`
	To   string `json:"to"`
}

func localBody(r *http.Request) (localReq, string, error) {
	var req localReq
	if err := decodeJSON(r, &req); err != nil {
		return req, "", err
	}
	p := strings.TrimSpace(req.Path)
	if p == "" {
		return req, "", errors.New("缺少 path")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return req, "", err
	}
	return req, abs, nil
}

func (a *Gateway) handleLocalList(w http.ResponseWriter, r *http.Request) {
	target, err := a.localPath(r, "path")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	ents, err := os.ReadDir(target)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	out := make([]storeEntry, 0, len(ents))
	for _, e := range ents {
		info, ierr := e.Info()
		size := int64(0)
		mod := int64(0)
		if ierr == nil {
			size = info.Size()
			mod = info.ModTime().UnixMilli()
		}
		out = append(out, storeEntry{
			Name: e.Name(), Path: filepath.Join(target, e.Name()),
			IsDir: e.IsDir(), Size: size, ModTime: mod,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})

	homes := []storeEntry{}
	for _, p := range []string{os.Getenv("HOME"), os.Getenv("USERPROFILE"), os.Getenv("HOMEDRIVE") + os.Getenv("HOMEPATH")} {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			homes = append(homes, storeEntry{Name: "主目录 " + p, Path: p, IsDir: true})
		}
	}
	writeJSON(w, pathEntriesHomesResp{Path: target, Entries: out, Homes: homes})
}

func (a *Gateway) handleLocalRead(w http.ResponseWriter, r *http.Request) {
	target, err := a.localPath(r, "path")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	f, err := os.Open(target)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		writeErr(w, http.StatusBadRequest, errors.New("不是文件"))
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(target))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filepath.Base(target), st.ModTime(), f)
}

func (a *Gateway) handleLocalWrite(w http.ResponseWriter, r *http.Request) {
	target, err := a.localPath(r, "path")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	n, cerr := io.Copy(f, io.LimitReader(r.Body, maxLocalWriteBytes+1))
	if err := f.Close(); cerr == nil {
		cerr = err
	}
	if cerr != nil || n > maxLocalWriteBytes {
		_ = os.Remove(target)
		if cerr == nil {
			cerr = fmt.Errorf("文件过大（上限 %d MB）", maxLocalWriteBytes>>20)
		}
		writeErr(w, http.StatusBadRequest, cerr)
		return
	}
	writeJSON(w, okPathResp{OK: true, Path: target})
}

func (a *Gateway) handleLocalDelete(w http.ResponseWriter, r *http.Request) {
	_, target, err := localBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := os.RemoveAll(target); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleLocalMkdir(w http.ResponseWriter, r *http.Request) {
	_, target, err := localBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okPathResp{OK: true, Path: target})
}

func (a *Gateway) handleLocalRename(w http.ResponseWriter, r *http.Request) {
	req, from, err := localBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	to := strings.TrimSpace(req.To)
	if to == "" {
		writeErr(w, http.StatusBadRequest, errors.New("缺少 to"))
		return
	}
	toAbs, err := filepath.Abs(to)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.Rename(from, toAbs); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okFromToResp{OK: true, From: from, To: toAbs})
}
