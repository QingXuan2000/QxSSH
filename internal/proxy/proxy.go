// Package proxy 实现内网 Web 反向代理。
//
// 它经一条已有的 SSH 通道，把远端内网的 HTTP(S) 服务反向代理到本机的
// 127.0.0.1:<随机端口>，并改写响应以适配浏览器：去除 X-Frame-Options/CSP、
// 放宽 Cookie 属性、跟随跨主机重定向，并抹掉正文中的上游 origin 字符串。
// Registry 负责代理实例的启动、停止、列举，以及主机失效时停止其全部代理。
package proxy

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	maxFollows = 5

	proxyRedirectParam = "__qx_proxy_redirect"
)

// Instance 描述一个运行中的内网 Web 代理实例。URL 是本机可直接访问的地址。
type Instance struct {
	ID     string `json:"id"`
	HostID string `json:"hostId"`
	Target string `json:"target"`
	URL    string `json:"url"`

	ln  net.Listener
	srv *http.Server
	up  *upstream
	tr  *http.Transport
}

// stop 停止该代理实例的 HTTP 服务并关闭空闲连接。
func (it *Instance) stop() {
	_ = it.srv.Close()
	if it.tr != nil {
		it.tr.CloseIdleConnections()
	}
}

// origin 记录一个上游源的协议与地址（用于响应体字符串替换和重定向检测）。
type origin struct {
	scheme string
	addr   string
}

// upstream 管理当前反向代理的上游目标状态，支持跨主机重定向追踪与安全轮转。
type upstream struct {
	mu      sync.Mutex
	scheme  string
	addr    string
	seen    []origin
	follows int
}

func newUpstream(scheme, addr string) *upstream {
	return &upstream{
		scheme: scheme,
		addr:   addr,
		seen:   []origin{{scheme: scheme, addr: addr}},
	}
}

func (u *upstream) current() (string, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.scheme, u.addr
}

func (u *upstream) generation() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.follows
}

func (u *upstream) follow(scheme, addr string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if scheme == u.scheme && addr == u.addr {
		return true
	}
	if u.follows >= maxFollows {
		return false
	}
	u.scheme, u.addr = scheme, addr
	u.follows++
	for _, o := range u.seen {
		if o.scheme == scheme && o.addr == addr {
			return true
		}
	}
	u.seen = append(u.seen, origin{scheme: scheme, addr: addr})
	return true
}

func (u *upstream) stripVariants() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	var out []string
	for _, o := range u.seen {
		origins := []origin{o}
		if host, port, err := net.SplitHostPort(o.addr); err == nil {
			if o.scheme == "http" && port == "80" {
				origins = append(origins, origin{scheme: "https", addr: net.JoinHostPort(host, "443")})
			} else if o.scheme == "https" && port == "443" {
				origins = append(origins, origin{scheme: "http", addr: net.JoinHostPort(host, "80")})
			}
		}
		for _, item := range origins {
			variants := []string{item.scheme + "://" + item.addr, "//" + item.addr}
			if host, port, err := net.SplitHostPort(item.addr); err == nil && (port == "80" || port == "443") {
				variants = append(variants, item.scheme+"://"+host, "//"+host)
			}
			for _, v := range variants {
				out = append(out, v, strings.ReplaceAll(v, "/", `\/`))
			}
		}
	}
	return out
}

// Registry 是内网 Web 代理注册表，并发安全。
type Registry struct {
	mu    sync.Mutex
	items map[string]*Instance
	seq   int
}

// New 创建一个空的代理注册表。
func New() *Registry {
	return &Registry{items: map[string]*Instance{}}
}

// List 返回所有运行中的代理实例（仅含对外可见字段）。
func (m *Registry) List() []Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Instance, 0, len(m.items))
	for _, it := range m.items {
		out = append(out, Instance{ID: it.ID, HostID: it.HostID, Target: it.Target, URL: it.URL})
	}
	return out
}

