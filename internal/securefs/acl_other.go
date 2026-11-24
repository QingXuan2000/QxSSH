//go:build !windows

package securefs

// Protect is a no-op on platforms where Windows DACLs do not apply.
func Protect(string) error { return nil }
