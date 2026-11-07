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

// Stats 记录一个代理实例最近的文档级请求轨迹，供前端还原地址栏与内网导航状态。
// 只统计「地址栏级导航」（document）：子资源（脚本、样式、接口）只累加 Hits，
// 否则最后一个 404/500 的子请求会把状态栏刷成错误。
type Stats struct {
	mu       sync.Mutex
	path     string
	query    string
	upstream string
	status   int
	err      string
	hits     int64
	at       time.Time
}

// State 是代理实例的对外快照，直接以 JSON 返回给前端。
type State struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Target   string `json:"target"`
	Upstream string `json:"upstream"`
	Path     string `json:"path"`
	Query    string `json:"query"`
	Status   int    `json:"status"`
	Error    string `json:"error"`
	Hits     int64  `json:"hits"`
	At       int64  `json:"at"`
}

func newStats() *Stats { return &Stats{} }

// recordRequest 记录一次请求；命中次数对所有请求累加，路径只对文档请求覆盖。
func (s *Stats) recordRequest(r *http.Request, upstream string) {
	s.mu.Lock()
	s.hits++
	if isDocumentRequest(r) {
		p := r.URL.Path
		if p == "" {
			p = "/"
		}
		s.path, s.query, s.upstream = p, r.URL.RawQuery, upstream
		s.at = time.Now()
	}
	s.mu.Unlock()
}

// recordResponse 记录响应码；文档请求的状态码覆盖上一条，子资源的 5xx 也记下来。
func (s *Stats) recordResponse(r *http.Request, status int) {
	s.mu.Lock()
	if isDocumentRequest(r) {
		s.status = status
		s.err = ""
		s.at = time.Now()
	} else if status >= http.StatusInternalServerError {
		s.status = status
	}
	s.mu.Unlock()
}

// recordError 记录转发失败：文档请求必然覆盖，子资源只在还没有任何状态码时落一笔。
func (s *Stats) recordError(r *http.Request, err error) {
	s.mu.Lock()
	if isDocumentRequest(r) || s.status == 0 {
		s.status = http.StatusBadGateway
		s.err = err.Error()
		s.at = time.Now()
	}
	s.mu.Unlock()
}

func (s *Stats) snapshot(id, link, target string) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return State{
		ID: id, URL: link, Target: target,
		Upstream: s.upstream, Path: s.path, Query: s.query,
		Status: s.status, Error: s.err, Hits: s.hits,
		At: s.at.UnixMilli(),
	}
}

// isDocumentRequest 判断是否地址栏级导航：优先看 Sec-Fetch-Dest，缺省时看 Accept 是否要 HTML。
func isDocumentRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	switch strings.ToLower(r.Header.Get("Sec-Fetch-Dest")) {
	case "document", "iframe", "frame":
		return true
	case "":
		return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
	}
	return false
}

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
	st  *Stats
}

// State 返回该实例最近一次文档请求的轨迹快照。
func (it *Instance) State() State {
	if it.st == nil {
		return State{ID: it.ID, URL: it.URL, Target: it.Target}
	}
	return it.st.snapshot(it.ID, it.URL, it.Target)
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

// adopt 在一个新代理实例启动时直接确定上游（不走重定向计数），
// 用于把「纯 HTTP 目标会自己跳 HTTPS」这件事在服务端提前消化掉。
func (u *upstream) adopt(scheme, addr string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if scheme == u.scheme && addr == u.addr {
		return
	}
	u.scheme, u.addr = scheme, addr
	for _, o := range u.seen {
		if o.scheme == scheme && o.addr == addr {
			return
		}
	}
	u.seen = append(u.seen, origin{scheme: scheme, addr: addr})
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
	if !useTLS {
		probeUpgrade(sshClient, up)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	tr := newProxyTransport(sshClient)
	st := newStats()
	srv := &http.Server{Handler: newReverseProxy(up, tr, st)}

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
		st:     st,
	}
	m.items[inst.ID] = inst
	m.mu.Unlock()

	go func() { _ = srv.Serve(ln) }()
	return inst, nil
}

// State 返回指定代理实例最近一次文档请求的轨迹快照。
func (m *Registry) State(id string) (State, error) {
	m.mu.Lock()
	it, ok := m.items[id]
	m.mu.Unlock()
	if !ok {
		return State{}, fmt.Errorf("webproxy not found")
	}
	return it.State(), nil
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

// newProxyTransport 让每个连接都拨到 Transport 自己解析出来的目标。
// 之前这里忽略 addr、直接拨 upstream 的当前值，重定向期间并发到达的子资源请求
// 可能在「Host 头取的是旧上游、拨号取的是新上游」之间错位，命中对面站点不存在的
// 路径而拿到 4xx；改成按 addr 拨号后，URL/SNI/Host/连接四者永远指向同一个上游。
func newProxyTransport(sshClient *ssh.Client) *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return sshClient.Dial("tcp", addr)
		},
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: true},
		DisableCompression: true,
		MaxIdleConns:       16,
		IdleConnTimeout:    60 * time.Second,
	}
}

// probeUpgrade 在启动代理前先自己走一遍「HTTP 目标的重定向链」，如果链路终点落在
// HTTPS 上，就把上游直接定到终点。公开站点（bing.com 这类）在 80 端口通常只留一条
// 301/302 指向 https，个别站点还要先换域名再升协议；这条链交给浏览器跟，意味着地址栏
// 里要串好几轮相对 Location 往返，内嵌窗口一旦在其中一环解析错了就是一页错误。
// 服务端提前走完，浏览器只发起一次文档请求。
func probeUpgrade(cl *ssh.Client, up *upstream) {
	if cl == nil {
		return
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return cl.Dial("tcp", addr)
		},
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: true},
		DisableCompression: true,
		DisableKeepAlives:  true,
	}
	defer tr.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	scheme, addr := up.current()
	cur := scheme + "://" + addr + "/"
	for hop := 0; hop < maxFollows; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, cur, nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
		req.Header.Set("Accept", "text/html,application/xhtml+xml")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		code := resp.StatusCode
		loc := resp.Header.Get("Location")
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8<<10))
		_ = resp.Body.Close()
		if code < 300 || code >= 400 || loc == "" {
			return
		}
		base, err := url.Parse(cur)
		if err != nil {
			return
		}
		lu, err := url.Parse(loc)
		if err != nil {
			return
		}
		lu = base.ResolveReference(lu)
		if lu.Host == "" || len(lu.Scheme) > 5 {
			return
		}
		ns, naddr := urlToAddr(lu)
		if ns != "http" && ns != "https" {
			return
		}
		if ns == "https" {
			up.adopt(ns, naddr)
			return
		}
		path := lu.EscapedPath()
		if path == "" {
			path = "/"
		}
		cur = ns + "://" + naddr + path
		if lu.RawQuery != "" {
			cur += "?" + lu.RawQuery
		}
	}
}

func newReverseProxy(up *upstream, tr *http.Transport, st *Stats) *httputil.ReverseProxy {
	rp := &httputil.ReverseProxy{}

	rp.Director = func(r *http.Request) {
		proxyHost := r.Host
		stripProxyRedirect(r.URL)
		scheme, addr := up.current()
		st.recordRequest(r, scheme+"://"+addr)
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

		st.recordResponse(resp.Request, resp.StatusCode)

		h.Del("X-Frame-Options")
		h.Del("Content-Security-Policy")
		h.Del("Content-Security-Policy-Report-Only")
		sanitizeCookies(h)
		followRedirect(resp, up)
		rewriteBody(resp, up.stripVariants())
		return nil
	}

	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		st.recordError(r, err)
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
