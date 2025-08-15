import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyBoard,
  initialState,
  assignSeat,
  validateMove,
  applyMove,
  checkWinner
} from "../game.js";

test("createEmptyBoard returns 3x3 empty grid", () => {
  const b = createEmptyBoard();
  assert.equal(b.length, 3);
  assert.equal(b[0].length, 3);
  assert.ok(b.flat().every(c => c === ""));
});

test("initial state basics", () => {
  const s = initialState("g1");
  assert.equal(s.gameId, "g1");
  assert.equal(s.status, "waiting");
  assert.equal(s.nextTurn, "X");
  assert.equal(s.winner, null);
  assert.equal(s.version, 0);
});

test("assignSeat assigns X then O and starts game", () => {
  let s = initialState("g2");
  s = assignSeat(s, { id: "p1", name: "Alice" });
  assert.equal(s.players.X.name, "Alice");
  assert.equal(s.status, "waiting"); // only one player

  s = assignSeat(s, { id: "p2", name: "Bob" });
  assert.equal(s.players.O.name, "Bob");
  assert.equal(s.status, "running");
  assert.ok(s.version >= 2);
});

test("validateMove enforces turn and emptiness", () => {
  let s = initialState("g3");
  s = assignSeat(s, { id:"p1", name:"A" });
  s = assignSeat(s, { id:"p2", name:"B" });
  // X moves valid at (0,0)
  validateMove(s, "X", 0, 0);
  // O cannot move yet
  assert.throws(() => validateMove(s, "O", 0, 1));
});

test("applyMove toggles turns and detects win", () => {
  let s = initialState("g4");
  s = assignSeat(s, { id:"p1", name:"A" });
  s = assignSeat(s, { id:"p2", name:"B" });

  s = applyMove(s, "X", 0, 0); // X
  assert.equal(s.nextTurn, "O");
  s = applyMove(s, "O", 1, 0); // O
  s = applyMove(s, "X", 0, 1); // X
  s = applyMove(s, "O", 1, 1); // O
  s = applyMove(s, "X", 0, 2); // X wins top row

  assert.equal(s.status, "finished");
  assert.equal(s.winner, "X");
});

test("checkWinner detects draw", () => {
  // A drawn board:
  const board = [
    ["X","O","X"],
    ["X","O","O"],
    ["O","X","X"]
  ];
  const outcome = checkWinner(board);
  assert.equal(outcome, "draw");
});
