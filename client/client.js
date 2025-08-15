import readline from "node:readline";
import { WebSocket } from "ws";

/**
 * CLI WebSocket client for Tic-Tac-Two
 * Usage:
 *   node client/client.js ws://localhost:3001 <gameId> <yourName>
 *
 * Features:
 * - Real-time updates
 * - Simple CLI interface
 * - Clear board rendering
 * - Handles errors and invalid moves gracefully
 */

const WS_URL = process.argv[2] || "ws://localhost:3001";
const GAME_ID = process.argv[3] || "demo";
const YOUR_NAME = process.argv[4] || "Player";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
  return new Promise(res => rl.question(q, ans => res(ans)));
}

function renderBoard(state) {
  const b = state.board;
  const rows = b.map(r => r.map(c => c || " ").join(" \u2502 "));
  const sep = "\n\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500\n";
  return `\n ${rows[0]}${sep} ${rows[1]}${sep} ${rows[2]}\n`;
}

function promptMove() {
  if (!lastState || lastState.status !== "running") return;
  ask(`Player ${mySeat}, enter your move as 'row col' (0-2 0-2): `).then(input => {
    const [row, col] = input.split(/\s+/).map(Number);
    if (
      Number.isInteger(row) &&
      Number.isInteger(col) &&
      row >= 0 && row < 3 &&
      col >= 0 && col < 3
    ) {
      ws.send(JSON.stringify({ type: "move", gameId: GAME_ID, seat: mySeat, row, col }));
    } else {
      err("Invalid input. Please enter row and col as numbers between 0 and 2.");
      promptMove();
    }
  });
}

function info(msg) { console.log(`[INFO] ${msg}`); }
function err(msg)  { console.log(`[ERR ] ${msg}`); }

const ws = new WebSocket(WS_URL);
let mySeat = null;
let lastState = null;

ws.on("open", () => {
  console.log(`Connected to ${WS_URL}. Joining game '${GAME_ID}' as '${YOUR_NAME}'...`);
  ws.send(JSON.stringify({ type: "join", gameId: GAME_ID, name: YOUR_NAME }));
});

ws.on("message", async (data) => {
  let msg;
  try { msg = JSON.parse(String(data)); } catch { return; }

  if (msg.type === "assigned") {
    mySeat = msg.seat;
    info(`Assigned seat: ${mySeat}`);
  }
  else if (msg.type === "update") {
    lastState = msg.state;
    console.clear();
    console.log(`Game: ${lastState.gameId} | Status: ${lastState.status} | Next: ${lastState.nextTurn} | v${lastState.version}`);
    console.log(renderBoard(lastState));

    if (lastState.status === "finished") {
      if (lastState.winner === "draw") {
        info("Game over: Draw!");
      } else {
        info(`Game over: Player ${lastState.winner} wins!`);
      }
      rl.close();
      ws.close();
    } else if (mySeat === lastState.nextTurn) {
      promptMove();
    } else {
      info(`Waiting for Player ${lastState.nextTurn}...`);
    }
  }
  else if (msg.type === "error") {
    err(msg.message);
    if (mySeat === lastState?.nextTurn && lastState?.status === "running") {
      promptMove();
    }
  }
  else if (msg.type === "info") {
    info(msg.message);
  }
});

ws.on("close", () => {
  info("Disconnected.");
  rl.close();
});