// Start 在 hostID 对应的 SSH 通道上，为远端 target（host:port）建立一个
// 反向代理实例并返回它。useTLS 决定以 https 还是 http 访问上游。
func (m *Registry) Start(hostID string, sshClient *ssh.Client, target string, useTLS bool) (*Instance, error) {
	if sshClient == nil {
		return nil, fmt.Errorf("webproxy: ssh client is nil")
	}
	if _, _, err := net.SplitHostPort(target); err != nil {
		return nil, fmt.Errorf("webproxy: target must be host:port")
	}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	up := newUpstream(scheme, target)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	tr := newProxyTransport(sshClient, up)
	srv := &http.Server{Handler: newReverseProxy(up, tr)}

	m.mu.Lock()
	m.seq++
	inst := &Instance{
		ID:     fmt.Sprintf("wp%d", m.seq),
		HostID: hostID,
		Target: target,
		URL:    "http://" + ln.Addr().String(),
		ln:     ln,
		srv:    srv,
		up:     up,
		tr:     tr,
	}
	m.items[inst.ID] = inst
	m.mu.Unlock()

	go func() { _ = srv.Serve(ln) }()
	return inst, nil
}

// Stop 停止指定 id 的代理实例。
func (m *Registry) Stop(id string) error {
	m.mu.Lock()
	inst, ok := m.items[id]
	if ok {
		delete(m.items, id)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("webproxy not found")
	}
	inst.stop()
	return nil
}

// StopAll 停止全部代理实例。
func (m *Registry) StopAll() {
	m.mu.Lock()
	all := m.items
	m.items = map[string]*Instance{}
	m.mu.Unlock()
	for _, it := range all {
		it.stop()
	}
}

// StopByHost 停止某主机上的全部代理实例，返回停止的数量。
func (m *Registry) StopByHost(hostID string) int {
	m.mu.Lock()
	var stopped []*Instance
	for id, it := range m.items {
		if it.HostID == hostID {
			delete(m.items, id)
			stopped = append(stopped, it)
		}
	}
	m.mu.Unlock()
	for _, it := range stopped {
		it.stop()
	}
	return len(stopped)
}

func newProxyTransport(sshClient *ssh.Client, up *upstream) *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, cur := up.current()
			return sshClient.Dial("tcp", cur)
		},
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: true},
		DisableCompression: true,
		MaxIdleConns:       16,
		IdleConnTimeout:    60 * time.Second,
	}
}

func newReverseProxy(up *upstream, tr *http.Transport) *httputil.ReverseProxy {
	rp := &httputil.ReverseProxy{}

	rp.Director = func(r *http.Request) {
		proxyHost := r.Host
		stripProxyRedirect(r.URL)
		scheme, addr := up.current()
		r.URL.Scheme = scheme
		r.URL.Host = addr

		r.Host = normalizeHost(addr)

		if r.Header.Get("Origin") != "" {
			r.Header.Set("Origin", scheme+"://"+addr)
		}
		if ref := r.Header.Get("Referer"); ref != "" {
			if pu, err := url.Parse(ref); err == nil && pu.Host == proxyHost {
				stripProxyRedirect(pu)
				pu.Scheme = scheme
				pu.Host = addr
				r.Header.Set("Referer", pu.String())
			}
		}

		r.Header.Set("X-Forwarded-For", "127.0.0.1")

		for _, k := range []string{
			"X-Real-IP", "Forwarded", "Client-IP", "True-Client-IP",
			"X-Client-IP", "X-Originating-IP", "X-Remote-IP", "X-Remote-Addr",
			"CF-Connecting-IP", "Fastly-Client-IP",
		} {
			r.Header.Del(k)
		}

		r.Header.Del("Accept-Encoding")
	}

	rp.Transport = tr

	rp.ModifyResponse = func(resp *http.Response) error {
		h := resp.Header

		h.Del("X-Frame-Options")
		h.Del("Content-Security-Policy")
		h.Del("Content-Security-Policy-Report-Only")
		sanitizeCookies(h)
		followRedirect(resp, up)
		rewriteBody(resp, up.stripVariants())
		return nil
	}

	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprintf(w, "webproxy 转发失败: %v", err)
	}
	return rp
}

