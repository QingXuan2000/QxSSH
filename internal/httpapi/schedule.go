package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"qxssh/internal/config"
)

type cronSpec struct {
	min, hour, dom, mon, dow uint64
	domAny, dowAny           bool
}

func parseCron(expr string) (cronSpec, error) {

	if len(expr) > 256 {
		return cronSpec{}, errors.New("cron 表达式过长（上限 256 字节）")
	}
	f := strings.Fields(expr)
	if len(f) != 5 {
		return cronSpec{}, fmt.Errorf("cron 必须是 5 段（分 时 日 月 周），得到 %d 段", len(f))
	}
	var spec cronSpec
	var err error
	if spec.min, _, err = parseCronField(f[0], 0, 59); err != nil {
		return spec, fmt.Errorf("分钟段：%w", err)
	}
	if spec.hour, _, err = parseCronField(f[1], 0, 23); err != nil {
		return spec, fmt.Errorf("小时段：%w", err)
	}
	if spec.dom, spec.domAny, err = parseCronField(f[2], 1, 31); err != nil {
		return spec, fmt.Errorf("日段：%w", err)
	}
	if spec.mon, _, err = parseCronField(f[3], 1, 12); err != nil {
		return spec, fmt.Errorf("月段：%w", err)
	}
	if spec.dow, spec.dowAny, err = parseCronField(f[4], 0, 7); err != nil {
		return spec, fmt.Errorf("周段：%w", err)
	}

	if spec.dow&(1<<7) != 0 {
		spec.dow |= 1
	}
	return spec, nil
}

func parseCronField(s string, lo, hi int) (uint64, bool, error) {
	var bits uint64
	any := false
	for _, part := range strings.Split(s, ",") {
		step := 1
		rng := part
		if i := strings.Index(part, "/"); i >= 0 {
			n, err := strconv.Atoi(part[i+1:])
			if err != nil || n <= 0 {
				return 0, false, fmt.Errorf("步长非法：%q", part)
			}
			step, rng = n, part[:i]
		}
		a, b := lo, hi
		switch {
		case rng == "*":
			if step == 1 {
				any = true
			}
		case strings.Contains(rng, "-"):
			x, y, _ := strings.Cut(rng, "-")
			var err1, err2 error
			a, err1 = strconv.Atoi(x)
			b, err2 = strconv.Atoi(y)
			if err1 != nil || err2 != nil || a > b {
				return 0, false, fmt.Errorf("范围非法：%q", part)
			}
		default:
			n, err := strconv.Atoi(rng)
			if err != nil {
				return 0, false, fmt.Errorf("取值非法：%q", part)
			}
			a, b = n, n
			if step > 1 {
				b = hi
			}
		}
		if a < lo || b > hi {
			return 0, false, fmt.Errorf("超出范围 %d-%d：%q", lo, hi, part)
		}
		for v := a; v <= b; v += step {
			bits |= 1 << uint(v)
		}
	}
	if bits == 0 {
		return 0, false, errors.New("空字段")
	}
	return bits, any, nil
}

func (c cronSpec) matches(t time.Time) bool {
	if c.min&(1<<uint(t.Minute())) == 0 || c.hour&(1<<uint(t.Hour())) == 0 || c.mon&(1<<uint(int(t.Month()))) == 0 {
		return false
	}
	domOK := c.dom&(1<<uint(t.Day())) != 0
	dowOK := c.dow&(1<<uint(int(t.Weekday()))) != 0
	if c.domAny || c.dowAny {
		return domOK && dowOK
	}
	return domOK || dowOK
}

type scheduler struct {
	gw   *Gateway
	stop chan struct{}
	once sync.Once
	wg   sync.WaitGroup
}

func newScheduler(gw *Gateway) *scheduler {
	s := &scheduler{gw: gw, stop: make(chan struct{})}
	s.wg.Add(1)
	go s.loop()
	return s
}

func (s *scheduler) close() {
	s.once.Do(func() { close(s.stop) })
	s.wg.Wait()
}

func (s *scheduler) loop() {
	defer s.wg.Done()
	for {
		now := time.Now()
		next := now.Truncate(time.Minute).Add(time.Minute)
		t := time.NewTimer(time.Until(next) + 200*time.Millisecond)
		select {
		case <-s.stop:
			t.Stop()
			return
		case <-t.C:
			s.tick(next)
		}
	}
}

func (s *scheduler) tick(at time.Time) {
	list, err := s.gw.store.Schedules("")
	if err != nil {
		return
	}
	minute := at.Truncate(time.Minute)
	stamp := minute.Unix()
	var wg sync.WaitGroup
	for _, sc := range list {
		if !sc.Enabled || sc.LastRun >= stamp {
			continue
		}
		spec, err := parseCron(sc.Cron)
		if err != nil || !spec.matches(minute) {
			continue
		}
		wg.Add(1)
		go func(sc config.Schedule) {
			defer wg.Done()
			s.gw.fireSchedule(sc, stamp)
		}(sc)
	}
	wg.Wait()
}

