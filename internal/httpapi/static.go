package httpapi

import (
	"bytes"
	"compress/gzip"
	"hash/fnv"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"qxssh/internal/webui"
)

const (
	staticGzipMinBytes = 1024
	staticGzipMaxBytes = 8 << 20
)

var staticTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".svg":   "image/svg+xml; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
	".ts":    "text/plain; charset=utf-8",
	".ico":   "image/x-icon",
	".png":   "image/png",
	".webp":  "image/webp",
	".woff2": "font/woff2",
}

type staticEntry struct {
	etagOnce sync.Once
	etag     string

	gzOnce sync.Once
	gz     []byte
}

type staticCache struct {
	mu      sync.Mutex
	entries map[string]*staticEntry
}

func (c *staticCache) entry(key string) *staticEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		e = &staticEntry{}
		c.entries[key] = e
	}
	return e
}

func (a *Gateway) serveStatic() http.Handler {
	fsys := http.FS(webui.FS)
	fallback := http.FileServer(fsys)
	cache := &staticCache{entries: map[string]*staticEntry{}}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			fallback.ServeHTTP(w, r)
			return
		}
		name, ctype := staticAssetName(r.URL.Path)
		if name == "" {
			fallback.ServeHTTP(w, r)
			return
		}
		f, err := fsys.Open(name)
		if err != nil {
			fallback.ServeHTTP(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			fallback.ServeHTTP(w, r)
			return
		}

		comp := compressibleType(ctype)
		e := cache.entry(name)
		e.etagOnce.Do(func() { e.etag = staticETag(webui.FS, name) })
		if e.etag != "" {
			w.Header().Set("ETag", e.etag)
			if comp {
				w.Header().Add("Vary", "Accept-Encoding")
			}
			if etagMatches(r.Header.Get("If-None-Match"), e.etag) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}

		w.Header().Set("Content-Type", ctype)
		if comp {
			if st.Size() >= staticGzipMinBytes && st.Size() <= staticGzipMaxBytes && acceptsGzip(r.Header.Get("Accept-Encoding")) {
				e.gzOnce.Do(func() {
					if b, err := fs.ReadFile(webui.FS, name); err == nil {
						e.gz = gzipBytes(b)
					}
				})
				if len(e.gz) > 0 {
					w.Header().Set("Content-Encoding", "gzip")
					w.Header().Set("Content-Length", strconv.Itoa(len(e.gz)))
					if r.Method == http.MethodHead {
						w.WriteHeader(http.StatusOK)
						return
					}
					_, _ = w.Write(e.gz)
					return
				}
			}
		}

		http.ServeContent(w, r, name, time.Time{}, f)
	})
}

func staticAssetName(p string) (string, string) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	if p == "" || p == "." {
		return "", ""
	}
	ctype, ok := staticTypes[strings.ToLower(path.Ext(p))]
	if !ok {
		return "", ""
	}
	return p, ctype
}

func staticETag(fsys fs.FS, name string) string {
	f, err := fsys.Open(name)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := fnv.New64a()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return `"` + strconv.FormatUint(h.Sum64(), 16) + `"`
}

func etagMatches(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		switch {
		case part == "":
			continue
		case part == "*":
			return true
		case strings.TrimPrefix(part, "W/") == etag:
			return true
		}
	}
	return false
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		if i := strings.Index(params, "q="); i >= 0 {
			if q, err := strconv.ParseFloat(strings.TrimSpace(params[i+2:]), 64); err == nil && q <= 0 {
				return false
			}
		}
		return true
	}
	return false
}

func compressibleType(ctype string) bool {
	base, _, _ := strings.Cut(ctype, ";")
	if strings.HasPrefix(base, "text/") {
		return true
	}
	switch base {
	case "application/json", "application/javascript", "image/svg+xml":
		return true
	}
	return false
}

func gzipBytes(data []byte) []byte {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	if err != nil {
		return nil
	}
	if _, err := zw.Write(data); err != nil {
		return nil
	}
	if err := zw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}
