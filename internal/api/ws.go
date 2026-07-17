package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Plain-WebSocket realtime layer replacing the Node bot's Socket.io (no
// maintained Go Socket.io server exists; the payloads only carry music
// state). Protocol:
//
//	client → {"type":"subscribe","guildId":"..."} / {"type":"unsubscribe",...}
//	server → {"type":"nowplaying","guildId":"...","data":{...}}
//	         {"type":"queueUpdate","guildId":"...","data":{...}}
//
// Like the Node Socket.io endpoint, connections are unauthenticated; the
// only check is that the subscribed guild exists.

type wsHub struct {
	mu    sync.Mutex
	conns map[*wsConn]struct{}
}

type wsConn struct {
	sock    *websocket.Conn
	writeMu sync.Mutex
	guilds  map[string]bool
}

func newWSHub() *wsHub {
	return &wsHub{conns: make(map[*wsConn]struct{})}
}

type wsMessage struct {
	Type    string          `json:"type"`
	GuildID string          `json:"guildId,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (c *wsConn) send(msgType, guildID string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.sock.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.sock.WriteJSON(wsMessage{Type: msgType, GuildID: guildID, Data: payload})
}

// broadcast sends an event to every connection subscribed to the guild.
func (h *wsHub) broadcast(guildID, msgType string, data any) {
	h.mu.Lock()
	var targets []*wsConn
	for conn := range h.conns {
		if conn.guilds[guildID] {
			targets = append(targets, conn)
		}
	}
	h.mu.Unlock()
	for _, conn := range targets {
		_ = conn.send(msgType, guildID, data)
	}
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	// Same-origin policy mirrors the CORS config; "*" admits any origin
	// (parity with the Node Socket.io setup).
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	sock, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade wrote the error response
	}
	conn := &wsConn{sock: sock, guilds: make(map[string]bool)}
	s.ws.mu.Lock()
	s.ws.conns[conn] = struct{}{}
	s.ws.mu.Unlock()
	s.log.Debug("websocket client connected", "remote", r.RemoteAddr)

	defer func() {
		s.ws.mu.Lock()
		delete(s.ws.conns, conn)
		s.ws.mu.Unlock()
		sock.Close()
		s.log.Debug("websocket client disconnected", "remote", r.RemoteAddr)
	}()

	sock.SetReadLimit(4096)
	for {
		var msg wsMessage
		if err := sock.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "subscribe":
			// Only guilds the bot is actually in (Node parity).
			if _, err := s.discord.State.Guild(msg.GuildID); err != nil {
				continue
			}
			s.ws.mu.Lock()
			conn.guilds[msg.GuildID] = true
			s.ws.mu.Unlock()
			// Send the initial state immediately (Node parity).
			if s.music != nil {
				_ = conn.send("nowplaying", msg.GuildID, s.music.APIState(msg.GuildID, 20))
			}
		case "unsubscribe":
			s.ws.mu.Lock()
			delete(conn.guilds, msg.GuildID)
			s.ws.mu.Unlock()
		}
	}
}

// pushMusicUpdate broadcasts fresh player + queue state for a guild — wired
// to the music manager's OnUpdate hook.
func (s *Server) pushMusicUpdate(guildID string) {
	if s.music == nil {
		return
	}
	state := s.music.APIState(guildID, 20)
	s.ws.broadcast(guildID, "nowplaying", state)
	_, items := s.music.FullQueue(guildID)
	if len(items) > 50 {
		items = items[:50]
	}
	s.ws.broadcast(guildID, "queueUpdate", map[string]any{
		"queue": items,
		"total": state.QueueLength,
	})
}
