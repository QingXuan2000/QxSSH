package httpapi

import (
	"bytes"
	"container/ring"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"qxssh/internal/config"
	"qxssh/internal/logging"
)

const (
	auditMetaSettings = "audit_settings"

	auditCurrentFile = "audit.log"
)

type auditStore struct {
	curDir string
	arcDir string
	se     *config.Store
	log    *logging.Logger
	path   string
	db     *config.Store

	mu    sync.Mutex
	buf   *ring.Ring
	seq   uint64
	sizes map[string]int64

	verbose atomic.Bool

	set   auditSettings
	setmu sync.RWMutex

	queue     chan auditEntry
	sysQueue  chan auditEntry
	cmdCh     chan auditControl
	done      chan struct{}
	closeOnce sync.Once

	closing atomic.Bool
	dropped int
	wmu     sync.Mutex
}

func newAuditStore(curDir, arcDir string, se *config.Store, lg *logging.Logger) *auditStore {
	s := &auditStore{
		curDir:   curDir,
		arcDir:   arcDir,
		se:       se,
		db:       se,
		log:      lg,
		path:     curDir,
		buf:      ring.New(auditRingCap),
		sizes:    map[string]int64{},
		set:      defaultAuditSettings(),
		queue:    make(chan auditEntry, auditQueue),
		sysQueue: make(chan auditEntry, auditSysQueue),
		cmdCh:    make(chan auditControl),
		done:     make(chan struct{}),
	}
	if curDir == "" {
		return s
	}

	if err := os.MkdirAll(curDir, 0o700); err != nil {
		lg.Warn("audit dir unavailable", "dir", curDir, "error", err.Error())
		s.curDir = ""
		return s
	}
	if arcDir != "" {
		if err := os.MkdirAll(arcDir, 0o700); err != nil {
			lg.Warn("audit archive dir unavailable", "dir", arcDir, "error", err.Error())
			s.arcDir = ""
		}
	}
	s.loadSettings()
	s.verbose.Store(s.settings().Verbose)
	s.purgeExpired()
	s.hydrate()
	go s.writeLoop()
	return s
}

func (s *auditStore) Path() string { return s.path }

func (s *auditStore) settings() auditSettings {
	s.setmu.RLock()
	defer s.setmu.RUnlock()
	return s.set
}

func (s *auditStore) applySettings(ns auditSettings) (auditSettings, error) {
	ns = ns.normalize()
	s.setmu.Lock()
	s.set = ns
	s.setmu.Unlock()
	s.verbose.Store(ns.Verbose)
	if err := s.saveSettings(); err != nil {
		return ns, err
	}
	s.pruneArchives()

	s.requestPurge()
	return ns, nil
}

func (s *auditStore) loadSettings() {
	raw, ok, err := s.db.MetaGet(auditMetaSettings)
	if err != nil || !ok || len(raw) == 0 {
		return
	}
	var set auditSettings
	if json.Unmarshal(raw, &set) != nil {
		return
	}
	s.setmu.Lock()
	s.set = set.normalize()
	s.setmu.Unlock()
}

func (s *auditStore) saveSettings() error {
	b, err := json.Marshal(s.settings())
	if err != nil {
		return err
	}
	return s.db.MetaSet(auditMetaSettings, b)
}

func (s *auditStore) groupPath(g string) string {
	if s.curDir == "" || !auditGroupNameOK(g) {
		return ""
	}
	return filepath.Join(s.curDir, g, auditCurrentFile)
}

func (s *auditStore) groupDir(g string) string {
	p := s.groupPath(g)
	if p == "" {
		return ""
	}
	return filepath.Dir(p)
}

func (s *auditStore) groupArcDir(g string) string {
	if s.arcDir == "" || !auditGroupNameOK(g) {
		return ""
	}
	return filepath.Join(s.arcDir, g)
}

func (s *auditStore) ArchivePath() string { return s.arcDir }

func (s *auditStore) record(e auditEntry) {
	s.push(e, s.queue)
}

func (s *auditStore) recordSystem(e auditEntry) {
	e.Type = auditSystem
	e.AppID = ""
	e.Verbose = nil
	s.push(e, s.sysQueue)
}

