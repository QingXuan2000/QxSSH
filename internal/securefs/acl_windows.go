//go:build windows

package securefs

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	advapi32ACL         = syscall.NewLazyDLL("advapi32.dll")
	kernel32ACL         = syscall.NewLazyDLL("kernel32.dll")
	procConvertSDDL     = advapi32ACL.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procSetFileSecurity = advapi32ACL.NewProc("SetFileSecurityW")
	procLocalFree       = kernel32ACL.NewProc("LocalFree")
)

const daclSecurityInformation = 0x00000004

// Protect replaces a file's DACL with explicit full-control entries for SYSTEM
// and the file owner only. Callers must fail closed if it returns an error.
func Protect(path string) error {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sddl, err := syscall.UTF16PtrFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)")
	if err != nil {
		return err
	}
	var sd uintptr
	var size uint32
	r1, _, callErr := procConvertSDDL.Call(
		uintptr(unsafe.Pointer(sddl)), 1,
		uintptr(unsafe.Pointer(&sd)), uintptr(unsafe.Pointer(&size)),
	)
	if r1 == 0 {
		return fmt.Errorf("convert secure DACL: %w", callErr)
	}
	defer procLocalFree.Call(sd)
	r1, _, callErr = procSetFileSecurity.Call(
		uintptr(unsafe.Pointer(pathPtr)), daclSecurityInformation, sd,
	)
	if r1 == 0 {
		return fmt.Errorf("set secure DACL on %q: %w", path, callErr)
	}
	return nil
}
