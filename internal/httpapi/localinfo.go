package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

type localHostInfo struct {
	Home      string `json:"home"`
	TempDir   string `json:"tempDir"`
	ConfigDir string `json:"configDir"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
	PathSep   string `json:"pathSep"`

	Env map[string]string `json:"env,omitempty"`
}

var hostEnvKeys = []string{
	"ProgramFiles", "ProgramFiles(x86)", "LocalAppData", "QXSSH_BROWSER",
}

func (a *Gateway) handleLocalHostInfo(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	env := make(map[string]string, len(hostEnvKeys))
	for _, k := range hostEnvKeys {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
	}
	writeJSON(w, localHostInfo{
		Home:      home,
		TempDir:   absOrSelf(os.TempDir()),
		ConfigDir: absOrSelf(a.configDir),
		GOOS:      runtime.GOOS,
		GOARCH:    runtime.GOARCH,
		PathSep:   string(os.PathSeparator),
		Env:       env,
	})
}

func absOrSelf(dir string) string {
	if dir == "" {
		return ""
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return dir
	}
	return abs
}