func (s *auditStore) push(e auditEntry, q chan auditEntry) {
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	s.mu.Lock()
	s.seq++
	e.Seq = s.seq
	s.buf.Value = e
	s.buf = s.buf.Next()
	s.mu.Unlock()

	if s.curDir == "" {
		return
	}

	if s.closing.Load() {
		return
	}
	select {
	case q <- e:
		return
	default:
	}
	if q == s.sysQueue {
		return
	}
	select {
	case <-q:
	default:
	}
	s.wmu.Lock()
	n := s.dropped
	s.dropped++
	s.wmu.Unlock()
	if n == 0 || n%1000 == 0 {
		s.log.Warn("audit queue overflow, entries dropped", "dropped", n+1)
		s.recordSystem(auditEntry{
			Target: "drop",
			Result: fmt.Sprint(n + 1),
			Detail: fmt.Sprintf("落盘队列已满，累计丢弃 %d 条审计记录（请求路径不阻塞磁盘 IO）", n+1),
		})
	}
	select {
	case q <- e:
	default:
	}
}

func (s *auditStore) writeLoop() {
	defer close(s.done)
	var f *os.File
	var cur string
	write := func(e auditEntry) {
		g := auditGroupDir(e.HostID)
		if f == nil || g != cur {
			if f != nil {
				f.Close()
			}
			cur = g
			f = s.openGroup(g)
		}
		if f == nil {
			return
		}
		line, err := s.marshalLine(e)
		if err != nil {
			return
		}
		line = append(line, '\n')
		n, err := f.Write(line)
		s.wmu.Lock()
		s.sizes[cur] += int64(n)
		over := s.sizes[cur] >= s.settings().MaxBytes
		s.wmu.Unlock()
		if err != nil {
			s.log.Warn("audit append failed", "group", cur, "error", err.Error())
			return
		}
		if over {

			f.Close()
			s.rotate(cur)
			f = nil
			cur = ""

			s.purgeExpired()
		}
	}
	q, sq := s.queue, s.sysQueue
	cc := s.cmdCh
	for q != nil || sq != nil || cc != nil {
		select {
		case e, ok := <-q:
			if !ok {
				q = nil
				continue
			}
			write(e)
		case e, ok := <-sq:
			if !ok {
				sq = nil
				continue
			}
			write(e)
		case c, ok := <-cc:

			if !ok {
				cc = nil
				continue
			}
			if f != nil {
				f.Close()
				f = nil
				cur = ""
			}
			c.reply <- s.runControl(c.cmd, c.group)
		}
	}
	if f != nil {
		f.Close()
	}
}

func (s *auditStore) runControl(cmd auditCmd, group string) auditResult {
	switch cmd {
	case auditCmdPurge:

		s.purgeExpired()
		return auditResult{}
	}

	if s.groupDir(group) == "" {
		return auditResult{Err: "工作区参数无效"}
	}
	switch cmd {
	case auditCmdArchive:
		res := s.archiveGroup(group, s.settings())
		s.pruneArchives()
		return res

	case auditCmdClear:
		res := auditResult{}
		failed := false

		for _, dir := range []string{s.groupDir(group), s.groupArcDir(group)} {
			names, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, n := range names {
				if n.IsDir() || !isAuditDataFile(n.Name()) {
					continue
				}
				p := filepath.Join(dir, n.Name())

				if fi, err := os.Stat(p); err == nil {
					res.Freed += fi.Size()
				}
				if os.Remove(p) != nil {
					failed = true
				}
			}
		}
		if res.Freed > 0 {
			res.Groups = []string{group}
		}
		if failed {
			res.Err = "部分文件删除失败（可能正在使用）"
		}
		s.wmu.Lock()
		s.sizes[group] = 0
		s.wmu.Unlock()

		s.dropRing(func(e auditEntry) bool { return auditGroupDir(e.HostID) == group })
		return res
	}
	return auditResult{}
}

func (s *auditStore) control(cmd auditCmd, group string) (auditResult, error) {
	if s.curDir == "" {
		return auditResult{}, errors.New("审计日志目录不可用")
	}
	if s.closing.Load() {
		return auditResult{}, errors.New("审计落盘已关停")
	}
	reply := make(chan auditResult, 1)
	select {
	case s.cmdCh <- auditControl{cmd: cmd, group: group, reply: reply}:
	case <-time.After(10 * time.Second):
		return auditResult{}, errors.New("审计落盘队列繁忙，请稍后重试")
	}
	return <-reply, nil
}

type auditControl struct {
	cmd   auditCmd
	group string
	reply chan auditResult
}

type auditCmd int

