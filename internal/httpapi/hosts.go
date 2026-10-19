package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"qxssh/internal/config"
)

func (a *Gateway) handleListHosts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, hostsListResp{Hosts: a.store.ListHosts()})
}

func (a *Gateway) handleCreateHost(w http.ResponseWriter, r *http.Request) {
	var u config.HostUpdate
	if err := decodeJSON(r, &u); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h, err := a.store.CreateHost(u)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, h)
}

func (a *Gateway) handleUpdateHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		config.HostUpdate
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id 为必填项"))
		return
	}
	h, err := a.store.UpdateHost(req.ID, req.HostUpdate)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	a.mgr.Invalidate(req.ID)
	writeJSON(w, h)
}

func (a *Gateway) handleDeleteHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id 为必填项"))
		return
	}

	a.mgr.Invalidate(req.ID)
	if err := a.store.DeleteHost(req.ID); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleTestHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID            string `json:"id"`
		Address       string `json:"address"`
		Port          int    `json:"port"`
		User          string `json:"user"`
		AuthType      string `json:"authType"`
		Password      string `json:"password"`
		KeyData       string `json:"keyData"`
		KeyPath       string `json:"keyPath"`
		KeyPassphrase string `json:"keyPassphrase"`

		JumpHostID *string `json:"jumpHostId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	var h config.Host
	if req.ID != "" {
		var ok bool
		h, ok = a.store.GetHost(req.ID)
		if !ok {
			writeErr(w, http.StatusBadRequest, errors.New("host not found"))
			return
		}

		if req.Address != "" {
			h.Address = req.Address
		}
		if req.Port != 0 {
			h.Port = req.Port
		}
		if req.User != "" {
			h.User = req.User
		}
		if req.AuthType != "" {
			h.AuthType = req.AuthType

			if req.AuthType == "key" {
				h.Password = ""
			} else {
				h.KeyData, h.KeyPassphrase = "", ""
			}
		}
		if req.Password != "" {
			h.Password = req.Password
		}
		if req.KeyData != "" {
			h.KeyData = req.KeyData
		}
		if req.KeyPath != "" {
			h.KeyPath = req.KeyPath
		}
		if req.KeyPassphrase != "" {
			h.KeyPassphrase = req.KeyPassphrase
		}
		if req.JumpHostID != nil {
			h.JumpHostID = *req.JumpHostID
		}
	} else {
		h = config.Host{
			Address:       req.Address,
			Port:          req.Port,
			User:          req.User,
			AuthType:      req.AuthType,
			Password:      req.Password,
			KeyData:       req.KeyData,
			KeyPath:       req.KeyPath,
			KeyPassphrase: req.KeyPassphrase,
		}
		if req.JumpHostID != nil {
			h.JumpHostID = *req.JumpHostID
		}
	}
	if h.Port == 0 {
		h.Port = 22
	}

	start := time.Now()
	client, err := a.mgr.DialOnce(h)
	if err != nil {
		writeJSON(w, okErrResp{OK: false, Error: err.Error()})
		return
	}
	_ = client.Close()
	writeJSON(w, hostTestResp{OK: true, LatencyMs: time.Since(start).Milliseconds()})
}

func (a *Gateway) handleProbeHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id 为必填项"))
		return
	}
	h, ok := a.store.GetHost(req.ID)
	if !ok {
		writeErr(w, http.StatusNotFound, errors.New("host not found"))
		return
	}
	_, cachedName := a.store.HostOS(h.ID)

	tcpMs, handshakeMs, osInfo, err := a.mgr.ProbeWithOS(h)
	if err != nil {
		writeJSON(w, okErrResp{OK: false, Error: err.Error()})
		return
	}

	if cachedName == "" {
		if err := a.store.SetHostOS(h.ID, osInfo.Icon, osInfo.Name); err != nil {

			a.log.Warn("缓存主机系统类型失败", "host", h.ID, "err", err)
		}
	}

	total := handshakeMs
	if tcpMs >= 0 {
		total = tcpMs + handshakeMs
	}
	resp := hostProbeResp{
		OK:          true,
		TCPMs:       tcpMs,
		HandshakeMs: handshakeMs,
		LatencyMs:   total,
	}

	if cachedName == "" && osInfo.Name != "" {
		osID, osName := osInfo.Icon, osInfo.Name
		resp.OSID = &osID
		resp.OSName = &osName
	}
	writeJSON(w, resp)
}

func (a *Gateway) handleForgetHostOS(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id 为必填项"))
		return
	}
	if _, ok := a.store.GetHost(req.ID); !ok {
		writeErr(w, http.StatusNotFound, errors.New("host not found"))
		return
	}
	if err := a.store.ClearHostOS(req.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleHostCredential(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.ID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("id 为必填项"))
		return
	}
	var label string
	switch req.Kind {
	case "password":
		label = "登录密码"
	case "keyPassphrase":
		label = "私钥口令"
	default:
		writeErr(w, http.StatusBadRequest, errors.New("kind 只能是 password 或 keyPassphrase"))
		return
	}
	h, ok := a.store.GetHost(req.ID)
	if !ok {
		writeErr(w, http.StatusNotFound, errors.New("host not found"))
		return
	}
	var value string
	if req.Kind == "keyPassphrase" {
		value = h.KeyPassphrase
	} else {
		value = h.Password
	}
	if value == "" {

		writeErr(w, http.StatusNotFound, errors.New("该主机未设置"+label))
		return
	}
	writeJSON(w, hostCredentialResp{ID: h.ID, Kind: req.Kind, Value: value})
}

func (a *Gateway) handlePreconnectHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID string `json:"hostId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.HostID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("hostId required"))
		return
	}
	if _, ok := a.store.GetHost(req.HostID); !ok {
		writeErr(w, http.StatusBadRequest, errors.New("host not found"))
		return
	}
	a.mgr.Preconnect(req.HostID)
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleImportHosts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Format  string              `json:"format"`
		Content string              `json:"content"`
		Hosts   []config.HostUpdate `json:"hosts"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	var imported int
	var errs []string

	if req.Format == "ssh_config" {
		entries := config.ParseSSHConfig(strings.NewReader(req.Content))
		createdMap := make(map[string]string)
		for _, e := range entries {
			name := e.Alias
			addr := e.HostName
			user := e.User
			if user == "" {
				user = "root"
			}
			port := e.Port
			authType := "password"
			keyPath := e.IdentityFile
			if keyPath != "" {
				authType = "key"
			}
			u := config.HostUpdate{
				Name:     &name,
				Address:  &addr,
				User:     &user,
				Port:     &port,
				AuthType: &authType,
				KeyPath:  &keyPath,
			}
			h, err := a.store.CreateHost(u)
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", name, err))
				continue
			}
			createdMap[name] = h.ID
			imported++
		}
		for _, e := range entries {
			if e.ProxyJump != "" {
				if hostID, ok := createdMap[e.Alias]; ok {
					if jumpID, hasJump := createdMap[e.ProxyJump]; hasJump {
						_, _ = a.store.UpdateHost(hostID, config.HostUpdate{JumpHostID: &jumpID})
					}
				}
			}
		}
	} else {
		for _, u := range req.Hosts {
			_, err := a.store.CreateHost(u)
			if err != nil {
				name := "<unnamed>"
				if u.Name != nil {
					name = *u.Name
				}
				errs = append(errs, fmt.Sprintf("%s: %v", name, err))
				continue
			}
			imported++
		}
	}

	writeJSON(w, hostsImportResp{OK: true, Imported: imported, Errors: errs})
}
