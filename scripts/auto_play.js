// scripts/auto_play.js
import { WebSocket } from "ws";
import { setTimeout as wait } from "node:timers/promises";

const args = process.argv.slice(2);
const [gameId="demo1", nameA="Alice", nameB="Bob",
       urlA="ws://127.0.0.1:3001", urlB="ws://127.0.0.1:3002",
       scenario="win"] = args;

const sequences = {
  win:  [ ["X",0,0], ["O",1,0], ["X",0,1], ["O",1,1], ["X",0,2] ],
  draw: [ ["X",0,0], ["O",0,1], ["X",0,2], ["O",1,1], ["X",1,0],
          ["O",1,2], ["X",2,1], ["O",2,0], ["X",2,2] ]
};
const plan = sequences[scenario] || sequences.win;

console.log(`[auto] gameId=${gameId} A=${nameA}@${urlA} B=${nameB}@${urlB} scenario=${scenario}`);

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("timeout connect " + url)), 15000).unref();
  });
}

function onceOf(ws, types) {
  const t = Array.isArray(types) ? types : [types];
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (t.includes(msg.type)) {
          ws.off("message", onMsg);
          resolve(msg);
        }
      } catch {}
    };
    ws.on("message", onMsg);
    setTimeout(() => { ws.off("message", onMsg); reject(new Error("timeout " + t.join("/"))); }, 15000).unref();
  });
}

function send(ws, obj){ ws.send(JSON.stringify(obj)); }

async function joinWithRetry(ws, payload, who, maxRetries = 8) {
  for (let i = 0; i < maxRetries; i++) {
    send(ws, payload);
    const msg = await onceOf(ws, ["assigned","error"]);
    if (msg.type === "assigned") return msg;

    const m = (msg.message || "").toLowerCase();
    const transient =
      m.includes("watched keys") ||
      m.includes("conflict") ||
      m.includes("try again") ||
      m.includes("game already has two players");

    if (!transient) throw new Error(`${who} join error: ${msg.message}`);

    const backoff = 80 + i * 40;
    console.log(`[auto] ${who} join retry ${i+1}/${maxRetries} after ${backoff}ms: ${msg.message}`);
    await wait(backoff);
  }
  throw new Error(`${who} join error: retries exhausted`);
}

(async () => {
  const a = await connect(urlA);
  const b = await connect(urlB);

  const aAssigned = await joinWithRetry(a, { type:"join", gameId, name: nameA }, "A");
  await wait(120);
  const bAssigned = await joinWithRetry(b, { type:"join", gameId, name: nameB }, "B");

  const seats = { [aAssigned.seat]: a, [bAssigned.seat]: b };
  console.log(`[auto] seats: ${nameA}=${aAssigned.seat}, ${nameB}=${bAssigned.seat}`);

  const first = await Promise.race([ onceOf(a, ["update","error"]), onceOf(b, ["update","error"]) ]);
  if (first.type === "error") throw new Error("First update error: " + first.message);
  console.log(`[auto] status=${first.state.status} next=${first.state.nextTurn} v${first.state.version}`);

  for (const [seat,row,col] of plan) {
    const ws = seats[seat];
    console.log(`[auto] ${seat} -> (${row},${col})`);
    send(ws, { type:"move", row, col });
    const upd = await Promise.race([ onceOf(a, ["update","error"]), onceOf(b, ["update","error"]) ]);
    if (upd.type === "error") throw new Error("Move error: " + upd.message);
    console.log(`[auto] v${upd.state.version} next=${upd.state.nextTurn} status=${upd.state.status} winner=${upd.state.winner}`);
    if (upd.state.status === "finished") break;
    await wait(120);
  }

  await wait(200);
  a.close(); b.close();
  console.log("[auto] done");
})().catch(e => {
  console.error("[auto] error:", e.message);
  process.exit(1);
});
