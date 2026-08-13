---
"@neta-art/cohub": minor
---

Add `RealtimeVoiceClient`/`createRealtimeVoiceClient` for connecting to cohub's realtime voice gateway (`apps/gateway`'s `/v1/realtime`), so browser and Node consumers don't need to hand-roll the WebSocket handshake. Auth travels as a `x-token.<value>` WebSocket subprotocol entry rather than an in-band message, keeping the wire protocol a plain OpenAI-Realtime-API-compatible connection.
