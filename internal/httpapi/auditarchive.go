package httpapi

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	archiveDataEntry = "audit.jsonl"

	archiveMetaEntry = "meta.json"

	archivePrefix = "audit-"
	archiveExt    = ".zip"
	archiveStamp  = "20060102-150405"

	archiveTmpSuffix = ".tmp"

	archiveNameTries = 100

	redactedValue = "***"

	sanitizeMaxDepth = 24
)

func isArchiveFile(name string) bool {
	rest, ok := strings.CutPrefix(name, archivePrefix)
	if !ok {
		return false
	}
	mid, ok := strings.CutSuffix(rest, archiveExt)
	return ok && mid != ""
}

const redactRuleDoc = "按字段名/请求头名匹配 password、passwd、passphrase、pwd、keyData、" +
	"keyPassphrase、privateKey、secret、token、cookie、authorization、sudo、credential、" +
	"apiKey、session，命中的值替换为 " + redactedValue + "；PEM 私钥整段替换。" +
	"脱敏只认名字、不判断内容——命名不常规的敏感内容可能漏出，别把归档当合规证据。"

var auditSensitiveName = regexp.MustCompile(`(?i)pass(word|wd|phrase)?|pwd|` +
	`key[_-]?(data|passphrase)|private[_-]?key|secret|token|cookie|authoriz|sudo|credential|api[_-]?key|session`)

var auditSecretPair = regexp.MustCompile(`(?i)(password|passwd|passphrase|pwd|keydata|` +
	`keypassphrase|private[_-]?key|token|secret|authorization|cookie|sudo)([ \t]*[:=][ \t]*)` +
	`("[^"]*"|'[^']*'|[^\s,;&}]+)`)

type auditArchiveMeta struct {
	Created   string `json:"created"`
	Group     string `json:"group"`
	HostID    string `json:"hostId"`
	Entries   int    `json:"entries"`
	Sanitized bool   `json:"sanitized"`
	Encrypted bool   `json:"encrypted"`
	Redacted  string `json:"redacted"`
	Note      string `json:"note"`
}

type archiveEntryJSON struct {
	Seq     uint64        `json:"seq"`
	Time    time.Time     `json:"time"`
	HostID  string        `json:"hostId,omitempty"`
	AppID   string        `json:"appId,omitempty"`
	Type    string        `json:"type"`
	Target  string        `json:"target,omitempty"`
	Detail  string        `json:"detail,omitempty"`
	Result  string        `json:"result,omitempty"`
	DurMS   int64         `json:"durationMs,omitempty"`
	Verbose *auditVerbose `json:"verbose,omitempty"`
}

