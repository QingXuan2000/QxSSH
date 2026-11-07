package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"qxssh/internal/tunnel"
)

// tunnelStartPerms 返回「启动这条转发」可接受的权限键，命中任意一个即放行。
// 细粒度节点优先，tunnel:start / tunnel:local 是旧版兼容节点。
func tunnelStartPerms(req tunnel.Options) []string {
	if req.Proto == "udp" {
		return []string{"tunnel:udp:local", "tunnel:local", "tunnel:start"}
	}
	switch req.Type {
	case "remote":
		return []string{"tunnel:tcp:remote", "tunnel:start"}
	case "dynamic":
		return []string{"tunnel:tcp:socks", "tunnel:local", "tunnel:start"}
	default:
		return []string{"tunnel:tcp:local", "tunnel:local", "tunnel:start"}
	}
}

// tunnelStopPerms 同上，但按已登记的实例判断它是 TCP 还是 UDP。
func tunnelStopPerms(it tunnel.Running, known bool) []string {
	if known && it.Proto == "udp" {
		return []string{"tunnel:udp:stop", "tunnel:local", "tunnel:stop"}
	}
	if known && it.Type == "remote" {
		return []string{"tunnel:tcp:stop", "tunnel:stop"}
	}
	return []string{"tunnel:tcp:stop", "tunnel:local", "tunnel:stop"}
}

func (a *Gateway) handleStartTunnel(w http.ResponseWriter, r *http.Request) {
	var req tunnel.Options
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.Type != "local" && req.Type != "remote" && req.Type != "dynamic" {
		writeErr(w, http.StatusBadRequest, errors.New("type 只能是 local、remote 或 dynamic"))
		return
	}
	req.Proto = strings.ToLower(strings.TrimSpace(req.Proto))
	if req.Proto == "" {
		req.Proto = "tcp"
	}
	if req.Proto != "tcp" && req.Proto != "udp" {
		writeErr(w, http.StatusBadRequest, errors.New("proto 只能是 tcp 或 udp"))
		return
	}
	if req.Proto == "udp" && req.Type != "local" {
		writeErr(w, http.StatusBadRequest, errors.New("UDP 转发只支持 type=local：SSH 通道只承载 TCP，远端 UDP 监听无法建立"))
		return
	}
	if req.UDP && req.Type != "dynamic" {
		writeErr(w, http.StatusBadRequest, errors.New("udp 只能配合 type=dynamic：SOCKS5 的 UDP ASSOCIATE 挂在动态代理上"))
		return
	}
	need := tunnelStartPerms(req)
	if !a.permAllowedAny(callerApp(r), need...) {
		writePermErr(w, need)
		return
	}
	if req.UDP && !a.permAllowedAny(callerApp(r), "tunnel:udp:socks") {
		writePermErr(w, []string{"tunnel:udp:socks"})
		return
	}
	if a.tunnels == nil {
		writeErr(w, http.StatusInternalServerError, errors.New("tunnels registry not configured"))
		return
	}
	it, err := a.tunnels.Start(req)
	if err != nil {
		writeOpErr(w, err)
		return
	}
	kv := []any{"id", it.ID, "type", it.Type, "proto", it.Proto, "listen", it.Listen, "host", it.HostName}
	if it.Proto == "udp" {
		kv = append(kv, "agent", it.Agent, "agentPort", it.AgentPort)
	}
	if it.UDP {
		kv = append(kv, "udp", true)
	}
	a.log.Info("tunnel started", kv...)
	writeJSON(w, it)
}

func (a *Gateway) handleListTunnels(w http.ResponseWriter, r *http.Request) {
	if a.tunnels == nil {
		writeJSON(w, tunnelsResp{Tunnels: []tunnel.Running{}})
		return
	}
	writeJSON(w, tunnelsResp{Tunnels: a.tunnels.List()})
}

func (a *Gateway) handleStopTunnel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id required"))
		return
	}
	if a.tunnels == nil {
		writeErr(w, http.StatusInternalServerError, errors.New("tunnels registry not configured"))
		return
	}
	cur, known := a.tunnels.Get(req.ID)
	need := tunnelStopPerms(cur, known)
	if !a.permAllowedAny(callerApp(r), need...) {
		writePermErr(w, need)
		return
	}
	if err := a.tunnels.Stop(req.ID); err != nil {
		a.log.Info("tunnel stop skipped", "id", req.ID, "error", err.Error())
	}
	a.log.Info("tunnel stopped", "id", req.ID)
	writeJSON(w, okResp{OK: true})
}
