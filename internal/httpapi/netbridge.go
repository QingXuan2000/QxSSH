package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	tcpWSReadLimit = 1 << 20
	tcpDialTimeout = 15 * time.Second
	tcpIdleTimeout = 5 * time.Minute
	netHTTPBodyCap = 2 << 20

	netHTTPMaxHeaders   = 64
	netHTTPMaxHeaderLen = 8 << 10
)

func checkTCPDest(addr string, port int) error {
	if addr == "" || len(addr) > 253 {
		return errors.New("地址无效")
	}
	if port < 1 || port > 65535 {
		return errors.New("端口无效")
	}
	for _, r := range addr {
		if r <= 0x20 || r == 0x7f {
			return errors.New("地址含非法字符")
		}
	}
	return nil
}

type deadlineReader struct {
	c net.Conn
	d time.Duration
}

func (r deadlineReader) Read(p []byte) (int, error) {
	_ = r.c.SetReadDeadline(time.Now().Add(r.d))
	return r.c.Read(p)
}

func (a *Gateway) serveTcpWS(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("host")
	if !a.requireExecPerm(w, r, hostID) {
		return
	}
	addr := strings.TrimSpace(r.URL.Query().Get("addr"))
	port, _ := strconv.Atoi(r.URL.Query().Get("port"))
	if err := checkTCPDest(addr, port); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	release, ok := a.acquireWSSlot(w)
	if !ok {
		return
	}
	defer release()
	target := net.JoinHostPort(addr, strconv.Itoa(port))

	var conn net.Conn
	var err error
	if hostID == "" {
		conn, err = net.DialTimeout("tcp", target, tcpDialTimeout)
	} else {
		client, gerr := a.mgr.Get(hostID)
		if gerr != nil {
			http.Error(w, "ssh: "+gerr.Error(), http.StatusBadGateway)
			return
		}
		conn, err = client.Dial("tcp", target)
	}
	if err != nil {
		http.Error(w, "dial: "+err.Error(), http.StatusBadGateway)
		return
	}

	up, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer conn.Close()
	defer up.Close()
	up.SetReadLimit(tcpWSReadLimit)
	wr := &wsWriter{c: up}
	_ = conn.SetReadDeadline(time.Now().Add(tcpIdleTimeout))

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	go wsPump(wr, deadlineReader{c: conn, d: tcpIdleTimeout}, finish, finish)

	for {
		_, data, err := up.ReadMessage()
		if err != nil {
			break
		}
		_ = conn.SetWriteDeadline(time.Now().Add(tcpIdleTimeout))
		if _, err := conn.Write(data); err != nil {
			break
		}
	}
	finish()
	_ = conn.Close()
	_ = up.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(2*time.Second))
	<-done
}

type netHTTPReq struct {
	Host     string            `json:"host"`
	URL      string            `json:"url"`
	Method   string            `json:"method"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	Timeout  int               `json:"timeout"`
	Insecure bool              `json:"insecure"`
}

type netHTTPTransportKey struct {
	host     string
	insecure bool
}

const netHTTPTransportCacheMax = 8

func (a *Gateway) netHTTPTransport(host string, insecure bool) *http.Transport {
	key := netHTTPTransportKey{host: host, insecure: insecure}
	a.netHTTPMu.Lock()
	defer a.netHTTPMu.Unlock()
	if a.netHTTPTr == nil {
		a.netHTTPTr = map[netHTTPTransportKey]*http.Transport{}
	}
	if tr, ok := a.netHTTPTr[key]; ok {
		return tr
	}
	for len(a.netHTTPTr) >= netHTTPTransportCacheMax && len(a.netHTTPOrder) > 0 {
		old := a.netHTTPOrder[0]
		a.netHTTPOrder = a.netHTTPOrder[1:]
		if tr, ok := a.netHTTPTr[old]; ok {
			tr.CloseIdleConnections()
			delete(a.netHTTPTr, old)
		}
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if host == "" {
				return (&net.Dialer{Timeout: tcpDialTimeout}).DialContext(ctx, network, addr)
			}
			client, err := a.mgr.Get(host)
			if err != nil {
				return nil, err
			}
			return client.Dial(network, addr)
		},
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: insecure},
		ForceAttemptHTTP2: false,
	}
	a.netHTTPTr[key] = tr
	a.netHTTPOrder = append(a.netHTTPOrder, key)
	return tr
}

func (a *Gateway) closeNetHTTPTransports() {
	a.netHTTPMu.Lock()
	for _, tr := range a.netHTTPTr {
		tr.CloseIdleConnections()
	}
	a.netHTTPTr = nil
	a.netHTTPOrder = nil
	a.netHTTPMu.Unlock()
}

func (a *Gateway) handleNetHTTP(w http.ResponseWriter, r *http.Request) {
	var req netHTTPReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !a.requireExecPerm(w, r, req.Host) {
		return
	}
	if req.URL == "" || strings.ContainsAny(req.URL, " \t\r\n\"") {
		writeErr(w, http.StatusBadRequest, errors.New("url required"))
		return
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	switch method {
	case "":
		method = http.MethodGet
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions:
	default:
		writeErr(w, http.StatusBadRequest, errors.New("不支持的 method"))
		return
	}
	sec := req.Timeout
	if sec <= 0 {
		sec = 30
	} else if sec > 60 {
		sec = 60
	}

	tr := a.netHTTPTransport(req.Host, req.Insecure)
	client := &http.Client{
		Transport: tr,
		Timeout:   time.Duration(sec) * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	httpReq, err := http.NewRequest(method, req.URL, strings.NewReader(req.Body))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	if len(req.Headers) > netHTTPMaxHeaders {
		writeErr(w, http.StatusBadRequest,
			errors.New("headers 条数过多"))
		return
	}
	for k, v := range req.Headers {
		if len(k) > netHTTPMaxHeaderLen || len(v) > netHTTPMaxHeaderLen {
			writeErr(w, http.StatusBadRequest, errors.New("单个 header 过长"))
			return
		}
		if strings.EqualFold(k, "host") {
			httpReq.Host = v
			continue
		}
		httpReq.Header.Set(k, v)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, netHTTPBodyCap+1))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	truncated := len(raw) > netHTTPBodyCap
	if truncated {
		raw = raw[:netHTTPBodyCap]
	}
	encoding := "text"
	body := string(raw)
	if !utf8.Valid(raw) {
		encoding = "base64"
		body = base64.StdEncoding.EncodeToString(raw)
	}
	headers := map[string]string{}
	for k, vs := range resp.Header {
		headers[k] = strings.Join(vs, ", ")
	}
	a.log.Debug("net http", "host", req.Host, "method", method, "status", resp.StatusCode)
	writeJSON(w, netHTTPResp{
		Status:    resp.StatusCode,
		Headers:   headers,
		Body:      body,
		Encoding:  encoding,
		Truncated: truncated,
	})
}
