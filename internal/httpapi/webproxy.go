package httpapi

import (
	"errors"
	"net/http"
)

func (a *Gateway) handleStartWebProxy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID string `json:"hostId"`
		Target string `json:"target"`
		TLS    bool   `json:"tls"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.HostID == "" || req.Target == "" {
		writeErr(w, http.StatusBadRequest, errors.New("hostId and target are required"))
		return
	}
	client, err := a.mgr.Get(req.HostID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	owner := callerApp(r)
	inst, err := a.proxies.Start(req.HostID, client, req.Target, req.TLS, owner)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, inst)
}

// handleWebProxyState 返回代理实例最近一次文档请求的轨迹，供内嵌浏览器还原地址栏与导航状态。
func (a *Gateway) handleWebProxyState(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id is required"))
		return
	}
	owner := callerApp(r)
	if !a.proxies.Owns(id, owner, owner == hostApp) {
		writeErr(w, http.StatusNotFound, errors.New("webproxy not found"))
		return
	}
	st, err := a.proxies.State(id)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, st)
}

func (a *Gateway) handleStopWebProxy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	owner := callerApp(r)
	if !a.proxies.Owns(req.ID, owner, owner == hostApp) {
		writeErr(w, http.StatusNotFound, errors.New("webproxy not found"))
		return
	}
	if err := a.proxies.Stop(req.ID); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}
