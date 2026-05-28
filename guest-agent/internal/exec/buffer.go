package exec

import "encoding/base64"

// boundedBuffer keeps at most max bytes of writes; subsequent writes are
// discarded and `truncated` is set. The intent is to limit memory blow-up
// from runaway processes while still surfacing the leading output to the
// caller.
type boundedBuffer struct {
	max       int
	buf       []byte
	truncated bool
}

func newBoundedBuffer(max int) *boundedBuffer {
	return &boundedBuffer{max: max}
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if len(b.buf) >= b.max {
		b.truncated = true
		return len(p), nil
	}
	remaining := b.max - len(b.buf)
	if len(p) <= remaining {
		b.buf = append(b.buf, p...)
		return len(p), nil
	}
	b.buf = append(b.buf, p[:remaining]...)
	b.truncated = true
	return len(p), nil
}

func (b *boundedBuffer) encoded() string {
	if len(b.buf) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b.buf)
}