func normalizeHost(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if port == "80" || port == "443" {
		return host
	}
	return addr
}

func urlToAddr(u *url.URL) (string, string) {
	scheme := strings.ToLower(u.Scheme)
	if scheme == "" {
		scheme = "http"
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return scheme, net.JoinHostPort(host, port)
}

func proxyRedirectURL(rel string, generation int) string {
	u, err := url.Parse(rel)
	if err != nil {
		return rel
	}
	q := u.Query()
	q.Set(proxyRedirectParam, strconv.Itoa(generation))
	u.RawQuery = q.Encode()
	return u.RequestURI()
}

func stripProxyRedirect(u *url.URL) {
	q := u.Query()
	generation, err := strconv.Atoi(q.Get(proxyRedirectParam))
	if err != nil || generation < 1 || generation > maxFollows {
		return
	}
	q.Del(proxyRedirectParam)
	u.RawQuery = q.Encode()
}

func followRedirect(resp *http.Response, up *upstream) {
	loc := resp.Header.Get("Location")
	if loc == "" {
		return
	}
	lu, err := url.Parse(loc)
	if err != nil || lu.Host == "" {
		return
	}
	currentScheme, currentAddr := up.current()
	if lu.Scheme == "" {
		lu.Scheme = currentScheme
	}
	lu.Scheme = strings.ToLower(lu.Scheme)
	if lu.Scheme != "http" && lu.Scheme != "https" {
		return
	}
	resp.Header.Set("Cache-Control", "no-store")
	redirected := false
	scheme, addr := urlToAddr(lu)
	if scheme != currentScheme || addr != currentAddr {
		if !up.follow(scheme, addr) {
			return
		}
		redirected = true
	}
	rel := lu.RequestURI()
	if rel == "" {
		rel = "/"
	}
	if redirected {
		rel = proxyRedirectURL(rel, up.generation())
	}
	resp.Header.Set("Location", rel)
}

func rewriteBody(resp *http.Response, variants []string) {
	if len(variants) == 0 || resp.Body == nil {
		return
	}
	if resp.Header.Get("Content-Encoding") != "" {
		return
	}
	if !isTextual(resp.Header.Get("Content-Type")) {
		return
	}
	const maxBody = 8 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	_ = resp.Body.Close()
	if err != nil {
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return
	}
	s := string(body)
	for _, v := range variants {
		s = strings.ReplaceAll(s, v, "")
	}
	nb := []byte(s)
	resp.Body = io.NopCloser(bytes.NewReader(nb))
	resp.ContentLength = int64(len(nb))
	resp.Header.Set("Content-Length", strconv.Itoa(len(nb)))
}

func isTextual(ct string) bool {
	ct = strings.ToLower(ct)
	for _, t := range []string{
		"text/html", "text/css", "text/plain", "text/javascript",
		"application/javascript", "application/x-javascript", "application/json",
		"image/svg+xml",
	} {
		if strings.Contains(ct, t) {
			return true
		}
	}
	return false
}

func sanitizeCookies(h http.Header) {
	cookies := h.Values("Set-Cookie")
	if len(cookies) == 0 {
		return
	}
	h.Del("Set-Cookie")
	for _, c := range cookies {
		c = stripCookieAttr(c, "Domain")
		c = stripCookieAttr(c, "Secure")
		h.Add("Set-Cookie", c)
	}
}

func stripCookieAttr(cookie, attr string) string {
	parts := strings.Split(cookie, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		key := strings.ToLower(strings.TrimSpace(strings.SplitN(p, "=", 2)[0]))
		if key == strings.ToLower(attr) {
			continue
		}
		out = append(out, p)
	}
	return strings.Join(out, ";")
}
