// Package minecraft speaks just enough of the Minecraft Java Edition protocol
// to read a server's status — the same "server list ping" a vanilla client
// performs when it draws the multiplayer screen.
//
// It is deliberately outbound-only: no plugin, no RCON and no open port on the
// game server, which makes it the cheapest possible integration for the Pack's
// Minecraft server. Anything that needs to *change* server state (whitelisting,
// chat relay) belongs in a separate RCON client, not here.
package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// DefaultPort is Minecraft Java Edition's default listen port.
const DefaultPort = "25565"

// defaultTimeout bounds a ping when the caller's context carries no deadline.
const defaultTimeout = 10 * time.Second

// protocolVersion is sent in the handshake. Status pings are version-agnostic —
// servers answer whatever we claim — so this is a recent constant rather than
// something tracked per game drop.
const protocolVersion = 767

// maxResponseBytes caps the status payload so a hostile or broken server can't
// make us allocate without bound. Real responses are a few KB; favicons push
// that to ~100KB at worst.
const maxResponseBytes = 1 << 20

// Status is the decoded server-list-ping response.
type Status struct {
	Version struct {
		Name     string `json:"name"`
		Protocol int    `json:"protocol"`
	} `json:"version"`

	Players struct {
		Online int `json:"online"`
		Max    int `json:"max"`
		// Sample is the handful of names vanilla shows on hover. Servers may
		// omit it, shuffle it, or truncate it — treat it as a hint, not a roster.
		Sample []struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		} `json:"sample"`
	} `json:"players"`

	// Description is the MOTD. The protocol allows either a plain string or a
	// chat-component object, so it stays raw here; use DescriptionText.
	Description json.RawMessage `json:"description"`

	Favicon string `json:"favicon"`

	// Latency is the round trip of the status exchange. Not part of the JSON.
	Latency time.Duration `json:"-"`
}

// DescriptionText flattens the MOTD to plain text, walking the chat-component
// tree and stripping legacy section-sign formatting codes (including the
// §x§R§R§G§G§B§B hex form) so the result is safe to drop into a Discord embed.
func (s *Status) DescriptionText() string {
	if len(s.Description) == 0 {
		return ""
	}
	var node any
	if err := json.Unmarshal(s.Description, &node); err != nil {
		return ""
	}
	return stripFormatting(flatten(node))
}

func flatten(node any) string {
	switch v := node.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, child := range v {
			b.WriteString(flatten(child))
		}
		return b.String()
	case map[string]any:
		var b strings.Builder
		if text, ok := v["text"].(string); ok {
			b.WriteString(text)
		}
		if extra, ok := v["extra"].([]any); ok {
			for _, child := range extra {
				b.WriteString(flatten(child))
			}
		}
		return b.String()
	default:
		return ""
	}
}

// stripFormatting removes '§' followed by one formatting character. The hex
// form is just seven of those in a row, so a single pass handles both.
func stripFormatting(s string) string {
	var b strings.Builder
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		if runes[i] == '§' && i+1 < len(runes) {
			i++ // skip the code character too
			continue
		}
		b.WriteRune(runes[i])
	}
	return b.String()
}

// Ping performs a server-list ping against addr ("host", "host:port" or an IP)
// and returns the decoded status. The context bounds the whole exchange.
func Ping(ctx context.Context, addr string) (*Status, error) {
	host, port, err := splitAddr(addr)
	if err != nil {
		return nil, err
	}

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	defer conn.Close()

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(defaultTimeout)
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}

	portNum, err := net.LookupPort("tcp", port)
	if err != nil {
		return nil, fmt.Errorf("bad port %q: %w", port, err)
	}

	start := time.Now()

	// Handshake: protocol version, address, port, next state = 1 (status).
	var payload []byte
	payload = appendVarInt(payload, protocolVersion)
	payload = appendString(payload, host)
	payload = binary.BigEndian.AppendUint16(payload, uint16(portNum))
	payload = appendVarInt(payload, 1)
	if _, err := conn.Write(packet(0x00, payload)); err != nil {
		return nil, fmt.Errorf("write handshake: %w", err)
	}

	// Status request: empty body.
	if _, err := conn.Write(packet(0x00, nil)); err != nil {
		return nil, fmt.Errorf("write status request: %w", err)
	}

	r := bufio.NewReader(conn)

	length, err := readVarInt(r)
	if err != nil {
		return nil, fmt.Errorf("read packet length: %w", err)
	}
	if length <= 0 || length > maxResponseBytes {
		return nil, fmt.Errorf("implausible packet length %d", length)
	}

	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("read packet body: %w", err)
	}
	latency := time.Since(start)

	br := bufio.NewReader(bytes.NewReader(body))
	id, err := readVarInt(br)
	if err != nil {
		return nil, fmt.Errorf("read packet id: %w", err)
	}
	if id != 0x00 {
		return nil, fmt.Errorf("unexpected packet id 0x%02x", id)
	}

	jsonLen, err := readVarInt(br)
	if err != nil {
		return nil, fmt.Errorf("read json length: %w", err)
	}
	if jsonLen <= 0 || jsonLen > maxResponseBytes {
		return nil, fmt.Errorf("implausible json length %d", jsonLen)
	}

	raw := make([]byte, jsonLen)
	if _, err := io.ReadFull(br, raw); err != nil {
		return nil, fmt.Errorf("read json: %w", err)
	}

	var status Status
	if err := json.Unmarshal(raw, &status); err != nil {
		return nil, fmt.Errorf("decode status: %w", err)
	}
	status.Latency = latency
	return &status, nil
}

// splitAddr accepts "host", "host:port" or a bare IP, defaulting the port.
func splitAddr(addr string) (host, port string, err error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", "", errors.New("empty address")
	}
	host, port, err = net.SplitHostPort(addr)
	if err != nil {
		// No port present (or an IPv6 literal without brackets).
		return addr, DefaultPort, nil
	}
	if port == "" {
		port = DefaultPort
	}
	return host, port, nil
}

// packet frames a payload as [length][id][payload]. Every packet id this
// package sends is 0x00, which encodes as a single varint byte.
func packet(id byte, payload []byte) []byte {
	body := make([]byte, 0, len(payload)+1)
	body = append(body, id)
	body = append(body, payload...)

	out := appendVarInt(nil, len(body))
	return append(out, body...)
}

func appendVarInt(b []byte, v int) []byte {
	uv := uint32(v)
	for {
		if uv&^0x7F == 0 {
			return append(b, byte(uv))
		}
		b = append(b, byte(uv&0x7F|0x80))
		uv >>= 7
	}
}

func appendString(b []byte, s string) []byte {
	b = appendVarInt(b, len(s))
	return append(b, s...)
}

func readVarInt(r io.ByteReader) (int, error) {
	var value uint32
	for i := 0; i < 5; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		value |= uint32(b&0x7F) << (7 * i)
		if b&0x80 == 0 {
			return int(value), nil
		}
	}
	return 0, errors.New("varint too long")
}
