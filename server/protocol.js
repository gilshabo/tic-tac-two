/**
 * Message types and helpers for Tic-Tac-Two protocol.
 * Used for client<->server and server<->server communication.
 *
 * C2S: Client to Server
 * S2C: Server to Client
 * FED: Inter-server (federation)
 */

export const C2S = {
  JOIN: "join",
  MOVE: "move",
  PING: "ping"
};

export const S2C = {
  ASSIGNED: "assigned",   // { type, seat: "X"|"O", you: {id,name}, opponent?: {id,name} }
  UPDATE: "update",       // { type, state }
  ERROR: "error",         // { type, message }
  INFO: "info"            // { type, message }
};

// Inter-server (Redis pub/sub) envelope
export const FED = {
  STATE: "state"          // { type:"state", state, originId, eventId }
};