const (
	auditCmdArchive auditCmd = iota
	auditCmdClear
	auditCmdPurge
)

type auditResult struct {
	Freed    int64    `json:"freedBytes"`
	Rows     int      `json:"rows,omitempty"`
	Archived int64    `json:"archivedBytes,omitempty"`
	Groups   []string `json:"groups,omitempty"`
	Err      string   `json:"error,omitempty"`
}

func (s *auditStore) openGroup(g string) *os.File {
	p := s.groupPath(g)
	if p == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		s.log.Warn("audit group dir failed", "group", g, "error", err.Error())
		return nil
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		s.log.Warn("audit open failed", "group", g, "error", err.Error())
		return nil
	}
	if fi, err := f.Stat(); err == nil {
		s.wmu.Lock()
		s.sizes[g] = fi.Size()
		s.wmu.Unlock()
	}
	return f
}

func (s *auditStore) rotate(g string) {
	set := s.settings()
	s.wmu.Lock()
	n := s.sizes[g]
	s.sizes[g] = 0
	s.wmu.Unlock()
	res := s.archiveGroup(g, set)

	verb := "已脱敏归档"
	if set.RotateMode == auditRotateDelete {
		verb = "已按设置丢弃（轮转模式为不保留）"
	} else if res.Archived > 0 {
		verb = fmt.Sprintf("已脱敏归档为 %d 字节", res.Archived)
	}
	s.recordSystem(auditEntry{
		HostID: hostIDOfGroup(g), Target: "rotate",
		Detail: fmt.Sprintf("工作区 %s 的审计日志已满 %d 字节，%s：%s", g, n, verb, s.groupPath(g)),
	})
}

func (s *auditStore) archiveGroup(g string, set auditSettings) auditResult {
	dir := s.groupDir(g)
	cur := filepath.Join(dir, auditCurrentFile)
	fi, err := os.Stat(cur)
	if err != nil || fi.Size() == 0 {
		return auditResult{}
	}
	before := fi.Size()
	if set.RotateMode == auditRotateDelete {
		if err := os.Remove(cur); err != nil && !errors.Is(err, os.ErrNotExist) {
			return auditResult{Err: "丢弃失败，当前代已保留"}
		}
		return auditResult{Freed: before, Groups: []string{g}}
	}

	entries := s.readEntries(cur)
	if len(entries) == 0 {

		return auditResult{Err: "当前代无法解析（密钥可能已更换），已保留原文件"}
	}
	zipBytes, _ := buildAuditArchive(entries, g, time.Now())
	if zipBytes == nil {
		return auditResult{Err: "归档生成失败，当前代已保留"}
	}
	if _, err := s.writeArchiveFile(s.groupArcDir(g), zipBytes); err != nil {
		return auditResult{Err: "归档写入失败，当前代已保留"}
	}
	if err := os.Remove(cur); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log.Warn("audit remove current after archive failed", "path", cur, "error", err.Error())
	}
	return auditResult{Freed: before - int64(len(zipBytes)), Rows: len(entries),
		Archived: int64(len(zipBytes)), Groups: []string{g}}
}

func (s *auditStore) writeArchiveFile(dir string, zipBytes []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	base := archivePrefix + time.Now().Format(archiveStamp)
	for i := 0; i < archiveNameTries; i++ {
		name := base + archiveExt
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", base, i, archiveExt)
		}
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			continue
		}
		tmp := p + archiveTmpSuffix
		if err := os.WriteFile(tmp, zipBytes, 0o600); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
		return name, nil
	}
	return "", errors.New("审计归档文件名冲突")
}

func listArchives(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]string, 0, 4)
	for _, e := range ents {
		if !e.IsDir() && isArchiveFile(e.Name()) {
			out = append(out, e.Name())
		}
	}

	sort.Strings(out)
	return out
}

func (s *auditStore) groupFiles(g string) []string {
	dir := s.groupDir(g)
	if dir == "" {
		return nil
	}
	var legacy []string
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if !e.IsDir() && legacyGenOf(e.Name()) > 0 {
				legacy = append(legacy, e.Name())
			}
		}
	}

	sort.Slice(legacy, func(i, j int) bool { return legacyGenOf(legacy[i]) > legacyGenOf(legacy[j]) })

	files := make([]string, 0, len(legacy)+4)
	for _, n := range legacy {
		files = append(files, filepath.Join(dir, n))
	}
	if arc := s.groupArcDir(g); arc != "" {
		for _, n := range listArchives(arc) {
			files = append(files, filepath.Join(arc, n))
		}
	}
	return append(files, filepath.Join(dir, auditCurrentFile))
}

