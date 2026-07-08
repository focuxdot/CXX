import assert from "node:assert/strict";
import test from "node:test";

import { daemonRelayUrl } from "../daemon/src/relay-link.mjs";

test("daemon relay URL includes platform metadata", () => {
  assert.equal(
    daemonRelayUrl("wss://relay.wokey.ai/", "abc123", { platform: "darwin" }),
    "wss://relay.wokey.ai/v1/daemon/abc123?os=darwin&app=cxx",
  );
});

test("daemon relay URL encodes metadata", () => {
  assert.equal(
    daemonRelayUrl("wss://relay.example.test", "abc123", { platform: "win 32", app: "c x x" }),
    "wss://relay.example.test/v1/daemon/abc123?os=win+32&app=c+x+x",
  );
});
