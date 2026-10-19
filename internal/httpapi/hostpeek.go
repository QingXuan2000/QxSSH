package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"regexp"
	"strings"
)

const auditWSParam = "qxws"

var hostFieldRe = regexp.MustCompile(`"host"\s*:\s*"([A-Za-z0-9_\-]{1,64})"`)

const hostPeekMax = 4096

type peekBody struct {
	io.Reader
	closer io.Closer
	head   []byte
	rest   io.Reader
	hostID string
	valid  bool
}

func (p *peekBody) Close() error { return p.closer.Close() }

func readUpTo(r io.Reader, buf []byte) int {
	n := 0
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if err != nil {
			break
		}
	}
	return n
}

func peekHostID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if p, ok := r.Body.(*peekBody); ok && p.valid {
		return p.hostID
	}
	q := r.URL.Query()
	if v := strings.TrimSpace(q.Get("host")); v != "" && safeHostID(v) {
		return v
	}
	if v := strings.TrimSpace(q.Get(auditWSParam)); v != "" && safeHostID(v) {
		return v
	}
	if r.Body == nil || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return ""
	}
	buf := make([]byte, hostPeekMax)
	n := readUpTo(r.Body, buf)
	if n == 0 {
		return ""
	}
	body := r.Body
	head := buf[:n]
	p := &peekBody{
		Reader: io.MultiReader(bytes.NewReader(head), body),
		closer: body,
		head:   head,
		rest:   body,
		valid:  true,
	}
	r.Body = p
	if m := hostFieldRe.FindSubmatch(head); m != nil && safeHostID(string(m[1])) {
		p.hostID = string(m[1])
	}
	return p.hostID
}

func safeHostID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
