/**
 * Core game logic for Tic-Tac-Two.
 * Pure functions for testability and maintainability.
 *
 * Exports:
 * - initialState: create a new game state
 * - assignSeat: assign a player to X or O
 * - validateMove: check if a move is valid
 * - applyMove: apply a move and update state
 * - checkWinner: check for win/draw
 */

export const EMPTY = "";
export const SIZE = 3;

export function createEmptyBoard() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => EMPTY));
}

export function initialState(gameId) {
  return {
    gameId,
    board: createEmptyBoard(),
    players: {},        // { X: {id, name}, O: {id, name} }
    nextTurn: "X",
    status: "waiting",  // waiting | running | finished
    winner: null,       // "X" | "O" | "draw" | null
    version: 0          // increments each state change
  };
}

export function assignSeat(state, playerInfo) {
  const s = structuredClone(state);
  if (!s.players.X) {
    s.players.X = playerInfo;
  } else if (!s.players.O) {
    s.players.O = playerInfo;
    if (s.status === "waiting") s.status = "running";
  } else {
    throw new Error("Game already has two players");
  }
  s.version += 1;
  return s;
}

export function checkWinner(board) {
  const lines = [];

  // Rows and cols
  for (let i = 0; i < SIZE; i++) {
    lines.push(board[i]); // row i
    lines.push([board[0][i], board[1][i], board[2][i]]); // col i
  }

  // Diagonals
  lines.push([board[0][0], board[1][1], board[2][2]]);
  lines.push([board[0][2], board[1][1], board[2][0]]);

  for (const line of lines) {
    if (line[0] && line[0] === line[1] && line[1] === line[2]) {
      return line[0]; // "X" or "O"
    }
  }

  // Draw?
  const anyEmpty = board.some(row => row.some(cell => cell === EMPTY));
  return anyEmpty ? null : "draw";
}

export function validateMove(state, playerSeat, row, col) {
  if (state.status !== "running") throw new Error("Game is not running");
  if (playerSeat !== state.nextTurn) throw new Error("Not your turn");
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) throw new Error("Out of bounds");
  if (state.board[row][col] !== EMPTY) throw new Error("Cell not empty");
}

export function applyMove(state, playerSeat, row, col) {
  // Throws if invalid
  validateMove(state, playerSeat, row, col);

  const s = structuredClone(state);
  s.board[row][col] = playerSeat;

  const outcome = checkWinner(s.board);
  if (outcome === "draw") {
    s.status = "finished";
    s.winner = "draw";
  } else if (outcome === "X" || outcome === "O") {
    s.status = "finished";
    s.winner = outcome;
  } else {
    s.nextTurn = playerSeat === "X" ? "O" : "X";
  }

  s.version += 1;
  return s;
}

// All functions already pure and modular. Added JSDoc and clarified exports.