func legacyGenOf(name string) int {
	n, ok := strings.CutPrefix(name, auditCurrentFile+".")
	if !ok {
		return 0
	}
	gen := 0
	for _, r := range n {
		if r < '0' || r > '9' {
			return 0
		}
		gen = gen*10 + int(r-'0')
	}
	return gen
}

func isAuditDataFile(name string) bool {
	return name == auditCurrentFile || isArchiveFile(name) || legacyGenOf(name) > 0
}

func (s *auditStore) groupEntries(g string, maxBytes int64, maxArchives int) []auditEntry {
	files := s.groupFiles(g)
	if maxArchives > 0 && len(files) > maxArchives+1 {
		files = files[len(files)-(maxArchives+1):]
	}
	var out []auditEntry
	for _, p := range files {
		var es []auditEntry
		if isArchiveFile(filepath.Base(p)) {
			es = readArchiveEntries(p, maxBytes)
		} else {
			es = s.auditTail(p, maxBytes)
		}
		for _, e := range es {
			e.HostID = hostIDOfGroup(g)
			out = append(out, e)
		}
	}
	return out
}

func (s *auditStore) readEntries(path string) []auditEntry {
	return s.auditTail(path, 0)
}

func (s *auditStore) auditTail(path string, maxBytes int64) []auditEntry {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if maxBytes > 0 && int64(len(b)) > maxBytes {
		b = b[int64(len(b))-maxBytes:]
		if i := bytes.IndexByte(b, '\n'); i >= 0 && i+1 < len(b) {
			b = b[i+1:]
		}
	}
	return s.parseJSONL(b)
}

func (s *auditStore) parseJSONL(b []byte) []auditEntry {
	out := make([]auditEntry, 0, 256)
	start := 0
	for i := 0; i <= len(b); i++ {
		if i < len(b) && b[i] != '\n' {
			continue
		}
		if line := bytes.TrimSpace(b[start:i]); len(line) > 0 {
			if e, err := s.unmarshalLine(line); err == nil {
				out = append(out, e)
			}
		}
		start = i + 1
	}
	return out
}

func (s *auditStore) list(group, appID string, onlyHost bool, typ auditType, limit int) []auditEntry {
	if limit <= 0 {
		limit = 200
	}
	var out []auditEntry

	out = append(out, s.fromRing(group, appID, onlyHost, typ, limit)...)
	if len(out) >= limit {
		return out[:limit]
	}

	seen := make(map[uint64]bool, len(out))
	for _, e := range out {
		seen[e.Seq] = true
	}
	var tail []auditEntry
	tailBytes := int64(auditTailBytes)
	maxArch := s.settings().Archives
	if onlyHost || group == "" {
		tailBytes, maxArch = auditScanTailBytes, archiveScanArchives
	}
	for _, e := range s.groupEntries(group, tailBytes, maxArch) {
		if seen[e.Seq] {
			continue
		}
		if !auditMatch(e, group, appID, onlyHost, typ) {
			continue
		}
		tail = append(tail, e)
	}
	sortAudit(tail)
	out = append(out, tail...)
	if len(out) > limit {
		out = out[:limit]
	}
	sortAudit(out)
	return out
}

func (s *auditStore) fromRing(group, appID string, onlyHost bool, typ auditType, limit int) []auditEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []auditEntry

	r := s.buf
	for i := 0; i < s.buf.Len(); i++ {
		r = r.Prev()
		if e, ok := r.Value.(auditEntry); ok && e.Seq != 0 {
			if auditMatch(e, group, appID, onlyHost, typ) {
				out = append(out, e)
				if len(out) >= limit {
					return out
				}
			}
		}
	}
	return out
}

func auditMatch(e auditEntry, group, appID string, onlyHost bool, typ auditType) bool {
	if auditGroupDir(e.HostID) != group {
		return false
	}
	if onlyHost && e.AppID != "" {
		return false
	}
	if appID != "" && e.AppID != appID {
		return false
	}
	if typ != "" && e.Type != typ {
		return false
	}
	return true
}

func sortAudit(list []auditEntry) {

	sort.SliceStable(list, func(i, j int) bool {
		return list[i].Time.After(list[j].Time)
	})
}

