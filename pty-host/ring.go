package main

// ring：有界字节环 + 绝对偏移。total 是历史累计输出字节数（即下一字节的 seq）；
// 只保留最近 cap 字节，供断线增量重放。
type ring struct {
	buf   []byte
	total uint64
}

func newRing(size int) *ring {
	return &ring{buf: make([]byte, size)}
}

func (r *ring) capU() uint64 { return uint64(len(r.buf)) }

// start：ring 内最早可读字节的绝对偏移。
func (r *ring) start() uint64 {
	if r.total <= r.capU() {
		return 0
	}
	return r.total - r.capU()
}

func (r *ring) append(p []byte) {
	c := len(r.buf)
	// 超过容量：只保留尾部 c 字节，但把丢弃的前缀计入 total，
	// 使保留段仍落在 buf[total % cap]——否则 since() 的按位环偏移会错位（读出旋转过的乱序数据）。
	if len(p) >= c {
		r.total += uint64(len(p) - c)
		p = p[len(p)-c:]
	}
	pos := int(r.total % r.capU())
	n := copy(r.buf[pos:], p)
	if n < len(p) {
		copy(r.buf, p[n:])
	}
	r.total += uint64(len(p))
}

// since：返回 [s, total) 的数据。s 早于 ring 起点时从起点返回并标记 gap。
func (r *ring) since(s uint64) (data []byte, from uint64, gap bool) {
	st := r.start()
	if s < st {
		s, gap = st, true
	}
	if s > r.total {
		// 未来偏移（daemon 状态错乱/坏 sinceSeq）：夹到 total 并标 gap，
		// 让 daemon 重建快照而不是误以为"已追平"
		s, gap = r.total, true
	}
	count := int(r.total - s)
	out := make([]byte, count)
	pos := int(s % r.capU())
	n := copy(out, r.buf[pos:min(len(r.buf), pos+count)])
	if n < count {
		copy(out[n:], r.buf[:count-n])
	}
	return out, s, gap
}
