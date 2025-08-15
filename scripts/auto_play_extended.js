// scripts/auto_play_extended.js
// Extended demo runner compatible with server protocol:
// type: "join"/"move"; fields: {gameId,name} and {row,col}

import { WebSocket } from "ws";
import { setTimeout as wait } from "node:timers/promises";

function randId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random()*10000)}`;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("timeout connect "+url)), 15000).unref();
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// wait for a message whose type is in 'types'
function onceOf(ws, types, timeoutMs=15000) {
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
    setTimeout(() => { ws.off("message", onMsg); reject(new Error("timeout "+t.join("/"))); }, timeoutMs).unref();
  });
}

// JOIN with retries (handles CAS races and temporary "two players" during join)
async function joinWithRetry(ws, gameId, name, who, maxRetries=8) {
  for (let i=0;i<maxRetries;i++) {
    send(ws, { type:"join", gameId, name });
    const msg = await onceOf(ws, ["assigned","error"]);
    if (msg.type === "assigned") return msg;
    const m = (msg.message || "").toLowerCase();
    const transient = m.includes("watched keys") || m.includes("conflict")
                   || m.includes("try again") || m.includes("two players");
    if (!transient) throw new Error(`${who} join error: ${msg.message}`);
    const backoff = 80 + i*40;
    console.log(`[auto] ${who} join retry ${i+1}/${maxRetries} after ${backoff}ms: ${msg.message}`);
    await wait(backoff);
  }
  throw new Error(`${who} join error: retries exhausted`);
}

// MOVE with retries (handles CAS races + "not your turn")
async function moveWithRetry(wsA, wsB, seat, row, col, maxRetries=8) {
  for (let i=0;i<maxRetries;i++) {
    // try to sync with latest update (non-fatal timeout)
    try {
      const latest = await Promise.race([
        onceOf(wsA, ["update","error"], 3000),
        onceOf(wsB, ["update","error"], 3000)
      ]);
      if (latest.type === "update" && latest.state.nextTurn !== seat) {
        await wait(50 + i*40);
        continue;
      }
      if (latest.type === "error") {
        const m = (latest.message||"").toLowerCase();
        const transient = m.includes("watched keys") || m.includes("conflict") || m.includes("try again");
        if (!transient) throw new Error("Move error: " + latest.message);
      }
    } catch { /* no fresh update; proceed */ }

    const target = seat === "X" ? wsA : wsB;
    send(target, { type:"move", row, col });

    const resp = await Promise.race([
      onceOf(wsA, ["update","error"], 4000),
      onceOf(wsB, ["update","error"], 4000)
    ]);

    if (resp.type === "update") return resp.state;

    const m = (resp.message||"").toLowerCase();
    const transient = m.includes("watched keys") || m.includes("conflict") || m.includes("try again") || m.includes("not your turn");
    if (!transient) throw new Error("Move error: " + resp.message);

    const backoff = 100 + i*60;
    console.log(`[auto] move retry ${i+1}/${maxRetries} after ${backoff}ms: ${resp.message}`);
    await wait(backoff);
  }
  throw new Error("Move error: retries exhausted");
}

async function runScenario(scenario, Aname, Bname, urlA, urlB) {
  const gameId = randId(scenario);
  console.log(`[auto] gameId=${gameId} scenario=${scenario}`);

  // Late-join needs A first; others can connect both immediately
  const wsA = await connect(urlA);
  let wsB;

  // A joins first
  const aAssigned = await joinWithRetry(wsA, gameId, Aname, "A");
  let bAssigned;

  if (scenario === "late_join") {
    await wait(500); // delay B join
    wsB = await connect(urlB);
    bAssigned = await joinWithRetry(wsB, gameId, Bname, "B");
  } else {
    wsB = await connect(urlB);
    bAssigned = await joinWithRetry(wsB, gameId, Bname, "B");
  }

  const bySeat = { [aAssigned.seat]: wsA, [bAssigned.seat]: wsB };
  console.log(`[auto] seats: ${Aname}=${aAssigned.seat}, ${Bname}=${bAssigned.seat}`);

  // First running update
  const first = await Promise.race([ onceOf(wsA, ["update","error"]), onceOf(wsB, ["update","error"]) ]);
  if (first.type === "error") throw new Error("First update error: " + first.message);
  console.log(`[auto] status=${first.state.status} next=${first.state.nextTurn} v${first.state.version}`);

  // Plans per scenario (explicit seats so server turn rules are respected)
  const plans = {
    win_row:  [ ["X",0,0], ["O",1,0], ["X",0,1], ["O",1,1], ["X",0,2] ],
    win_col:  [ ["X",0,0], ["O",0,1], ["X",1,0], ["O",1,1], ["X",2,0] ],
    win_diag: [ ["X",0,0], ["O",0,1], ["X",1,1], ["O",1,0], ["X",2,2] ],
    draw:     [ ["X",0,0], ["O",0,1], ["X",0,2],
                ["O",1,1], ["X",1,0], ["O",1,2],
                ["X",2,1], ["O",2,0], ["X",2,2] ],
    // illegal_move: O tries to play on an occupied cell; then a valid move to continue
    illegal_move: [
      ["X",0,0],
      ["O",0,0],   // illegal: Cell not empty (expect error)
      ["O",1,1],   // valid continuation
      ["X",0,1],
      ["O",2,2],
      ["X",0,2]    // X wins row
    ],
    // late_join already handled by joining later; just play a simple sequence
    late_join: [ ["X",0,0], ["O",1,1], ["X",0,1], ["O",2,2], ["X",0,2] ],
    // disconnect: B disconnects then reconnects with same name and continues
    disconnect: [ ["X",0,0], ["O",1,1], ["X",0,1], ["O",2,2], ["X",0,2] ]
  };

  const plan = plans[scenario] || plans.win_row;

  for (let i=0; i<plan.length; i++) {
    const [seat,row,col] = plan[i];

    // special handling for disconnect before O's 2nd move
    if (scenario === "disconnect" && i === 2) {
      console.log("[auto] disconnecting B...");
      wsB.close();
      await wait(200);
      console.log("[auto] reconnecting B...");
      wsB = await connect(urlB);
      bAssigned = await joinWithRetry(wsB, gameId, Bname, "B-rejoin");
      bySeat[bAssigned.seat] = wsB;

      // במקום לחכות ל-update, רק המתנה קלה
      await wait(200);
      console.log("[auto] rejoined, continuing game...");
    }

    console.log(`[auto] ${seat} -> (${row},${col})`);
    const nextState = await moveWithRetry(wsA, wsB, seat, row, col);
    console.log(`[auto] v${nextState.version} next=${nextState.nextTurn} status=${nextState.status} winner=${nextState.winner}`);
    if (nextState.status === "finished") break;
    await wait(50);
  }

  await wait(200);
  wsA.close(); wsB.close();
  console.log("[auto] done");
}

// CLI: node scripts/auto_play_extended.js <scenario> <Aname> <Bname> <urlA> <urlB>
const [scenario, Aname, Bname, urlA, urlB] = process.argv.slice(2);
if (!scenario || !Aname || !Bname || !urlA || !urlB) {
  console.log("Usage: node scripts/auto_play_extended.js <scenario> <Aname> <Bname> <urlA> <urlB>");
  process.exit(1);
}

runScenario(scenario, Aname, Bname, urlA, urlB)
  .catch(e => { console.error("[auto] error:", e.message); process.exit(1); });
