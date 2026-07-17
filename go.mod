module github.com/OlliePCK/packbot

go 1.26.5

require (
	github.com/bwmarrin/discordgo v0.29.0
	github.com/disgoorg/disgolink/v3 v3.1.0
	github.com/disgoorg/snowflake/v2 v2.0.3
	github.com/go-sql-driver/mysql v1.10.0
	github.com/gorilla/websocket v1.5.3
	golang.org/x/text v0.40.0
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/disgoorg/json v1.2.0 // indirect
	golang.org/x/crypto v0.0.0-20210421170649-83a5a9bb288b // indirect
	golang.org/x/sys v0.0.0-20201119102817-f84b799fce68 // indirect
)

replace github.com/disgoorg/disgolink/v3 => ./third_party/disgolink
