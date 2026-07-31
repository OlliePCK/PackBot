package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Source RCON packet types. Note that 2 means different things in each
// direction: SERVERDATA_EXECCOMMAND outbound, SERVERDATA_AUTH_RESPONSE inbound.
const (
	rconTypeAuth         int32 = 3
	rconTypeExecCommand  int32 = 2
	rconTypeAuthResponse int32 = 2
	rconTypeResponse     int32 = 0
)

const (
	// RCONDefaultPort is Minecraft's default RCON port.
	RCONDefaultPort = "25575"

	// rconAuthFailedID is the request id the server returns when the password
	// is wrong. It is the only signal — the connection is simply closed after.
	rconAuthFailedID int32 = -1

	// maxRCONPacket bounds an inbound packet. The protocol caps payloads at
	// 4096 bytes; the slack covers the id and type fields plus terminators.
	maxRCONPacket = 4096 + 16

	rconTimeout = 10 * time.Second
)

var (
	// ErrRCONNotConfigured is returned by a nil *RCON — i.e. the address or
	// password was never set.
	ErrRCONNotConfigured = errors.New("minecraft: rcon not configured")

	// ErrRCONAuthFailed means the server rejected the password.
	ErrRCONAuthFailed = errors.New("minecraft: rcon authentication failed")
)

// RCON executes console commands against a Minecraft server.
//
// Unlike the status ping, RCON *changes server state* and authenticates with a
// plaintext password over an unencrypted socket with no rate limiting. It must
// only ever be pointed at an address that is not reachable from the internet.
//
// Connections are made per call rather than pooled: whitelist edits are rare,
// and a long-lived socket to a privileged port is a worse trade than the
// handful of milliseconds a fresh dial costs.
type RCON struct {
	Addr     string
	Password string
}

// NewRCON returns a client, or nil when either the address or password is
// missing, so callers can store the result directly without a branch.
func NewRCON(addr, password string) *RCON {
	addr = strings.TrimSpace(addr)
	if addr == "" || password == "" {
		return nil
	}
	return &RCON{Addr: addr, Password: password}
}

// Exec authenticates, runs one command, and returns the console output with
// formatting codes stripped. Safe to call on a nil *RCON.
func (c *RCON) Exec(ctx context.Context, command string) (string, error) {
	if c == nil {
		return "", ErrRCONNotConfigured
	}

	host, port, err := splitHostPortDefault(c.Addr, RCONDefaultPort)
	if err != nil {
		return "", err
	}

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return "", fmt.Errorf("rcon dial %s: %w", c.Addr, err)
	}
	defer conn.Close()

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(rconTimeout)
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return "", err
	}

	r := bufio.NewReader(conn)

	// Authenticate. The server may emit an empty RESPONSE_VALUE before the
	// AUTH_RESPONSE, so read until the auth reply actually arrives.
	const authID int32 = 1
	if err := writeRCONPacket(conn, authID, rconTypeAuth, c.Password); err != nil {
		return "", fmt.Errorf("rcon auth write: %w", err)
	}
	for {
		id, typ, _, err := readRCONPacket(r)
		if err != nil {
			// A closed connection here is how some servers signal a bad
			// password, so report that rather than a raw EOF.
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return "", ErrRCONAuthFailed
			}
			return "", fmt.Errorf("rcon auth read: %w", err)
		}
		if typ != rconTypeAuthResponse {
			continue // the empty RESPONSE_VALUE preamble
		}
		if id == rconAuthFailedID {
			return "", ErrRCONAuthFailed
		}
		break
	}

	const execID int32 = 2
	if err := writeRCONPacket(conn, execID, rconTypeExecCommand, command); err != nil {
		return "", fmt.Errorf("rcon exec write: %w", err)
	}

	_, _, body, err := readRCONPacket(r)
	if err != nil {
		return "", fmt.Errorf("rcon exec read: %w", err)
	}

	return strings.TrimSpace(stripFormatting(body)), nil
}

// writeRCONPacket frames one packet: [len][id][type][body NUL][NUL].
// The length field counts everything after itself.
func writeRCONPacket(w io.Writer, id, typ int32, body string) error {
	payload := make([]byte, 0, len(body)+10)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(id))
	payload = binary.LittleEndian.AppendUint32(payload, uint32(typ))
	payload = append(payload, body...)
	payload = append(payload, 0, 0)

	out := binary.LittleEndian.AppendUint32(nil, uint32(len(payload)))
	out = append(out, payload...)
	_, err := w.Write(out)
	return err
}

func readRCONPacket(r io.Reader) (id, typ int32, body string, err error) {
	var length uint32
	if err = binary.Read(r, binary.LittleEndian, &length); err != nil {
		return 0, 0, "", err
	}
	if length < 10 || length > maxRCONPacket {
		return 0, 0, "", fmt.Errorf("implausible rcon packet length %d", length)
	}

	buf := make([]byte, length)
	if _, err = io.ReadFull(r, buf); err != nil {
		return 0, 0, "", err
	}

	id = int32(binary.LittleEndian.Uint32(buf[0:4]))
	typ = int32(binary.LittleEndian.Uint32(buf[4:8]))
	body = string(bytes.TrimRight(buf[8:], "\x00"))
	return id, typ, body, nil
}

// splitHostPortDefault is splitAddr with a caller-supplied default port.
func splitHostPortDefault(addr, defPort string) (host, port string, err error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", "", errors.New("empty address")
	}
	host, port, err = net.SplitHostPort(addr)
	if err != nil {
		return addr, defPort, nil
	}
	if port == "" {
		port = defPort
	}
	return host, port, nil
}
