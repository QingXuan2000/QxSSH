package httpapi

import (
	"errors"
	"net/http"

	"qxssh/internal/tunnel"
)

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
	need := "tunnel:start"
	if req.Type == "local" || req.Type == "dynamic" {
		need = "tunnel:local"
	}
	caller := callerApp(r)
	if !a.permAllowed(caller, need) {
		writePermErr(w, []string{need})
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
	a.log.Info("tunnel started", "id", it.ID, "type", it.Type, "listen", it.Listen, "host", it.HostName)
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
	need := "tunnel:stop"
	if it, ok := a.tunnels.Get(req.ID); ok && (it.Type == "local" || it.Type == "dynamic") {
		need = "tunnel:local"
	}
	if !a.permAllowed(callerApp(r), need) {
		writePermErr(w, []string{need})
		return
	}
	if err := a.tunnels.Stop(req.ID); err != nil {
		a.log.Info("tunnel stop skipped", "id", req.ID, "error", err.Error())
	}
	a.log.Info("tunnel stopped", "id", req.ID)
	writeJSON(w, okResp{OK: true})
}