func (a *Gateway) fireSchedule(sc config.Schedule, stamp int64) {
	if !a.permAllowed(sc.AppID, execPermNeed(sc.Host)) {
		a.log.Warn("schedule: owner lacks exec permission, skipping",
			"schedule", sc.ID, "app", sc.AppID, "host", sc.Host)
		_ = a.store.MarkScheduleRun(sc.ID, stamp, "", "发起方已无执行权限，已跳过")
		return
	}
	client, err := a.mgr.Get(sc.Host)
	if err != nil {
		a.log.Warn("schedule: connect failed", "schedule", sc.ID, "host", sc.Host, "error", err.Error())
		_ = a.store.MarkScheduleRun(sc.ID, stamp, "", err.Error())
		return
	}
	st, err := a.startJob(sshRunner{client: client}, sc.AppID, jobStartReq{Host: sc.Host, Argv: sc.Argv, Cwd: sc.Cwd, Name: sc.Name})
	if err != nil {
		a.log.Warn("schedule: start failed", "schedule", sc.ID, "host", sc.Host, "error", err.Error())
		_ = a.store.MarkScheduleRun(sc.ID, stamp, "", err.Error())
		return
	}
	a.log.Info("schedule fired", "schedule", sc.ID, "host", sc.Host, "job", st.ID, "app", sc.AppID)
	_ = a.store.MarkScheduleRun(sc.ID, stamp, st.ID, "")
}

func newScheduleID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "s-" + hex.EncodeToString(b), nil
}

func scheduleOwner(r *http.Request, sc config.Schedule) bool {
	app := callerApp(r)
	return app == hostApp || app == sc.AppID
}

func (a *Gateway) handleScheduleList(w http.ResponseWriter, r *http.Request) {
	app := callerApp(r)
	if app == hostApp {
		app = ""
	}
	list, err := a.store.Schedules(app)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, schedulesResp{Schedules: list})
}

type scheduleReq struct {
	ID      string   `json:"id"`
	Host    string   `json:"host"`
	Name    string   `json:"name"`
	Argv    []string `json:"argv"`
	Cwd     string   `json:"cwd"`
	Cron    string   `json:"cron"`
	Enabled *bool    `json:"enabled"`
}

func (a *Gateway) handleScheduleCreate(w http.ResponseWriter, r *http.Request) {
	var req scheduleReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if _, ok := a.store.GetHost(req.Host); !ok {
		writeErr(w, http.StatusBadRequest, errors.New("host 不存在"))
		return
	}
	if err := validateExecArgv(req.Argv); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if _, err := parseCron(req.Cron); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	id, err := newScheduleID()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	sc := config.Schedule{
		ID: id, AppID: callerApp(r), Host: req.Host, Name: strings.TrimSpace(req.Name), Argv: req.Argv,
		Cwd: req.Cwd, Cron: strings.Join(strings.Fields(req.Cron), " "), Enabled: req.Enabled == nil || *req.Enabled,
		CreatedAt: time.Now().Unix(),
	}
	if len(sc.Name) > jobNameMax {
		sc.Name = sc.Name[:jobNameMax]
	}
	if err := a.store.SaveSchedule(sc); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, sc)
}

func (a *Gateway) findSchedule(w http.ResponseWriter, r *http.Request, id string) (config.Schedule, bool) {
	sc, ok, err := a.store.ScheduleByID(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return config.Schedule{}, false
	}
	if !ok {
		writeErr(w, http.StatusNotFound, errors.New("定时任务不存在"))
		return config.Schedule{}, false
	}
	if !scheduleOwner(r, sc) {
		writeErr(w, http.StatusForbidden, errors.New("不能操作别的应用的定时任务"))
		return config.Schedule{}, false
	}
	return sc, true
}

func (a *Gateway) handleScheduleUpdate(w http.ResponseWriter, r *http.Request) {
	var req scheduleReq
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sc, ok := a.findSchedule(w, r, req.ID)
	if !ok {
		return
	}

	if req.Host != "" {
		if _, ok := a.store.GetHost(req.Host); !ok {
			writeErr(w, http.StatusBadRequest, errors.New("host 不存在"))
			return
		}
		sc.Host = req.Host
	}
	if req.Argv != nil {
		if err := validateExecArgv(req.Argv); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		sc.Argv = req.Argv
	}
	if req.Cron != "" {
		if _, err := parseCron(req.Cron); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		sc.Cron = strings.Join(strings.Fields(req.Cron), " ")
	}
	if req.Name != "" {
		sc.Name = strings.TrimSpace(req.Name)
	}
	if req.Cwd != "" {
		sc.Cwd = req.Cwd
	}
	if req.Enabled != nil {
		sc.Enabled = *req.Enabled
	}
	if err := a.store.SaveSchedule(sc); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, sc)
}

func (a *Gateway) handleScheduleDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if _, ok := a.findSchedule(w, r, req.ID); !ok {
		return
	}
	if err := a.store.DeleteSchedule(req.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, okResp{OK: true})
}

func (a *Gateway) handleScheduleRun(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sc, ok := a.findSchedule(w, r, req.ID)
	if !ok {
		return
	}
	run, ok := a.jobClient(w, r, sc.Host)
	if !ok {
		return
	}
	st, err := a.startJob(run, sc.AppID, jobStartReq{Host: sc.Host, Argv: sc.Argv, Cwd: sc.Cwd, Name: sc.Name})
	now := time.Now().Unix()
	if err != nil {
		_ = a.store.MarkScheduleRun(sc.ID, now, "", err.Error())
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	_ = a.store.MarkScheduleRun(sc.ID, now, st.ID, "")
	writeJSON(w, st)
}
