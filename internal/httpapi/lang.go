package httpapi

import (
	"errors"
	"net/http"
	"strings"
)

var errBadQValue = errors.New("q 值非法")

var supportedLangs = []langInfo{
	{Code: "zh-CN", Label: "简体中文"},
	{Code: "en-US", Label: "English"},
}

const defaultLang = "zh-CN"

type langInfo struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}

func (a *Gateway) handleLanguages(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, languagesResp{Languages: supportedLangs, Default: defaultLang})
}

func (a *Gateway) handleLangNegotiate(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, langResp{Lang: negotiateLang(r.Header.Get("Accept-Language"))})
}

func negotiateLang(header string) string {
	if header == "" {
		return defaultLang
	}
	type pref struct {
		tag string
		q   float64
	}
	var prefs []pref
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		tag := part
		q := 1.0
		if i := strings.IndexByte(part, ';'); i >= 0 {
			tag = strings.TrimSpace(part[:i])
			for _, param := range strings.Split(part[i+1:], ";") {
				param = strings.TrimSpace(param)
				if !strings.HasPrefix(param, "q=") {
					continue
				}

				if v, err := parseQValue(param[2:]); err == nil {
					q = v
				}
			}
		}
		if tag == "" || q <= 0 {
			continue
		}
		prefs = append(prefs, pref{tag: tag, q: q})
	}

	for i := 1; i < len(prefs); i++ {
		for j := i; j > 0 && prefs[j].q > prefs[j-1].q; j-- {
			prefs[j], prefs[j-1] = prefs[j-1], prefs[j]
		}
	}
	for _, p := range prefs {
		if p.tag == "*" {
			return defaultLang
		}
		for _, l := range supportedLangs {
			if strings.EqualFold(p.tag, l.Code) {
				return l.Code
			}
		}

		main := p.tag
		if i := strings.IndexAny(main, "-_"); i > 0 {
			main = main[:i]
		}
		for _, l := range supportedLangs {
			lm := l.Code
			if i := strings.IndexAny(lm, "-_"); i > 0 {
				lm = lm[:i]
			}
			if strings.EqualFold(main, lm) {
				return l.Code
			}
		}
	}
	return defaultLang
}

func parseQValue(s string) (float64, error) {
	if s == "" {
		return 0, errBadQValue
	}
	var whole, frac float64
	var digits int
	i := 0
	for ; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		whole = whole*10 + float64(s[i]-'0')
	}
	if i < len(s) && s[i] == '.' {
		i++
		for ; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
			if digits < 3 {
				frac = frac*10 + float64(s[i]-'0')
				digits++
			}
		}
	}
	if i != len(s) {
		return 0, errBadQValue
	}
	v := whole
	if digits > 0 {
		scale := 1.0
		for ; digits > 0; digits-- {
			scale /= 10
		}
		v += frac * scale
	}
	if v < 0 || v > 1 {
		return 0, errBadQValue
	}
	return v, nil
}
