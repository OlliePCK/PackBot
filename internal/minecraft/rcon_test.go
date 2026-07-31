package minecraft

import (
	"bufio"
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

// fakeRCON serves one connection. password is what it will accept; when
// sendPreamble is set it emits the empty RESPONSE_VALUE that real servers send
// before the auth reply, which the client must tolerate.
func fakeRCON(t *testing.T, password string, sendPreamble bool, reply string) (addr string, gotCmd <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	cmdCh := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)

		id, _, body, err := readRCONPacket(r)
		if err != nil {
			return
		}
		if body != password {
			// Real servers answer with id -1 and hang up.
			_ = writeRCONPacket(conn, rconAuthFailedID, rconTypeAuthResponse, "")
			return
		}
		if sendPreamble {
			_ = writeRCONPacket(conn, id, rconTypeResponse, "")
		}
		_ = writeRCONPacket(conn, id, rconTypeAuthResponse, "")

		_, _, cmd, err := readRCONPacket(r)
		if err != nil {
			return
		}
		cmdCh <- cmd
		_ = writeRCONPacket(conn, 2, rconTypeResponse, reply)
	}()
	return ln.Addr().String(), cmdCh
}

func TestRCONExec(t *testing.T) {
	addr, cmdCh := fakeRCON(t, "s3cret", true, "Added OlliePCK to the whitelist")

	c := NewRCON(addr, "s3cret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := c.Exec(ctx, "whitelist add OlliePCK")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if out != "Added OlliePCK to the whitelist" {
		t.Errorf("output = %q", out)
	}

	select {
	case got := <-cmdCh:
		if got != "whitelist add OlliePCK" {
			t.Errorf("server received %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server never received the command")
	}
}

func TestRCONExecWithoutPreamble(t *testing.T) {
	// Servers that reply with only the AUTH_RESPONSE must work too.
	addr, _ := fakeRCON(t, "pw", false, "ok")
	out, err := NewRCON(addr, "pw").Exec(context.Background(), "list")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if out != "ok" {
		t.Errorf("output = %q, want ok", out)
	}
}

func TestRCONBadPassword(t *testing.T) {
	addr, _ := fakeRCON(t, "right", true, "")
	_, err := NewRCON(addr, "wrong").Exec(context.Background(), "list")
	if !errors.Is(err, ErrRCONAuthFailed) {
		t.Fatalf("err = %v, want ErrRCONAuthFailed", err)
	}
}

func TestRCONStripsFormatting(t *testing.T) {
	addr, _ := fakeRCON(t, "pw", true, "§aThere are §f2§a of a max of §f20§a players online")
	out, err := NewRCON(addr, "pw").Exec(context.Background(), "list")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	const want = "There are 2 of a max of 20 players online"
	if out != want {
		t.Errorf("output = %q, want %q", out, want)
	}
}

func TestNewRCONRequiresBothFields(t *testing.T) {
	if NewRCON("", "pw") != nil {
		t.Error("empty address should yield nil")
	}
	if NewRCON("host:25575", "") != nil {
		t.Error("empty password should yield nil")
	}
	var nilClient *RCON
	if _, err := nilClient.Exec(context.Background(), "list"); !errors.Is(err, ErrRCONNotConfigured) {
		t.Errorf("nil client err = %v, want ErrRCONNotConfigured", err)
	}
}

func TestRCONUnreachable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := NewRCON("127.0.0.1:1", "pw").Exec(ctx, "list"); err == nil {
		t.Fatal("expected an error against a closed port")
	}
}

func TestSplitHostPortDefault(t *testing.T) {
	tests := []struct{ in, host, port string }{
		{"192.168.1.16", "192.168.1.16", RCONDefaultPort},
		{"192.168.1.16:25575", "192.168.1.16", "25575"},
		{"192.168.1.16:25999", "192.168.1.16", "25999"},
	}
	for _, tc := range tests {
		host, port, err := splitHostPortDefault(tc.in, RCONDefaultPort)
		if err != nil {
			t.Errorf("splitHostPortDefault(%q): %v", tc.in, err)
			continue
		}
		if host != tc.host || port != tc.port {
			t.Errorf("splitHostPortDefault(%q) = %q,%q want %q,%q", tc.in, host, port, tc.host, tc.port)
		}
	}
}
