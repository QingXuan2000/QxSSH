package httpapi

import (
	"errors"
	"net/http"

	"qxssh/internal/config"
)

var errNoPrefStore = errors.New("配置库不可用，无法保存个性化设置")

func (a *Gateway) handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	prefs, err := a.store.Prefs()
	if err != nil || prefs == nil {
		prefs = map[string]string{}
	}
	writeJSON(w, prefsResp{Prefs: prefs})
}

func (a *Gateway) handleSetPrefs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Prefs map[string]string `json:"prefs"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Prefs) == 0 {
		writeJSON(w, okResp{OK: true})
		return
	}
	if len(req.Prefs) > 512 {
		writeErr(w, http.StatusBadRequest, errors.New("单次写入的偏好条数过多"))
		return
	}
	if err := a.store.SetPrefs(req.Prefs); err != nil {

		if errors.Is(err, config.ErrPrefInvalid) {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeErr(w, http.StatusInternalServerError, errNoPrefStore)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleGetAppPrefs(w http.ResponseWriter, r *http.Request) {
	app := callerApp(r)
	if app == "" {
		writeErr(w, http.StatusUnauthorized, errors.New("缺少有效会话"))
		return
	}
	prefs, err := a.store.AppPrefs(app)
	if err != nil || prefs == nil {
		prefs = map[string]string{}
	}
	writeJSON(w, prefsResp{Prefs: prefs})
}

func (a *Gateway) handleSetAppPrefs(w http.ResponseWriter, r *http.Request) {
	app := callerApp(r)
	if app == "" {
		writeErr(w, http.StatusUnauthorized, errors.New("缺少有效会话"))
		return
	}
	var req struct {
		Prefs map[string]string `json:"prefs"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Prefs) == 0 {
		writeJSON(w, okResp{OK: true})
		return
	}
	if len(req.Prefs) > 512 {
		writeErr(w, http.StatusBadRequest, errors.New("单次写入的偏好条数过多"))
		return
	}
	if err := a.store.SetAppPrefs(app, req.Prefs); err != nil {
		if errors.Is(err, config.ErrPrefInvalid) {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeErr(w, http.StatusInternalServerError, errNoPrefStore)
		return
	}
	writeJSON(w, okResp{OK: true})
}

