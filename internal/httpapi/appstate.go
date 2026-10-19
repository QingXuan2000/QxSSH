package httpapi

import (
	"errors"
	"sort"
	"sync"

	"qxssh/internal/config"
	"qxssh/internal/logging"
)

var errNoAppStateStore = errors.New("配置库不可用，无法保存应用启停状态")

type appState struct {
	Disabled []string `json:"disabled,omitempty"`

	store *config.Store
	log   *logging.Logger

	mu sync.RWMutex
}

func loadAppState(st *config.Store, lg *logging.Logger) *appState {
	s := &appState{store: st, log: lg}
	if st == nil {
		return s
	}
	for _, id := range st.DisabledApps() {
		if appIDRe.MatchString(id) {
			s.Disabled = append(s.Disabled, id)
		}
	}
	return s
}

func (s *appState) isDisabled(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, d := range s.Disabled {
		if d == id {
			return true
		}
	}
	return false
}

func (s *appState) setEnabled(id string, enabled bool) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, d := range s.Disabled {
		if d == id {
			idx = i
			break
		}
	}
	if enabled && idx < 0 {
		return true, nil
	}
	if !enabled && idx >= 0 {
		return true, nil
	}
	if s.store == nil {
		return false, errNoAppStateStore
	}
	if err := s.store.SetAppDisabled(id, !enabled); err != nil {
		return false, err
	}
	if enabled {
		s.Disabled = append(s.Disabled[:idx], s.Disabled[idx+1:]...)
		return true, nil
	}
	s.Disabled = append(s.Disabled, id)
	sort.Strings(s.Disabled)
	return true, nil
}
