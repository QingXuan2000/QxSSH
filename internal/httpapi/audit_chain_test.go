package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"testing"
)

// tamperPayload 把一封链行的载荷改掉一个字节后重新封装（保持外层结构合法）。
func tamperPayload(t *testing.T, line []byte) []byte {
	t.Helper()
	var env auditEnvelope
	if err := json.Unmarshal(line, &env); err != nil {
		t.Fatal(err)
	}
	payload, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatal(err)
	}
	payload[0] ^= 0x01
	env.Data = base64.StdEncoding.EncodeToString(payload)
	out, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAuditChainRoundTripAndTamper(t *testing.T) {
	s := &auditStore{}

	l1, h1, err := s.marshalChained(auditEntry{Seq: 1, Target: "a"}, "")
	if err != nil {
		t.Fatal(err)
	}
	l2, h2, err := s.marshalChained(auditEntry{Seq: 2, Target: "b"}, h1)
	if err != nil {
		t.Fatal(err)
	}
	l3, _, err := s.marshalChained(auditEntry{Seq: 3, Target: "c"}, h2)
	if err != nil {
		t.Fatal(err)
	}

	good := bytes.Join([][]byte{l1, l2, l3}, []byte("\n"))
	es := s.parseJSONL(good)
	if len(es) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(es))
	}
	for i, want := range []string{"a", "b", "c"} {
		if es[i].Target != want {
			t.Fatalf("entry %d target=%q want %q", i, es[i].Target, want)
		}
	}

	// 篡改第 2 行载荷 → 该行摘要对不上，必须被检出。
	tampered := bytes.Join([][]byte{l1, tamperPayload(t, l2), l3}, []byte("\n"))
	if brokenCount(s.parseJSONL(tampered)) == 0 {
		t.Fatal("tampered line was not detected")
	}

	// 删掉中间行 → 后一条 prev 对不上，必须报告链断裂。
	dropped := bytes.Join([][]byte{l1, l3}, []byte("\n"))
	if gapCount(s.parseJSONL(dropped)) == 0 {
		t.Fatal("dropped middle line was not detected as chain gap")
	}

	// 在头部插入一行伪造记录 → 后续 prev 对不上。
	forged := bytes.Join([][]byte{l2, l1, l2, l3}, []byte("\n"))
	if gapCount(s.parseJSONL(forged)) == 0 && brokenCount(s.parseJSONL(forged)) == 0 {
		t.Fatal("forged prefix was not detected")
	}

	if _, _, _, err := s.unmarshalVerified(l2); err != nil {
		t.Fatalf("valid chain line rejected: %v", err)
	}
}

func brokenCount(es []auditEntry) int {
	n := 0
	for _, e := range es {
		if e.Target == "integrity" && e.Result == "broken" {
			n++
		}
	}
	return n
}

func gapCount(es []auditEntry) int {
	n := 0
	for _, e := range es {
		if e.Target == "integrity" && e.Result == "gap" {
			n++
		}
	}
	return n
}
