/**
 * Tic-Tac-Two server (fixed Redis env + retry)
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

// Prefer explicit REDIS_URL, otherwise build from REDIS_HOST/REDIS_PORT.
// NOTE: default host is 'redis' so docker-compose service name works.
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_URL = process.env.REDIS_URL || `redis://${REDIS_HOST}:${REDIS_PORT}`;

const INSTANCE_ID = process.env.INSTANCE_ID || `srv-${PORT}-${randomUUID().slice(0,8)}`;

/**
 * Helper: connect a redis client with retries/backoff
 */
async function connectWithRetry(client, name, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.connect();
      console.log(`[${INSTANCE_ID}] Connected ${name} to ${REDIS_URL}`);
      return;
    } catch (err) {
      const waitMs = Math.min(500 * (2 ** i), 5000);
      console.warn(`[${INSTANCE_ID}] Redis connect failed (${name}) attempt ${i+1}/${maxAttempts}: ${err.message}. retrying in ${waitMs}ms`);
      await new Promise(res => setTimeout(res, waitMs));
    }
  }
  throw new Error(`Could not connect ${name} to Redis at ${REDIS_URL} after ${maxAttempts} attempts`);
}

/**
 * Redis setup: one client for KV/transactions, one for publish, one for subscribe
 */
const kv = createClient({ url: REDIS_URL });
// duplicate() creates clients with same options but not connected yet
const pub = kv.duplicate();
const sub = kv.duplicate();

try {
  // connect primary then duplicates (duplicates use same options)
  await connectWithRetry(kv, 'kv');
  await connectWithRetry(pub, 'pub');
  await connectWithRetry(sub, 'sub');
} catch (e) {
  console.error(`[${INSTANCE_ID}] Fatal: unable to connect to Redis — exiting.`, e);
  // Optional: process.exit(1) will cause container to exit (compose will show logs)
  process.exit(1);
}

/* rest of your original code unchanged */
const clientsByGame = new Map();  // gameId -> Set<ws>
const clientMeta = new Map();     // ws -> { gameId, seat, playerId, name }

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

const subscribedGames = new Set();
async function ensureSubscribed(gameId) {
  if (subscribedGames.has(gameId)) return;
  subscribedGames.add(gameId);
  await sub.subscribe(chan(gameId), (message) => {
    try {
      const envelope = JSON.parse(message);
      if (envelope.type !== FED.STATE) return;
      const { state, originId } = envelope;
      if (originId === INSTANCE_ID) return;
      broadcastLocal(state.gameId, { type: S2C.UPDATE, state });
    } catch (e) {
      console.error("Failed to process pubsub message:", e);
    }
  });
}

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

      let st = await loadState(gameId);
      if (!st) st = initialState(gameId);

      let seatToYou;
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          await kv.watch(gameKey(gameId));
          const currentRaw = await kv.get(gameKey(gameId));
          let current = currentRaw ? JSON.parse(currentRaw) : st;
          if (current.status === "finished") {
            await kv.unwatch();
            return safeSend(ws, { type: S2C.ERROR, message: "Game already finished" });
          }
          if (current.players.X && current.players.O) {
            seatToYou = (current.players.X.name === name) ? "X" :
                        (current.players.O.name === name) ? "O" : null;
            if (!seatToYou) {
              await kv.unwatch();
              return safeSend(ws, { type: S2C.ERROR, message: "Game already has two players" });
            }
          } else {
            const playerInfo = { id: randomUUID(), name };
            const next = assignSeat(current, playerInfo);
            seatToYou = (next.players.O && next.players.O.name === name) ? "O" : "X";

            const tx = kv.multi().set(gameKey(gameId), JSON.stringify(next));
            const res = await tx.exec();
            if (res === null) { continue; }
            await saveStateAndPublish(next);
            current = next;
          }

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
          if (res === null) { continue; }
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