func (s *auditStore) dropRing(match func(auditEntry) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var keep []auditEntry
	s.buf.Do(func(v any) {
		if e, ok := v.(auditEntry); ok && e.Seq != 0 && !match(e) {
			keep = append(keep, e)
		}
	})
	s.buf = ring.New(auditRingCap)
	for _, e := range keep {
		s.buf.Value = e
		s.buf = s.buf.Next()
	}
}

func (s *auditStore) hydrate() {
	ents, err := os.ReadDir(s.curDir)
	if err != nil {
		return
	}
	all := make([]auditEntry, 0, auditRingCap)
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		all = append(all, s.groupEntries(e.Name(), auditTailBytes, archiveHydrateArchives)...)
	}
	if len(all) == 0 {
		return
	}
	sortAudit(all)
	s.mu.Lock()
	for _, e := range all {
		if e.Seq > s.seq {
			s.seq = e.Seq
		}
		s.buf.Value = e
		s.buf = s.buf.Next()
	}
	s.mu.Unlock()
	s.log.Info("audit history loaded", "entries", len(all))
}

type auditGroupStat struct {
	Group        string `json:"group"`
	HostID       string `json:"hostId"`
	Name         string `json:"name,omitempty"`
	Rows         int64  `json:"rows"`
	Bytes        int64  `json:"bytes"`
	Archives     int64  `json:"archives"`
	ArchiveBytes int64  `json:"archiveBytes"`
	Modified     string `json:"modified"`
}

func (s *auditStore) statOf(g string) (auditGroupStat, bool) {
	st := auditGroupStat{Group: g, HostID: hostIDOfGroup(g)}

	for _, dir := range []string{s.groupDir(g), s.groupArcDir(g)} {
		if dir == "" {
			continue
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if e.IsDir() || !isAuditDataFile(e.Name()) {
				continue
			}

			fi, err := e.Info()
			if err != nil {
				continue
			}
			if isArchiveFile(e.Name()) {
				st.Archives++
				st.ArchiveBytes += fi.Size()
			} else {
				st.Bytes += fi.Size()
				st.Rows += int64(countJSONL(filepath.Join(dir, e.Name())))
			}
			mt := fi.ModTime().Format(time.RFC3339)
			if st.Modified == "" || mt > st.Modified {
				st.Modified = mt
			}
		}
	}
	if st.Rows == 0 && st.Archives == 0 {
		return auditGroupStat{}, false
	}
	return st, true
}

func (s *auditStore) pruneArchives() {
	keep := s.settings().Archives
	if keep <= 0 || s.arcDir == "" {
		return
	}
	ents, err := os.ReadDir(s.arcDir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir := s.groupArcDir(e.Name())
		names := listArchives(dir)
		if len(names) <= keep {
			continue
		}
		for _, n := range names[:len(names)-keep] {
			_ = os.Remove(filepath.Join(dir, n))
		}
	}
}

func (s *auditStore) purgeExpired() int {
	days := s.settings().RetentionDays
	if days <= 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -days)
	removed := 0

	for _, root := range []string{s.curDir, s.arcDir} {
		if root == "" {
			continue
		}
		ents, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if !e.IsDir() {
				continue
			}
			dir := filepath.Join(root, e.Name())
			files, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, f := range files {
				name := f.Name()
				if f.IsDir() || !isAuditDataFile(name) {
					continue
				}

				fi, err := os.Stat(filepath.Join(dir, name))
				if err != nil || !fi.ModTime().Before(cutoff) {
					continue
				}
				if os.Remove(filepath.Join(dir, name)) == nil {
					removed++
				}
			}
		}
	}
	return removed
}

func (s *auditStore) requestPurge() {
	if s.curDir == "" || s.settings().RetentionDays <= 0 || s.closing.Load() {
		return
	}
	reply := make(chan auditResult, 1)
	select {
	case s.cmdCh <- auditControl{cmd: auditCmdPurge, reply: reply}:
		<-reply
	case <-time.After(5 * time.Second):
		s.log.Warn("audit purge request dropped", "reason", "写循环繁忙")
	}
}

func (s *auditStore) close() {
	s.closeOnce.Do(func() {
		if s.curDir == "" {
			return
		}

		s.closing.Store(true)
		close(s.queue)
		close(s.sysQueue)
		close(s.cmdCh)
		<-s.done
	})
}