func buildAuditArchive(entries []auditEntry, group string, now time.Time) (zipBytes []byte, metaJSON string) {
	if len(entries) == 0 {
		return nil, ""
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	mw, err := zw.Create(archiveMetaEntry)
	if err != nil {
		return nil, ""
	}
	meta, _ := json.MarshalIndent(auditArchiveMeta{
		Created:   now.Format(time.RFC3339),
		Group:     group,
		HostID:    hostIDOfGroup(group),
		Entries:   len(entries),
		Sanitized: true,
		Encrypted: false,
		Redacted:  redactRuleDoc,
		Note: "只存脱敏后的内容，不含原始密码/token，所以没有加密；" +
			"需要原文请在归档发生前用审计应用查看明细，或关闭详细记录。",
	}, "", "  ")
	if _, err := mw.Write(meta); err != nil {
		return nil, ""
	}

	dw, err := zw.Create(archiveDataEntry)
	if err != nil {
		return nil, ""
	}
	enc := json.NewEncoder(dw)
	enc.SetEscapeHTML(false)
	for i := range entries {

		ae := archiveEntryJSON{
			Seq:     entries[i].Seq,
			Time:    entries[i].Time,
			HostID:  entries[i].HostID,
			AppID:   entries[i].AppID,
			Type:    string(entries[i].Type),
			Target:  entries[i].Target,
			Detail:  entries[i].Detail,
			Result:  entries[i].Result,
			DurMS:   entries[i].Duration,
			Verbose: sanitizeVerbose(entries[i].Verbose),
		}
		if err := enc.Encode(ae); err != nil {
			return nil, ""
		}
	}
	if err := zw.Close(); err != nil {
		return nil, ""
	}
	return buf.Bytes(), string(meta)
}

func readArchiveEntries(path string, maxBytes int64) []auditEntry {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != archiveDataEntry {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		defer rc.Close()
		var r io.Reader = rc
		if maxBytes > 0 {
			r = io.LimitReader(rc, maxBytes)
		}
		br := bufio.NewReader(r)
		var out []auditEntry
		for {
			line, rerr := br.ReadBytes('\n')
			if b := bytes.TrimSpace(line); len(b) > 0 {
				var ae archiveEntryJSON
				if json.Unmarshal(b, &ae) == nil && !ae.Time.IsZero() {
					out = append(out, auditEntry{
						Seq: ae.Seq, Time: ae.Time, HostID: ae.HostID, AppID: ae.AppID,
						Type: auditType(ae.Type), Target: ae.Target, Detail: ae.Detail,
						Result: ae.Result, Duration: ae.DurMS, Verbose: ae.Verbose,
					})
				}
			}
			if rerr != nil {
				break
			}
		}
		return out
	}
	return nil
}

func sanitizeVerbose(v *auditVerbose) *auditVerbose {
	if v == nil {
		return nil
	}
	out := *v
	if v.Query != "" {
		out.Query = sanitizeAuditQuery(v.Query)
	}
	if len(v.Headers) > 0 {
		h := make(map[string]string, len(v.Headers))
		for k, val := range v.Headers {
			if auditSensitiveName.MatchString(k) {

				h[k] = redactedValue
				continue
			}
			h[k] = truncStr(val, auditHeaderMax)
		}
		out.Headers = h
	}
	if v.Body != "" {
		out.Body = sanitizeAuditBody(v.Body)
	}

	if v.RespError != "" {
		out.RespError = redactAuditPlain(truncStr(v.RespError, auditRespErrMax))
	}
	out.Agent = truncStr(v.Agent, 256)
	out.Referer = truncStr(v.Referer, 320)
	out.Origin = truncStr(v.Origin, 256)
	return &out
}

func sanitizeAuditQuery(raw string) string {
	parts := strings.Split(raw, "&")
	for i, p := range parts {
		k, _, ok := strings.Cut(p, "=")
		if ok && auditSensitiveName.MatchString(k) {
			parts[i] = k + "=" + redactedValue
		}
	}
	return strings.Join(parts, "&")
}

func sanitizeAuditBody(body string) string {
	t := strings.TrimSpace(body)
	if t == "" {
		return body
	}

	if t[0] == '{' || t[0] == '[' {
		var v any
		if err := json.Unmarshal([]byte(t), &v); err == nil {
			if out, err := json.Marshal(sanitizeAuditValue(v, 0)); err == nil {
				return string(out)
			}
		}
	}

	if strings.HasPrefix(t, "-----BEGIN") {
		return redactedValue + "（疑似私钥内容，已整体脱敏）"
	}
	return redactAuditPlain(body)
}

func sanitizeAuditValue(v any, depth int) any {
	if depth > sanitizeMaxDepth {
		return redactedValue
	}
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if auditSensitiveName.MatchString(k) {
				out[k] = redactedValue
				continue
			}
			out[k] = sanitizeAuditValue(val, depth+1)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = sanitizeAuditValue(val, depth+1)
		}
		return out
	default:
		return v
	}
}

func redactAuditPlain(s string) string {
	return auditSecretPair.ReplaceAllString(s, "${1}${2}"+redactedValue)
}
