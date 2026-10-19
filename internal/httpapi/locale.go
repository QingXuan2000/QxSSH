package httpapi

import "strings"

func posixLocale(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" || tag == "*" {
		return ""
	}

	parts := strings.FieldsFunc(tag, func(r rune) bool { return r == '-' || r == '_' })
	if len(parts) == 0 {
		return ""
	}
	lang := parts[0]
	if !isAlpha(lang) || len(lang) < 2 || len(lang) > 3 {
		return ""
	}
	out := strings.ToLower(lang)

	if len(parts) > 1 && isAlpha(parts[1]) && len(parts[1]) == 2 {
		out += "_" + strings.ToUpper(parts[1])
	}
	return out + ".UTF-8"
}

func isAlpha(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') {
			return false
		}
	}
	return true
}
