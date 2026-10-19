// Package bootstrap 负责 QxSSH 的运行时装配与生命周期管理。
//
// 它把配置存储、SSH 连接池、端口转发注册表、内网 Web 代理注册表和 HTTP 网关
// 组装成一个 Runtime，注册“主机失效即停止其转发/代理”的联动钩子，并在退出时
// 按 HTTP → 后台任务 → 转发/代理 → 连接池 → 配置库 的顺序做优雅关闭。
package bootstrap

import (
	"context"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"qxssh/internal/config"
	"qxssh/internal/httpapi"
	"qxssh/internal/logging"
	"qxssh/internal/proxy"
	"qxssh/internal/sshpool"
	"qxssh/internal/tunnel"
)

// Runtime 持有 QxSSH 运行期间的全部长生命周期组件及其关闭逻辑。
type Runtime struct {
	mgr      *sshpool.Pool
	tunnels  *tunnel.Registry
	proxies  *proxy.Registry
	http     *http.Server
	store    *config.Store
	closeAPI func()
	log      *logging.Logger

	closeOnce sync.Once
	closed    atomic.Bool
}

// Version 是 QxSSH 的版本号，会在启动横幅与 version API 中展示。
const Version = "1.0.0"

// httpShutdownTimeout 是 HTTP 服务优雅关闭时等待在途请求完成的最长时间。
const httpShutdownTimeout = 5 * time.Second

// New 组装并返回一个 Runtime。log 为 nil 时使用默认的 info 级日志。
// 它同时建立“SSH 连接失效 → 停止该主机上的转发与代理”的联动。
// 签名密钥等初始化失败时返回 error：宁可起不来，也不要给出一个应用拿不到可用令牌的半可用服务。
func New(store *config.Store, log *logging.Logger) (*Runtime, error) {
	if log == nil {
		log = logging.New(logging.LevelInfo)
	}
	mgr := sshpool.New(store, log)
	tunnels := tunnel.New(mgr, store)
	wp := proxy.New()
	handler, closeAPI, err := httpapi.New(store, mgr, tunnels, wp, Version, store.Dir(), log)
	if err != nil {
		return nil, err
	}
	mgr.OnInvalidate(func(hostID string) {
		if n := tunnels.StopByHost(hostID); n > 0 {
			log.Info("ssh invalidated: stopped tunnels", "host", hostID, "count", n)
		}
		if n := wp.StopByHost(hostID); n > 0 {
			log.Info("ssh invalidated: stopped webproxies", "host", hostID, "count", n)
		}
	})
	return &Runtime{
		mgr:      mgr,
		tunnels:  tunnels,
		proxies:  wp,
		store:    store,
		closeAPI: closeAPI,
		http: &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
			MaxHeaderBytes:    1 << 20,
		},
		log: log,
	}, nil
}

// Serve 在给定监听器上提供 HTTP 服务，是阻塞调用；关闭后返回 http.ErrServerClosed。
func (a *Runtime) Serve(ln net.Listener) error {
	if a.closed.Load() {
		return http.ErrServerClosed
	}
	return a.http.Serve(ln)
}

// Shutdown 优雅停止全部组件。它只执行一次，重复调用是安全的。
func (a *Runtime) Shutdown() {
	a.closeOnce.Do(func() {
		a.closed.Store(true)
		ctx, cancel := context.WithTimeout(context.Background(), httpShutdownTimeout)
		defer cancel()
		if err := a.http.Shutdown(ctx); err != nil {
			a.log.Warn("http graceful shutdown incomplete", "error", err.Error())
			_ = a.http.Close()
		}
		a.log.Info("shutdown: stopping background exec, proxies and tunnels")
		if a.closeAPI != nil {
			a.closeAPI()
		}
		a.proxies.StopAll()
		a.tunnels.StopAll()
		a.mgr.CloseAll()

		if a.store != nil {
			if err := a.store.Close(); err != nil {
				a.log.Warn("config db close failed", "error", err.Error())
			}
		}
	})
}
