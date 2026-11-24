package httpapi

import (
	"sync"
	"testing"
)

// TestSchedulerClaimDedup 验证同一调度在同一分钟内只派发一次，
// 不同分钟各自放行，且 release 后同一分钟仍不会被重复派发（已落 LastRun 语义）。
func TestSchedulerClaimDedup(t *testing.T) {
	s := &scheduler{}

	const stamp = int64(1_700_000_000)

	if !s.claim("sc1", stamp) {
		t.Fatal("first claim for a minute must succeed")
	}
	if s.claim("sc1", stamp) {
		t.Fatal("duplicate claim within the same minute must be rejected")
	}
	if !s.claim("sc2", stamp) {
		t.Fatal("different schedule must claim independently")
	}
	// 已派发过的那一分钟不应再次放行（条目只在老化后清理）。
	if s.claim("sc1", stamp) {
		t.Fatal("same minute must not be claimable twice")
	}
	// 下一分钟应重新放行。
	if !s.claim("sc1", stamp+60) {
		t.Fatal("next minute must be claimable again")
	}
}

// TestSchedulerClaimConcurrent 验证并发 claim 同一分钟时恰好只有一个成功。
func TestSchedulerClaimConcurrent(t *testing.T) {
	s := &scheduler{}
	const stamp = int64(1_700_000_000)

	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.claim("sc1", stamp) {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("expected exactly 1 winner, got %d", wins)
	}
}

// TestSchedulerClaimPrunesStale 验证过期条目会被清理，map 不会无限增长。
func TestSchedulerClaimPrunesStale(t *testing.T) {
	s := &scheduler{}
	base := int64(1_700_000_000)
	for i := 0; i < 50; i++ {
		s.claim("old", base)
	}
	s.claim("fresh", base+600)
	s.mu.Lock()
	_, kept := s.inflight["old"]
	size := len(s.inflight)
	s.mu.Unlock()
	if kept {
		t.Fatal("stale entry should have been pruned")
	}
	if size > 2 {
		t.Fatalf("inflight map should stay small, got %d entries", size)
	}
}
