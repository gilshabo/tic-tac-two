/**
 * Tic-Tac-Two server
 * - Handles WebSocket connections
 * - Syncs game state across multiple servers using Redis pub/sub
 * - Modular separation: game logic, protocol, networking
 * - Broadcasts real-time updates to all clients
 */

import { WebSocketServer } from "ws";
import { createClient } from "redis";
import { randomUUID } from "crypto";
import { initialState, assignSeat, applyMove } from "./game.js";
import { C2S, S2C, FED } from "./protocol.js";

/**
 * Env
 */
const PORT = Number(process.env.PORT || 3001);
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const INSTANCE_ID = process.env.INSTANCE_ID || `srv-${PORT}-${randomUUID().slice(0,8)}`;

/**
 * Redis setup: one client for KV/transactions, one for publish, one for subscribe
 */
const kv = createClient({ url: REDIS_URL });
const pub = kv.duplicate();
const sub = kv.duplicate();
await kv.connect();
await pub.connect();
await sub.connect();

/**
 * In-memory maps for local clients
 */
const clientsByGame = new Map();  // gameId -> Set<ws>
const clientMeta = new Map();     // ws -> { gameId, seat, playerId, name }

/**
 * Helpers
 */
function gameKey(gameId) { return `tictac:game:${gameId}`; }
function chan(gameId)   { return `tictac:chan:${gameId}`; }

async function loadState(gameId) {
  const raw = await kv.get(gameKey(gameId));
  return raw ? JSON.parse(raw) : null;
}

async function saveStateAndPublish(state) {
  const key = gameKey(state.gameId);
  const payload = JSON.stringify(state);
  await kv.set(key, payload);
  const envelope = JSON.stringify({ type: FED.STATE, state, originId: INSTANCE_ID, eventId: randomUUID() });
  await pub.publish(chan(state.gameId), envelope);
}

function ensureGameSet(gameId) {
  if (!clientsByGame.has(gameId)) clientsByGame.set(gameId, new Set());
  return clientsByGame.get(gameId);
}

function broadcastLocal(gameId, messageObj) {
  const set = clientsByGame.get(gameId);
  if (!set) return;
  const msg = JSON.stringify(messageObj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

/**
 * Subscribe to all game channels lazily: when we first see a gameId, we subscribe its channel
 * We cache subscriptions to avoid duplicate sub.subscribe()
 */
const subscribedGames = new Set();
async function ensureSubscribed(gameId) {
  if (subscribedGames.has(gameId)) return;
  subscribedGames.add(gameId);
  await sub.subscribe(chan(gameId), (message) => {
    try {
      const envelope = JSON.parse(message);
      if (envelope.type !== FED.STATE) return;
      const { state, originId } = envelope;
      // Ignore messages we just published ourselves
      if (originId === INSTANCE_ID) return;
      // Update local and broadcast to connected clients
      broadcastLocal(state.gameId, { type: S2C.UPDATE, state });
    } catch (e) {
      console.error("Failed to process pubsub message:", e);
    }
  });
}

/**
 * WebSocket server
 */
const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`[${INSTANCE_ID}] WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return safeSend(ws, { type: S2C.ERROR, message: "Invalid JSON" }); }

    if (msg.type === C2S.JOIN) {
      const { gameId, name } = msg;
      if (!gameId || !name) return safeSend(ws, { type: S2C.ERROR, message: "JOIN requires gameId and name" });

      await ensureSubscribed(gameId);
      ensureGameSet(gameId).add(ws);

      // Load or init state
      let st = await loadState(gameId);
      if (!st) st = initialState(gameId);

      // Assign seat if needed
      let seatToYou;
      try {
        // Optimistic concurrency using WATCH/MULTI
        // Retry a couple of times if races
        for (let attempt = 0; attempt < 5; attempt++) {
          await kv.watch(gameKey(gameId));
          const currentRaw = await kv.get(gameKey(gameId));
          let current = currentRaw ? JSON.parse(currentRaw) : st;
          if (current.status === "finished") {
            await kv.unwatch();
            return safeSend(ws, { type: S2C.ERROR, message: "Game already finished" });
          }
          // Determine if seat needed
          if (current.players.X && current.players.O) {
            seatToYou = (current.players.X.name === name) ? "X" :
                        (current.players.O.name === name) ? "O" : null;
            // No seat free; allow spectator? Here we disallow extra players.
            if (!seatToYou) {
              await kv.unwatch();
              return safeSend(ws, { type: S2C.ERROR, message: "Game already has two players" });
            }
          } else {
            // Assign a seat to this player
            const playerInfo = { id: randomUUID(), name };
            const next = assignSeat(current, playerInfo);
            seatToYou = (next.players.O && next.players.O.name === name) ? "O" : "X";

            const tx = kv.multi().set(gameKey(gameId), JSON.stringify(next));
            const res = await tx.exec();
            if (res === null) { continue; } // race, retry
            // Publish new state
            await saveStateAndPublish(next);
            current = next;
          }

          // Join successful (either existing seat or newly assigned). Broadcast current state to this client.
          clientMeta.set(ws, { gameId, seat: seatToYou, playerId: null, name });
          safeSend(ws, { type: S2C.ASSIGNED, seat: seatToYou, you: { name } });
          safeSend(ws, { type: S2C.UPDATE, state: current });
          break;
        }
      } catch (e) {
        console.error("JOIN error:", e);
        safeSend(ws, { type: S2C.ERROR, message: e.message || "Join failed" });
      }
    }

    else if (msg.type === C2S.MOVE) {
      const meta = clientMeta.get(ws);
      if (!meta) return safeSend(ws, { type: S2C.ERROR, message: "Join first" });
      const { row, col } = msg;
      const { gameId, seat } = meta;

      // CAS with WATCH/MULTI to avoid concurrent move conflicts
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          await kv.watch(gameKey(gameId));
          const currentRaw = await kv.get(gameKey(gameId));
          const current = currentRaw ? JSON.parse(currentRaw) : null;
          if (!current) { await kv.unwatch(); return safeSend(ws, { type: S2C.ERROR, message: "Game not found" }); }
          let next;
          try {
            next = applyMove(current, seat, row, col);
          } catch (e) {
            await kv.unwatch();
            return safeSend(ws, { type: S2C.ERROR, message: e.message });
          }
          const tx = kv.multi().set(gameKey(gameId), JSON.stringify(next));
          const res = await tx.exec();
          if (res === null) {
            // Conflict; retry
            continue;
          }
          // Successful write; publish and broadcast locally too
          await saveStateAndPublish(next);
          broadcastLocal(gameId, { type: S2C.UPDATE, state: next });
          return;
        }
        safeSend(ws, { type: S2C.ERROR, message: "Move conflicted, try again" });
      } catch (e) {
        console.error("MOVE error:", e);
        safeSend(ws, { type: S2C.ERROR, message: e.message || "Move failed" });
      }
    }

    else if (msg.type === C2S.PING) {
      safeSend(ws, { type: S2C.INFO, message: "pong" });
    }

    else {
      safeSend(ws, { type: S2C.ERROR, message: "Unknown message type" });
    }
  });

  ws.on("close", () => {
    const meta = clientMeta.get(ws);
    if (meta) {
      const { gameId } = meta;
      const set = clientsByGame.get(gameId);
      if (set) set.delete(ws);
      clientMeta.delete(ws);
    }
  });
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  wss.close();
  await sub.quit();
  await pub.quit();
  await kv.quit();
  process.exit(0);
});
