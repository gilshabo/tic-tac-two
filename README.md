

# Tic-Tac-Two (Real-Time over Two Servers)

Real-time multiplayer Tic-Tac-Toe where each player can connect to a different backend server.
Two Node.js WebSocket servers keep state in sync using Redis pub/sub and transactional updates (WATCH/MULTI).
Includes an automated demo runner with multiple pre-scripted scenarios.

> ✅ **What this demonstrates**
>
> * Two independent servers (ports 3001 & 3002) serving clients
> * Real-time inter-server sync via Redis channels
> * Correct move validation, win/draw detection
> * Automated demos for win/draw/illegal/disconnect cases
> * Clear protocol between Client↔Server and Server↔Server
> * Modular code: game logic is pure and testable

---

## Architecture

```
   [Client A] --ws--> [Server A:3001]            Redis
                         ^    |                    ▲
                         |    | pub/sub            | pub/sub
                         |    v                    |
   [Client B] --ws--> [Server B:3002] <------------┘

- Each server validates moves and updates the canonical state in Redis using WATCH/MULTI (CAS).
- After each change, server publishes the new state to a Redis channel.
- Both servers subscribe and broadcast updates to their connected clients.
```

**Key files**

* `server/game.js` — pure game logic (no I/O)
* `server/server.js` — WebSocket server + Redis sync
* `server/protocol.js` — message types
* `client/client.js` — CLI WebSocket client
* `scripts/auto_play_extended.js` — automated multi-scenario demo runner

---

## Protocol

### Client → Server

```json
{ "type": "join", "gameId": "room42", "name": "Gil" }
{ "type": "move", "row": 1, "col": 2 }
{ "type": "ping" }
```

### Server → Client

```json
{ "type": "assigned", "seat": "X", "you": {"name": "Gil"} }
{ "type": "update", "state": { "board":[["X","",""],["","O",""],["","",""]], "nextTurn":"X", "status":"running", "winner":null, "version": 5 } }
{ "type": "error", "message": "Not your turn" }
{ "type": "info", "message": "pong" }
```

### Server ↔ Server (via Redis pub/sub)

```json
{ "type": "state", "state": { ...entire state... }, "originId": "srv-3001-xxxx", "eventId": "uuid" }
```

---

## Prerequisites

* Node.js 18+
* Redis (local or remote).
  Quick local setup:

```bash
docker run --name ttt-redis -p 6379:6379 -d redis:7-alpine
```

---

## Install

```bash
npm install
```

If using a remote Redis, set:

```bash
export REDIS_URL=redis://host:port
```

---

## Run Two Servers

**Terminal 1**

```bash
npm run server:3001
```

**Terminal 2**

```bash
npm run server:3002
```

---

## Manual Play (Two Clients)

**Client A**

```bash
node client/client.js ws://localhost:3001 room42 Alice
```

**Client B**

```bash
node client/client.js ws://localhost:3002 room42 Bob
```

Type moves as `row col` (e.g., `0 2`). The board updates in real time.

---

## Automated Demo Scenarios

You can run scripted games to quickly test behavior across servers.

Available scenarios:

```bash
npm run demo:win_row       # X wins by top row
npm run demo:win_col       # X wins by left column
npm run demo:win_diag      # X wins by diagonal
npm run demo:draw          # Full board, no winner
npm run demo:illegal       # O tries illegal move
npm run demo:late_join     # Second player joins late
npm run demo:disconnect    # Player disconnects/rejoins mid-game
```

Each demo:

* Connects Alice to server `3001`, Bob to server `3002`
* Uses a unique `gameId` for isolation
* Plays moves according to the scenario plan
* Prints updates: version, nextTurn, status, winner

---

## One-Command Setup

Use:

```bash
bash scripts/start_all.sh win_row
```

This will:

1. Start Redis in Docker if not running
2. Open two terminals with servers on `3001` and `3002`
3. Run the chosen demo (`win_row` if omitted)

---

## Testing Tips

* Try simultaneous moves → conflict detected, only one applied.
* Try invalid moves → descriptive error messages.
* Try multiple `gameId` values → independent rooms.

---

## License

MIT


