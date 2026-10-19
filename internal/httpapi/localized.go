package httpapi

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

type localizedText struct {
	text string

	byLang map[string]string
}

func (t *localizedText) UnmarshalJSON(b []byte) error {
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "null" {
		*t = localizedText{}
		return nil
	}
	if strings.HasPrefix(trimmed, `"`) {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*t = localizedText{text: s}
		return nil
	}
	if strings.HasPrefix(trimmed, "{") {
		var m map[string]string
		if err := json.Unmarshal(b, &m); err != nil {
			return err
		}

		if m == nil {
			m = map[string]string{}
		}
		*t = localizedText{byLang: m}
		return nil
	}
	return errors.New(`文案字段只接受字符串或 {"语言": "文案"} 对象`)
}

func (t localizedText) MarshalJSON() ([]byte, error) {
	if t.byLang != nil {
		return json.Marshal(t.byLang)
	}
	return json.Marshal(t.text)
}

func (t localizedText) IsZero() bool {
	if strings.TrimSpace(t.text) != "" {
		return false
	}
	for _, v := range t.byLang {
		if strings.TrimSpace(v) != "" {
			return false
		}
	}
	return true
}

func (t localizedText) Get(lang string) string {
	if len(t.byLang) == 0 {
		return t.text
	}
	keys := sortedKeys(t.byLang)
	if s := lookupLang(t.byLang, keys, lang); s != "" {
		return s
	}
	if s := t.byLang[defaultLang]; s != "" {
		return s
	}
	for _, k := range keys {
		if s := t.byLang[k]; s != "" {
			return s
		}
	}
	return ""
}

func normalizeTag(tag string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(tag), "_", "-"))
}

func primaryTag(tag string) string {
	if i := strings.IndexByte(tag, '-'); i >= 0 {
		return tag[:i]
	}
	return tag
}

func scriptTag(tag string) string {
	parts := strings.Split(tag, "-")
	if len(parts) >= 2 && len(parts[1]) == 4 {
		return parts[1]
	}
	return ""
}

func lookupLang(byLang map[string]string, keys []string, lang string) string {
	want := normalizeTag(lang)
	if want == "" {
		return ""
	}
	base := primaryTag(want)
	script := scriptTag(want)
	for _, k := range keys {
		if normalizeTag(k) == want {
			return byLang[k]
		}
	}
	for _, k := range keys {
		n := normalizeTag(k)
		if primaryTag(n) == base && scriptTag(n) == script {
			return byLang[k]
		}
	}
	for _, k := range keys {
		if primaryTag(normalizeTag(k)) == base {
			return byLang[k]
		}
	}
	return ""
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
