// Command qxssh 启动 QxSSH —— 一个自托管的 SSH 管理控制台。
//
// 它解析命令行参数，做启动前的安全校验（监听非回环地址时强制要求鉴权令牌），
// 初始化加密配置存储与日志，装配运行时并启动 HTTP 服务，最后等待退出信号做优雅关闭。
package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"qxssh/internal/bootstrap"
	"qxssh/internal/config"
	"qxssh/internal/httpapi"
	"qxssh/internal/logging"
)

const banner = `
   ____      __  __
  /___ \_  _/ _\/ _\  /\  /\
 //  / | \/ | \ \ \  / /_/ /
/ \_/ / >  <_\ \_\ \/ __  /
\___,_\/_/\_\__/\__/\/ /_/

--------QxSSH v` + bootstrap.Version + `--------

`

func main() {
	os.Exit(run())
}

// isLoopbackListen 判断监听地址是否指向回环（127.0.0.0/8、::1、localhost）。
// 空主机（如 ":8800"）视为非回环，因为它会监听所有网卡。
func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// openBrowser 用系统默认浏览器打开 url，按当前操作系统选择合适的外部命令。
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// run 是程序的真正主体，返回进程退出码（0 表示正常）。
func run() int {
	addr := flag.String("addr", "127.0.0.1:8800", "listen address")
	confDir := flag.String("conf", "", "config directory (default: user config dir)")
	open := flag.Bool("open", false, "open the console URL in the default browser on startup")
	logLevel := flag.String("log-level", os.Getenv("QXSSH_LOG_LEVEL"), "log level: debug|info|warn|error|silent")
	logFile := flag.String("log-file", os.Getenv("QXSSH_LOG_FILE"), "log file path; 'auto' = <conf>/logs/qxssh.log; empty = stdout only")
	authToken := flag.String("auth-token", os.Getenv("QXSSH_AUTH_TOKEN"), "optional auth token for remote access; empty = no auth")
	kidRotate := flag.Bool("kid-rotate", false, "rotate the IdP signing key at startup; the old key is kept for token verification")
	flag.Parse()

	if *authToken != "" {
		_ = os.Setenv("QXSSH_AUTH_TOKEN", *authToken)
	}

	if *authToken == "" && !isLoopbackListen(*addr) {
		fmt.Fprintf(os.Stderr,
			"拒绝启动：监听地址 %q 非回环，但未配置 -auth-token（或环境变量 QXSSH_AUTH_TOKEN）。\n"+
				"无鉴权地暴露到网络会把全部主机凭据与命令执行能力公开给任何能访问该地址的人。\n"+
				"请配置鉴权令牌后重试，或改用回环地址（127.0.0.1）。\n", *addr)
		return 1
	}

	fmt.Print(banner)

	store, err := config.Load(*confDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}

	level := logging.ParseLevel(*logLevel)
	lg := logging.New(level)
	switch *logFile {
	case "":
	case "auto":
		if err := lg.SetFile(logging.DefaultFile(store.Dir())); err != nil {
			lg.Warn("log file disabled", "error", err.Error())
		}
	default:
		path := *logFile
		if !filepath.IsAbs(path) {
			path = filepath.Join(store.Dir(), path)
		}
		if err := lg.SetFile(path); err != nil {
			lg.Warn("log file disabled", "error", err.Error())
		}
	}
	defer lg.Close()

	if *kidRotate {
		if err := httpapi.RotateIDPKeys(store.Dir()); err != nil {
			fmt.Fprintf(os.Stderr, "rotate signing key: %v\n", err)
			return 1
		}
		fmt.Println("签名密钥已轮换；旧密钥保留在 <conf>/keys/archive/ 仅用于验签。")
	}

	srv, err := bootstrap.New(store, lg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "初始化失败: %v\n", err)
		return 1
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		lg.Error("listen failed", "addr", *addr, "error", err.Error())
		return 1
	}

	hostCount := len(store.ListHosts())
	lg.Info("QxSSH started",
		"version", bootstrap.Version,
		"addr", "http://"+ln.Addr().String(),
		"configDir", store.Dir(),
		"hosts", hostCount,
		"logLevel", strings.ToLower(level.String()),
	)
	if p := lg.Path(); p != "" {
		lg.Info("log file", "path", p)
	}
	url := "http://" + ln.Addr().String()
	fmt.Printf("QxSSH running at %s\n", url)
	if *open {
		if err := openBrowser(url); err != nil {
			lg.Warn("open browser failed", "error", err.Error())
		}
	}
	fmt.Println("Press Ctrl+C to stop.")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigCh)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	select {
	case sig := <-sigCh:
		fmt.Println("\nshutting down...")
		lg.Info("shutting down", "signal", sig.String())
		srv.Shutdown()
		<-serveErr
		return 0
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			lg.Error("serve failed", "error", err.Error())
			return 1
		}
		return 0
	}
}
