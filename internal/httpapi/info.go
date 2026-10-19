package httpapi

import "net/http"

func (a *Gateway) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, versionResp{Version: a.version})
}
