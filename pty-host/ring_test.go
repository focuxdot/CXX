package main

import (
	"bytes"
	"testing"
)

// F1 回归：单次 append 长度 ≥ cap 时，保留段仍须落在 buf[total % cap]，
// 否则 since() 按位环偏移读出旋转乱序数据。
func TestRingBigAppendAlignment(t *testing.T) {
	r := newRing(8)
	r.append([]byte("0123456789")) // 10 字节 > cap 8：保留 "23456789"，total=10，start=2
	if r.total != 10 {
		t.Fatalf("total = %d, want 10", r.total)
	}
	if r.start() != 2 {
		t.Fatalf("start = %d, want 2", r.start())
	}
	data, from, gap := r.since(2)
	if gap || from != 2 || !bytes.Equal(data, []byte("23456789")) {
		t.Fatalf("since(2) = %q from=%d gap=%v, want \"23456789\" from=2 gap=false", data, from, gap)
	}
	// 紧接一次普通 append 必须与保留段连续
	r.append([]byte("ab")) // total=12，start=4
	data, from, _ = r.since(r.start())
	if !bytes.Equal(data, []byte("456789ab")) {
		t.Fatalf("after normal append since(start) = %q, want \"456789ab\"", data)
	}
}

// F5 回归：s > total（坏 sinceSeq）须夹到 total 并标 gap，令 daemon 重建快照。
func TestRingSinceFutureSeqSignalsGap(t *testing.T) {
	r := newRing(64)
	r.append([]byte("hello"))
	data, from, gap := r.since(1 << 40)
	if !gap {
		t.Fatal("since(future) should set gap=true")
	}
	if from != r.total || len(data) != 0 {
		t.Fatalf("since(future) = %q from=%d, want empty from=%d", data, from, r.total)
	}
	// MaxUint64 不得 panic
	_, _, gap2 := r.since(^uint64(0))
	if !gap2 {
		t.Fatal("since(MaxUint64) should set gap=true")
	}
}

// s < start 仍从起点返回并标 gap（既有行为，防回归）。
func TestRingSinceBeforeStart(t *testing.T) {
	r := newRing(4)
	r.append([]byte("abcdef")) // start=2
	data, from, gap := r.since(0)
	if !gap || from != 2 || !bytes.Equal(data, []byte("cdef")) {
		t.Fatalf("since(0) = %q from=%d gap=%v, want \"cdef\" from=2 gap=true", data, from, gap)
	}
}
