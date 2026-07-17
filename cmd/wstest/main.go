// Temporary diagnostic: connects to the bot's /api/ws, subscribes to a
// guild, and prints incoming events. Usage: go run ./cmd/wstest <guildID>
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	guildID := os.Args[1]
	sock, _, err := websocket.DefaultDialer.Dial("ws://localhost:3001/api/ws", nil)
	if err != nil {
		fmt.Println("dial failed:", err)
		os.Exit(1)
	}
	defer sock.Close()

	if err := sock.WriteJSON(map[string]string{"type": "subscribe", "guildId": guildID}); err != nil {
		fmt.Println("subscribe failed:", err)
		os.Exit(1)
	}
	fmt.Println("subscribed to", guildID)

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		sock.SetReadDeadline(deadline)
		_, msg, err := sock.ReadMessage()
		if err != nil {
			break
		}
		out := string(msg)
		if len(out) > 400 {
			out = out[:400] + "…"
		}
		fmt.Println("event:", out)
	}
}
