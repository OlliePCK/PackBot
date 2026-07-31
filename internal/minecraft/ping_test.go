package minecraft

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"testing"
	"time"
)

// serverDelay is how long the fake server waits before answering, so the
// latency assertion has a floor that survives coarse clock granularity.
const serverDelay = 10 * time.Millisecond

// readPacket reads one [length][body] frame.
func readPacket(r *bufio.Reader) ([]byte, error) {
	n, err := readVarInt(r)
	if err != nil {
		return nil, err
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

// statusResponse frames a JSON document the way a real server would.
func statusResponse(doc string) []byte {
	return packet(0x00, appendString(nil, doc))
}

// fakeServer serves exactly one ping and hands the handshake body back on the
// returned channel so tests can assert what we actually put on the wire.
func fakeServer(t *testing.T, doc string) (addr string, handshake <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	ch := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)

		hs, err := readPacket(r) // handshake
		if err != nil {
			return
		}
		ch <- hs
		if _, err := readPacket(r); err != nil { // status request
			return
		}
		// Pause before answering so the latency assertion measures something
		// real — a bare loopback round trip can finish below clock resolution.
		time.Sleep(serverDelay)
		_, _ = conn.Write(statusResponse(doc))
	}()
	return ln.Addr().String(), ch
}

func TestPingDecodesStatus(t *testing.T) {
	const doc = `{"version":{"name":"Paper 26.1.2","protocol":766},` +
		`"players":{"online":3,"max":20,"sample":[{"name":"OlliePCK","id":"x"}]},` +
		`"description":{"text":"PackCraft"}}`

	addr, handshakeCh := fakeServer(t, doc)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	got, err := Ping(ctx, addr)
	if err != nil {
		t.Fatalf("Ping: %v", err)
	}

	if got.Version.Name != "Paper 26.1.2" {
		t.Errorf("version name = %q, want %q", got.Version.Name, "Paper 26.1.2")
	}
	if got.Version.Protocol != 766 {
		t.Errorf("protocol = %d, want 766", got.Version.Protocol)
	}
	if got.Players.Online != 3 || got.Players.Max != 20 {
		t.Errorf("players = %d/%d, want 3/20", got.Players.Online, got.Players.Max)
	}
	if len(got.Players.Sample) != 1 || got.Players.Sample[0].Name != "OlliePCK" {
		t.Errorf("sample = %+v, want one entry named OlliePCK", got.Players.Sample)
	}
	// The server slept before answering, so latency must reflect at least that
	// much (minus slack for timer granularity).
	if got.Latency < serverDelay/2 {
		t.Errorf("latency = %v, want >= %v", got.Latency, serverDelay/2)
	}

	// The handshake must carry protocol version, host, port and next-state=1.
	select {
	case hs := <-handshakeCh:
		r := bufio.NewReader(newByteReader(hs))
		id, err := readVarInt(r)
		if err != nil || id != 0x00 {
			t.Fatalf("handshake id = %d (err %v), want 0", id, err)
		}
		ver, err := readVarInt(r)
		if err != nil || ver != protocolVersion {
			t.Errorf("handshake protocol = %d (err %v), want %d", ver, err, protocolVersion)
		}
		hostLen, err := readVarInt(r)
		if err != nil {
			t.Fatalf("host length: %v", err)
		}
		host := make([]byte, hostLen)
		if _, err := io.ReadFull(r, host); err != nil {
			t.Fatalf("host: %v", err)
		}
		if string(host) != "127.0.0.1" {
			t.Errorf("handshake host = %q, want 127.0.0.1", host)
		}
		var port uint16
		if err := binary.Read(r, binary.BigEndian, &port); err != nil {
			t.Fatalf("port: %v", err)
		}
		wantPort := mustPort(t, addr)
		if int(port) != wantPort {
			t.Errorf("handshake port = %d, want %d", port, wantPort)
		}
		next, err := readVarInt(r)
		if err != nil || next != 1 {
			t.Errorf("next state = %d (err %v), want 1", next, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handshake never arrived")
	}
}

func TestPingRejectsUnreachable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Port 1 on loopback: nothing listens, connection refused fast.
	if _, err := Ping(ctx, "127.0.0.1:1"); err == nil {
		t.Fatal("expected an error pinging a closed port")
	}
}

func TestNilClientIsNotConfigured(t *testing.T) {
	var c *Client
	if _, err := c.Ping(context.Background()); err != ErrNotConfigured {
		t.Fatalf("nil client err = %v, want ErrNotConfigured", err)
	}
	if New("   ") != nil {
		t.Error("New(blank) should return nil so Deps can hold it directly")
	}
}

func TestDescriptionText(t *testing.T) {
	tests := []struct {
		name string
		doc  string
		want string
	}{
		{"plain string", `"hello"`, "hello"},
		{"object text", `{"text":"PackCraft"}`, "PackCraft"},
		{
			"nested extra",
			`{"text":"Pack","extra":[{"text":"Craft"},{"text":" Survival"}]}`,
			"PackCraft Survival",
		},
		{"array", `[{"text":"a"},{"text":"b"}]`, "ab"},
		{"legacy colour codes", `"§aGreen §7Grey"`, "Green Grey"},
		{"hex colour codes", `"§x§f§f§0§0§6§aPackCraft"`, "PackCraft"},
		{"malformed", `not json`, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := &Status{Description: json.RawMessage(tc.doc)}
			if got := s.DescriptionText(); got != tc.want {
				t.Errorf("DescriptionText() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSplitAddr(t *testing.T) {
	tests := []struct {
		in, host, port string
	}{
		{"mc.thepck.com", "mc.thepck.com", DefaultPort},
		{"mc.thepck.com:25565", "mc.thepck.com", "25565"},
		{"mc.thepck.com:25566", "mc.thepck.com", "25566"},
		{"  mc.thepck.com  ", "mc.thepck.com", DefaultPort},
		{"192.168.1.16:25565", "192.168.1.16", "25565"},
	}
	for _, tc := range tests {
		host, port, err := splitAddr(tc.in)
		if err != nil {
			t.Errorf("splitAddr(%q): %v", tc.in, err)
			continue
		}
		if host != tc.host || port != tc.port {
			t.Errorf("splitAddr(%q) = %q,%q want %q,%q", tc.in, host, port, tc.host, tc.port)
		}
	}
	if _, _, err := splitAddr("  "); err == nil {
		t.Error("splitAddr(blank) should error")
	}
}

func TestVarIntRoundTrip(t *testing.T) {
	for _, v := range []int{0, 1, 127, 128, 255, 25565, 767, 2097151, 1 << 20} {
		b := appendVarInt(nil, v)
		got, err := readVarInt(bufio.NewReader(newByteReader(b)))
		if err != nil {
			t.Errorf("readVarInt(%d): %v", v, err)
			continue
		}
		if got != v {
			t.Errorf("varint round trip: got %d, want %d", got, v)
		}
	}
}

// newByteReader adapts a byte slice to io.Reader for the bufio wrappers above.
func newByteReader(b []byte) io.Reader { return &sliceReader{b: b} }

type sliceReader struct {
	b []byte
	i int
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

func mustPort(t *testing.T, addr string) int {
	t.Helper()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", addr, err)
	}
	n, err := net.LookupPort("tcp", port)
	if err != nil {
		t.Fatalf("LookupPort(%q): %v", port, err)
	}
	return n
}
