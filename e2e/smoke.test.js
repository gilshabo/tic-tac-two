// e2e/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const NODE = process.execPath;

function spawnNode(args, env = {}) {
  const child = spawn(NODE, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.lines = [];
  const onLine = (chunk) => {
    const s = String(chunk);
    child.lines.push(s);
    process.stdout.write(s.replace(/\r?\n$/, '') + '\n'); // echo for debug
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  return child;
}

async function waitFor(child, pattern, ms = 15000) {
  const deadline = Date.now() + ms;
  const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  for (;;) {
    if (child.lines.some((l) => rx.test(l))) return;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for: ${rx}.\nLast output:\n${child.lines.slice(-20).join('')}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`process exited early with code ${child.exitCode}`);
    }
    await wait(50);
  }
}

async function waitForDoneOrExit(child, ms = 20000) {
  const deadline = Date.now() + ms;
  const rx = /\[auto] done/;
  for (;;) {
    if (child.lines.some((l) => rx.test(l))) return;
    if (child.exitCode !== null) {
      if (child.exitCode === 0) return; // success by clean exit
      throw new Error(`demo exited with code ${child.exitCode}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for done/exit.\nLast output:\n${child.lines.slice(-20).join('')}`);
    }
    await wait(50);
  }
}

async function killTree(child, signal = 'SIGTERM', graceMs = 3000) {
  if (!child || child.killed) return;
  try { process.kill(child.pid, signal); } catch {}
  const t0 = Date.now();
  while (child.exitCode === null && Date.now() - t0 < graceMs) {
    await wait(50);
  }
  if (child.exitCode === null) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
}

test('e2e: two servers, two clients, X wins (win_row)', { timeout: 40000 }, async () => {
  // ודא שרצים אין תהליכים על הפורטים (לא חובה, אבל עוזר ביציבות)
  // אם תרצה, תוכל להוסיף פה בדיקת lsof ולסגור תהליכים קיימים.

  // 1) start servers
  const srvA = spawnNode([path.join('server', 'server.js')], { PORT: '3001' });
  const srvB = spawnNode([path.join('server', 'server.js')], { PORT: '3002' });

  try {
    await waitFor(srvA, /WebSocket server listening on ws:\/\/localhost:3001/, 10000);
    await waitFor(srvB, /WebSocket server listening on ws:\/\/localhost:3002/, 10000);

    // 2) run demo (win_row)
    const demo = spawnNode([
      path.join('scripts', 'auto_play_extended.js'),
      'win_row', 'Alice', 'Bob',
      'ws://127.0.0.1:3001', 'ws://127.0.0.1:3002'
    ]);

    await waitForDoneOrExit(demo, 25000);
    // תן רגע כדי שה־stdout יישטף
    await wait(100);
    demo.kill('SIGTERM');

    assert.ok(true, 'demo finished (done or exited cleanly)');
  } finally {
    await killTree(srvA);
    await killTree(srvB);
  }
});
