import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const projectRoot = new URL("..", import.meta.url).pathname;

let srv1, srv2;

function startServer(port) {
  const env = { ...process.env, PORT: String(port), REDIS_URL };
  const child = spawn("node", ["server/server.js"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    const onData = (data) => {
      const s = String(data);
      if (s.includes("WebSocket server listening")) {
        child.stdout.off("data", onData);
        resolve(child);
      }
    };
    child.on("error", reject);
    child.stdout.on("data", onData);
    // Fallback timeout
    setTimeout(() => reject(new Error("Server start timeout on " + port)), 8000).unref();
  }).then(() => child);
}

async function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout: " + url)), 8000).unref();
  });
}

test("e2e: two servers, two clients, X wins", { timeout: 60000 }, async (t) => {
  // Start servers
  srv1 = await startServer(3001);
  srv2 = await startServer(3002);

  // Connect clients to different servers
  const a = await wsConnect("ws://127.0.0.1:3001");
  const b = await wsConnect("ws://127.0.0.1:3002");

  const gameId = "e2e-room-" + Date.now();

  // Helpers to wait for a specific message type
  function nextOfType(ws, type) {
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === type) {
            ws.off("message", onMsg);
            resolve(msg);
          }
        } catch {}
      };
      ws.on("message", onMsg);
      setTimeout(() => { ws.off("message", onMsg); reject(new Error("Timeout waiting for " + type)); }, 10000).unref();
    });
  }

  // Join both
  a.send(JSON.stringify({ type: "join", gameId, name: "Alice" }));
  b.send(JSON.stringify({ type: "join", gameId, name: "Bob" }));

  const aAssigned = await nextOfType(a, "assigned");
  const bAssigned = await nextOfType(b, "assigned");
  assert.match(aAssigned.seat, /X|O/);
  assert.match(bAssigned.seat, /X|O/);
  assert.notEqual(aAssigned.seat, bAssigned.seat);

  // Each side should receive an update after both have joined
  const firstUpdate = await nextOfType(a, "update");
  assert.equal(firstUpdate.state.status, "running");

  // We will drive a quick X win on top row: (0,0),(0,1),(0,2)
  // Figure out which client is X / O
  const isAX = aAssigned.seat === "X";
  const X = isAX ? a : b;
  const O = isAX ? b : a;

  // Helper to push a move and wait for update
  async function move(ws, row, col) {
    ws.send(JSON.stringify({ type: "move", row, col }));
    const upd = await nextOfType(ws, "update");
    return upd.state;
  }

  // Moves: X(0,0), O(1,0), X(0,1), O(1,1), X(0,2)
  await move(X, 0, 0);
  await move(O, 1, 0);
  await move(X, 0, 1);
  await move(O, 1, 1);
  const finalState = await move(X, 0, 2);

  assert.equal(finalState.status, "finished");
  assert.equal(finalState.winner, "X");

  a.close(); b.close();
});

after(async () => {
  // Clean up servers
  for (const child of [srv1, srv2]) {
    if (child && !child.killed) {
      child.kill("SIGINT");
      await delay(300);
    }
  }
});
