import assert from "node:assert/strict";
import test from "node:test";

import { createRelayServer } from "../relay/node/server.mjs";

function waitEvent(target, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${name} 超时`)), timeoutMs);
    target.addEventListener(name, (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

test("node relay rejects a different healthy daemon instance and lets the same instance replace itself", async () => {
  const server = createRelayServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `ws://127.0.0.1:${server.address().port}/v1/daemon/daemon123`;
  const first = new WebSocket(`${base}?inst=boot_one_123`);
  await waitEvent(first, "open");
  first.send('{"t":"hb"}');
  await waitEvent(first, "message");

  const other = new WebSocket(`${base}?inst=boot_two_123`);
  const rejected = await waitEvent(other, "close");
  assert.equal(rejected.code, 1008);
  assert.equal(rejected.reason, "daemon already connected");
  assert.equal(first.readyState, WebSocket.OPEN);

  const replacement = new WebSocket(`${base}?inst=boot_one_123`);
  const firstClosed = waitEvent(first, "close");
  await waitEvent(replacement, "open");
  const closed = await firstClosed;
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, "replaced");

  replacement.close();
  await waitEvent(replacement, "close");
  await new Promise((resolve) => server.close(resolve));
});
