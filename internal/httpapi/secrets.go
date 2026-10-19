package httpapi

import (
	"errors"
	"net/http"
	"regexp"
)

var secretKeyRe = regexp.MustCompile(`^[A-Za-z0-9][\w.:/@-]{0,127}$`)

const secretValueMax = 64 << 10

func secretKeyParam(w http.ResponseWriter, key string) bool {
	if !secretKeyRe.MatchString(key) {
		writeErr(w, http.StatusBadRequest, errors.New("机密键名非法（字母数字开头，1~128 位，允许 . : / @ - _）"))
		return false
	}
	return true
}

func (a *Gateway) handleSecretGet(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if !secretKeyParam(w, key) {
		return
	}
	v, ok := a.store.SecretGet(callerApp(r), key)
	writeJSON(w, secretGetResp{Key: key, Value: v, Found: ok})
}

func (a *Gateway) handleSecretSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !secretKeyParam(w, req.Key) {
		return
	}
	if len(req.Value) > secretValueMax {
		writeErr(w, http.StatusBadRequest, errors.New("机密值过大（上限 64KB）"))
		return
	}
	app := callerApp(r)
	var err error
	if req.Value == "" {
		err = a.store.SecretDelete(app, req.Key)
	} else {
		err = a.store.SecretSet(app, req.Key, req.Value)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okKeyResp{OK: true, Key: req.Key})
}

func (a *Gateway) handleSecretDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !secretKeyParam(w, req.Key) {
		return
	}
	if err := a.store.SecretDelete(callerApp(r), req.Key); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleSecretList(w http.ResponseWriter, r *http.Request) {
	keys, err := a.store.SecretKeys(callerApp(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, secretKeysResp{Keys: keys})
}
