// TerminalManager 单元测试（fake host，不起真实 PTY——真实链路见 scripts/smoke-terminal.mjs）。
// 覆盖：preset、create 校验、状态机、owner/接管、输出流与增量 attach、快照、
// bracketed paste、信号白名单、close 自发起抑制、bell 合并、restore。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TerminalManager, normalizeTerminalPresets, DEFAULT_TERMINAL_PRESETS } from "../daemon/src/terminal-manager.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— fakes ——
class FakeHostClient extends EventEmitter {
  writes = [];
  resizes = [];
  signals = [];
  closed = false;
  disconnected = false;
  seq = 0;

  attach() {}
  write(data) {
    this.writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  }
  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }
  signal(kind) {
    this.signals.push(kind);
  }
  close() {
    this.closed = true;
  }
  disconnect() {
    this.disconnected = true;
  }
  // 测试辅助：以正确的绝对 seq 送一段输出
  feed(text) {
    const buf = Buffer.from(text, "utf8");
    this.emit("data", this.seq, buf);
    this.seq += buf.length;
  }
}

function makeSink(deviceId = "dev1") {
  return {
    deviceId,
    frames: [],
    pushTerminal(method, params, opts) {
      this.frames.push({ method, params, low: opts?.low === true });
    },
    of(method) {
      return this.frames.filter((f) => f.method === method);
    },
  };
}

function makeEnv() {
  return { PATH: "/nonexistent-path-for-test", SHELL: "/bin/sh" };
}

// hostBin 用一个必然存在的文件充数（available 检查 existsSync）
const FAKE_HOST_BIN = process.execPath;

function makeManager({ onEvent, broadcast, adapter, isCwdAllowed, getPresets } = {}) {
  const events = [];
  const broadcasts = [];
  const spawned = [];
  const defaultAdapter = {
    spawnPtyHost({ dir, spec }) {
      const client = new FakeHostClient();
      spawned.push({ dir, spec, client });
      return Promise.resolve({
        client,
        hello: { v: 1, cols: spec.cols, rows: spec.rows, seq: 0, ringStart: 0, exited: false, childPid: 42 },
      });
    },
    reattachPtyHost() {
      return Promise.reject(new Error("no host"));
    },
    listPtyHosts() {
      return [];
    },
    removePtyHostDir() {},
  };
  const mgr = new TerminalManager({
    hostBin: FAKE_HOST_BIN,
    baseDir: mkdtempSync(join(tmpdir(), "cxx-tm-test-")),
    isCwdAllowed: isCwdAllowed ?? (() => true),
    onEvent: onEvent ?? ((type, info) => events.push({ type, info })),
    broadcast: broadcast ?? ((method, params) => broadcasts.push({ method, params })),
    adapter: adapter ?? defaultAdapter,
    getEnv: () => Promise.resolve(makeEnv()),
    ...(getPresets ? { getPresets } : {}),
  });
  return { mgr, events, broadcasts, spawned };
}

test("presets：缺省内置 Claude Code + Shell，不做 PATH 探测，剥离 executable/args", async () => {
  const { mgr } = makeManager(); // 不传 getPresets → 回退内置默认
  const presets = await mgr.presets();
  assert.deepEqual(presets.map((p) => p.id), ["claude", "shell"]);
  const shell = presets.find((p) => p.id === "shell");
  assert.equal(shell.silenceNotify, false);
  assert.equal(shell.defaultInputMode, "keyboard");
  assert.equal(shell.command, "");
  const claude = presets.find((p) => p.id === "claude");
  assert.equal(claude.command, "claude");
  assert.equal(claude.defaultInputMode, "instruction");
  // executable/args 是内部实现，不下发客户端
  for (const p of presets) {
    assert.equal(p.executable, undefined);
    assert.equal(p.args, undefined);
  }
  mgr.stop();
});

test("presets：读实时 config，command→spec 走登录 shell -lc；空命令=交互式 shell", async () => {
  let list = [
    { id: "htop", name: "htop", command: "htop" },
    { id: "shell", name: "Shell", command: "" },
  ];
  const { mgr, spawned } = makeManager({ getPresets: () => list });
  let presets = await mgr.presets();
  assert.deepEqual(presets.map((p) => p.id), ["htop", "shell"]);

  // 非空命令：executable=登录 shell，args=[...shell.args, "-c", command]
  await mgr.create({ presetId: "htop", cwd: tmpdir(), deviceId: "devA" });
  const htopSpec = spawned.at(-1).spec;
  assert.equal(htopSpec.executable, "/bin/sh");
  assert.deepEqual(htopSpec.args, ["-l", "-c", "htop"]);

  // 空命令：交互式登录 shell（无 -c）
  await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devB" });
  const shSpec = spawned.at(-1).spec;
  assert.equal(shSpec.executable, "/bin/sh");
  assert.deepEqual(shSpec.args, ["-l"]);

  // 编辑 config 后 presets() 立即反映（无缓存）
  list = [{ id: "only", name: "Only", command: "echo hi" }];
  presets = await mgr.presets();
  assert.deepEqual(presets.map((p) => p.id), ["only"]);
  mgr.stop();
});

test("normalizeTerminalPresets：校验、去控制符、补 id、条数/长度上限、至少 1 项", () => {
  // 正常 + id 补全
  const out = normalizeTerminalPresets([{ name: "A", command: "a" }, { id: "keep", name: "B", command: "" }]);
  assert.equal(out.length, 2);
  assert.match(out[0].id, /^p[\w-]+$/); // 缺 id → 生成
  assert.equal(out[1].id, "keep");
  // 去掉名字里的控制符
  assert.equal(normalizeTerminalPresets([{ name: "x\x00\x1by", command: "" }])[0].name, "xy");
  // 空列表 / 非数组 → 400
  assert.throws(() => normalizeTerminalPresets([]), /至少/);
  assert.throws(() => normalizeTerminalPresets("nope"), /至少/);
  // 空名字 → 400
  assert.throws(() => normalizeTerminalPresets([{ name: "   ", command: "x" }]), /名称不能为空/);
  // 名字过长 → 400
  assert.throws(() => normalizeTerminalPresets([{ name: "n".repeat(41), command: "" }]), /名称最长/);
  // 命令过长 → 400
  assert.throws(() => normalizeTerminalPresets([{ name: "ok", command: "c".repeat(501) }]), /命令最长/);
  // 超过 20 项 → 400
  assert.throws(
    () => normalizeTerminalPresets(Array.from({ length: 21 }, (_, i) => ({ name: `p${i}`, command: "" }))),
    /最多/,
  );
  // 保留 inputMode/quickKeys/silenceNotify，命令去 NUL
  const kept = normalizeTerminalPresets([
    { name: "C", command: "a\x00b", inputMode: "keyboard", quickKeys: [{ label: "x", seq: "y" }], silenceNotify: true },
  ])[0];
  assert.equal(kept.command, "ab");
  assert.equal(kept.inputMode, "keyboard");
  assert.deepEqual(kept.quickKeys, [{ label: "x", seq: "y" }]);
  assert.equal(kept.silenceNotify, true);
  // 内置默认自身应通过校验
  assert.doesNotThrow(() => normalizeTerminalPresets(DEFAULT_TERMINAL_PRESETS));
});

test("create：未知 preset / 坏 cwd / 白名单外 一律拒绝", async () => {
  const { mgr } = makeManager({ isCwdAllowed: (cwd) => cwd !== "/tmp" });
  await assert.rejects(() => mgr.create({ presetId: "nope", cwd: tmpdir() }), /未知启动方式/);
  await assert.rejects(() => mgr.create({ presetId: "shell", cwd: "/no/such/dir/xyz" }), /工作目录不可用/);
  await assert.rejects(() => mgr.create({ presetId: "shell", cwd: "/tmp" }), /不在允许列表/);
  mgr.stop();
});

test("create 成功：RUNNING、标题、owner、spec 带 meta；列表广播", async () => {
  const { mgr, spawned, broadcasts } = makeManager();
  const view = await mgr.create({
    presetId: "shell",
    cwd: tmpdir(),
    cols: 52,
    rows: 20,
    deviceId: "devA",
    deviceName: "iPhone",
  });
  assert.equal(view.status, "RUNNING");
  assert.equal(view.cols, 52);
  assert.equal(view.ownerDeviceId, "devA");
  assert.match(view.title, /^Shell · /);
  const { spec } = spawned[0];
  assert.equal(spec.meta.presetId, "shell");
  assert.equal(spec.env.PATH, makeEnv().PATH);
  assert.ok(broadcasts.some((b) => b.method === "terminal.listChanged"));
  assert.equal(mgr.list().length, 1);
  mgr.stop();
});

test("输出流：coalesce 后推 LOW 帧，seq 正确，headless 快照含内容", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const sink = makeSink("devA");
  mgr.attach(sink, { terminalId: view.terminalId, deviceId: "devA" });
  const client = spawned[0].client;
  client.feed("hello-terminal-输出");
  await sleep(40); // > COALESCE_MS
  const outs = sink.of("terminal.output");
  assert.equal(outs.length, 1);
  assert.equal(outs[0].low, true);
  assert.equal(outs[0].params.seq, 0);
  assert.equal(Buffer.from(outs[0].params.data, "base64").toString("utf8"), "hello-terminal-输出");
  // 新观察者 attach → 快照包含已有内容
  const sink2 = makeSink("devB");
  const res = mgr.attach(sink2, { terminalId: view.terminalId, deviceId: "devB" });
  assert.equal(res.mode, "snapshot");
  const snap = sink2.of("terminal.snapshot");
  assert.ok(snap.length >= 1);
  assert.equal(snap.at(-1).params.final, true);
  assert.ok(snap.map((f) => f.params.data).join("").includes("hello-terminal-输出"));
  mgr.stop();
});

test("attach 增量：同代 + haveSeq 在 ring 内 → delta 只补缺口", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const client = spawned[0].client;
  client.feed("AAAA");
  await sleep(40);
  client.feed("BBBB");
  await sleep(40);
  const sink = makeSink("devA");
  const res = mgr.attach(sink, {
    terminalId: view.terminalId,
    generation: view.generation,
    haveSeq: 4, // 已有 AAAA
    deviceId: "devA",
  });
  assert.equal(res.mode, "delta");
  const outs = sink.of("terminal.output");
  assert.equal(outs.length, 1);
  assert.equal(outs[0].params.seq, 4);
  assert.equal(Buffer.from(outs[0].params.data, "base64").toString("utf8"), "BBBB");
  // 代次不匹配 → 回落快照
  const sink2 = makeSink("devA");
  const res2 = mgr.attach(sink2, { terminalId: view.terminalId, generation: "stale", haveSeq: 4, deviceId: "devA" });
  assert.equal(res2.mode, "snapshot");
  mgr.stop();
});

test("input：非 owner 409；owner 可写；bracketed paste 按 DECSET 2004 包裹", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const client = spawned[0].client;
  assert.throws(() => mgr.input(view.terminalId, "devB", { text: "ls" }), /不是该终端的控制者/);
  mgr.input(view.terminalId, "devA", { text: "ls", submit: true });
  assert.equal(client.writes[0], "ls\r");
  // 打开 bracketed paste 模式后，指令文本被包裹
  client.feed("\x1b[?2004h");
  await sleep(30);
  mgr.input(view.terminalId, "devA", { text: "line1\nline2", submit: true });
  assert.equal(client.writes[1], "\x1b[200~line1\nline2\x1b[201~\r");
  // 原始字节路径（base64）
  mgr.input(view.terminalId, "devA", { data: Buffer.from("\x03").toString("base64") });
  assert.equal(client.writes[2], "\x03");
  mgr.stop();
});

test("signal：只放行 interrupt/eof", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  mgr.signal(view.terminalId, "devA", "interrupt");
  mgr.signal(view.terminalId, "devA", "eof");
  assert.throws(() => mgr.signal(view.terminalId, "devA", "kill"), /不支持的信号/);
  assert.deepEqual(spawned[0].client.signals, ["interrupt", "eof"]);
  mgr.stop();
});

test("takeover：owner 转移 + controlChanged 广播 youAreOwner 标记", async () => {
  const { mgr } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA", deviceName: "A机" });
  const sinkA = makeSink("devA");
  const sinkB = makeSink("devB");
  mgr.attach(sinkA, { terminalId: view.terminalId, deviceId: "devA" });
  mgr.attach(sinkB, { terminalId: view.terminalId, deviceId: "devB" });
  mgr.takeover(view.terminalId, "devB", "B机");
  const a = sinkA.of("terminal.controlChanged")[0];
  const b = sinkB.of("terminal.controlChanged")[0];
  assert.equal(a.params.youAreOwner, false);
  assert.equal(b.params.youAreOwner, true);
  assert.equal(a.params.ownerDeviceName, "B机");
  // 旧 owner 输入被拒，新 owner 可输入
  assert.throws(() => mgr.input(view.terminalId, "devA", { text: "x" }), /不是该终端的控制者/);
  mgr.input(view.terminalId, "devB", { text: "x" });
  mgr.stop();
});

test("close 自发起：exit 不触发通知事件；外部退出触发 exited 事件", async () => {
  const { mgr, events, spawned } = makeManager();
  // 终端 1：owner 主动 close → 抑制通知
  const v1 = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  mgr.close(v1.terminalId, "devA");
  assert.equal(spawned[0].client.closed, true);
  spawned[0].client.emit("exit", { code: 0, signal: null });
  // 终端 2：外部退出 → 推 exited
  const v2 = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  spawned[1].client.emit("exit", { code: 1, signal: null });
  assert.equal(events.filter((e) => e.type === "exited").length, 1);
  assert.equal(events[0].info.terminalId, v2.terminalId);
  assert.equal(events[0].info.exitCode, 1);
  // 状态与 watcher 帧
  assert.equal(mgr.get(v1.terminalId).status, "EXITED");
  // 已退出终端 close = 移除
  const r = mgr.close(v1.terminalId, "devA");
  assert.equal(r.removed, true);
  assert.equal(mgr.get(v1.terminalId), null);
  mgr.stop();
});

test("exit 推送 terminal.exited 给 watcher；exited 后 input 409", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const sink = makeSink("devA");
  mgr.attach(sink, { terminalId: view.terminalId, deviceId: "devA" });
  spawned[0].client.emit("exit", { code: 0, signal: null });
  const ex = sink.of("terminal.exited");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].params.exitCode, 0);
  assert.throws(() => mgr.input(view.terminalId, "devA", { text: "x" }), /终端已结束/);
  mgr.stop();
});

test("bell：60s 窗口内只上抛一次", async () => {
  const { mgr, events, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const client = spawned[0].client;
  client.feed("\x07");
  await sleep(30);
  client.feed("\x07\x07");
  await sleep(30);
  const bells = events.filter((e) => e.type === "bell");
  assert.equal(bells.length, 1);
  assert.equal(bells[0].info.terminalId, view.terminalId);
  mgr.stop();
});

test("restore：扫描注册目录恢复 DETACHED 会话，代次翻新，owner 清零", async () => {
  const fakeClient = new FakeHostClient();
  const adapter = {
    spawnPtyHost() {
      throw new Error("unused");
    },
    reattachPtyHost({ sinceSeq }) {
      assert.equal(sinceSeq, 0); // 全量 ring 重放恢复画面
      return Promise.resolve({
        client: fakeClient,
        hello: { v: 1, cols: 100, rows: 30, seq: 500, ringStart: 200, exited: false, childPid: 7 },
      });
    },
    listPtyHosts() {
      return [
        {
          terminalId: "t-old",
          dir: "/fake/t-old",
          alive: true,
          hostPid: 1,
          childPid: 7,
          startedAt: 123,
          meta: { title: "Claude Code · CXX", presetId: "claude", presetName: "Claude Code", cwd: "/tmp", createdAt: 123, silenceNotify: true },
          exit: null,
        },
        // host 已死且无 exit.json 的残骸：应被清理、不进列表
        { terminalId: "t-dead", dir: "/fake/t-dead", alive: false, hostPid: 2, childPid: 8, startedAt: 1, meta: {}, exit: null },
      ];
    },
    removePtyHostDir() {},
  };
  const { mgr } = makeManager({ adapter });
  await mgr.restore();
  const list = mgr.list();
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.terminalId, "t-old");
  assert.equal(s.status, "DETACHED");
  assert.equal(s.title, "Claude Code · CXX");
  assert.equal(s.ownerDeviceId, null); // 重启后控制权清零
  assert.equal(s.cols, 100);
  // 首个接管者取得控制权后可输入
  mgr.takeover("t-old", "devZ", "Z机");
  mgr.input("t-old", "devZ", { text: "continue" });
  assert.equal(fakeClient.writes[0], "continue");
  mgr.stop();
});

test("并发上限：达到 MAX_TERMINALS 后 create 明确拒绝", async () => {
  const { mgr } = makeManager();
  for (let i = 0; i < 8; i++) {
    await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  }
  await assert.rejects(() => mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" }), /已达上限/);
  mgr.stop();
});

test("spawn 失败：FAILED、目录回收、错误上抛", async () => {
  const removed = [];
  const adapter = {
    spawnPtyHost() {
      return Promise.reject(new Error("boom"));
    },
    reattachPtyHost() {
      return Promise.reject(new Error("no"));
    },
    listPtyHosts() {
      return [];
    },
    removePtyHostDir(dir) {
      removed.push(dir);
    },
  };
  const { mgr } = makeManager({ adapter });
  await assert.rejects(() => mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" }), /终端启动失败/);
  assert.equal(removed.length, 1);
  // FAILED 会话保留在列表供查看
  assert.equal(mgr.list()[0]?.status, "FAILED");
  mgr.stop();
});

// —— 评审回归 ——

test("attach 尺寸夹取：巨值不透传给 xterm（防 daemon OOM）", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const sink = makeSink("devA");
  mgr.attach(sink, { terminalId: view.terminalId, deviceId: "devA", cols: 2_000_000_000, rows: 999999 });
  const s = mgr.get(view.terminalId);
  assert.ok(s.cols <= 500 && s.cols >= 20, `cols=${s.cols}`);
  assert.ok(s.rows <= 300 && s.rows >= 5, `rows=${s.rows}`);
  // host 也只收到夹取后的尺寸
  const last = spawned[0].client.resizes.at(-1);
  assert.ok(last[0] <= 500 && last[1] <= 300, JSON.stringify(last));
  mgr.stop();
});

test("attach delta 分片：大 ring 增量拆成多帧，每帧远小于 256KiB", async () => {
  const { mgr, spawned } = makeManager();
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const client = spawned[0].client;
  // 灌入 >200KB（单字符不触发 headless 折行问题，只测分片）
  const chunk = "x".repeat(50_000);
  for (let i = 0; i < 5; i++) {
    client.feed(chunk);
    await sleep(20);
  }
  const sink = makeSink("devA");
  const res = mgr.attach(sink, { terminalId: view.terminalId, generation: view.generation, haveSeq: 0, deviceId: "devA" });
  assert.equal(res.mode, "delta");
  const outs = sink.of("terminal.output");
  assert.ok(outs.length >= 2, `期望多帧，实得 ${outs.length}`);
  // 每帧 base64 data 解码后 ≤ 100KiB，且 seq 连续拼接无洞
  let expect = 0;
  for (const f of outs) {
    const raw = Buffer.from(f.params.data, "base64");
    assert.ok(raw.length <= 100 * 1024, `帧 ${raw.length} 超预算`);
    assert.equal(f.params.seq, expect);
    expect += raw.length;
  }
  assert.equal(expect, 250_000); // 全量补齐
  mgr.stop();
});

test("并发 create：不冲破 MAX_TERMINALS（占位计数生效）", async () => {
  // spawn 异步：12 个并发 create 在插入 map 前都跑到 await——若无 #pendingCreates 会全通过
  const { mgr } = makeManager();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" })),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok, 8, `成功应恰为 8，实得 ${ok}`);
  assert.ok(rejected.every((r) => /已达上限/.test(r.reason.message)));
  mgr.stop();
});

test("CREATING 期间 close：spawn 就绪即结束，不覆盖成 RUNNING", async () => {
  let resolveSpawn;
  const client = new FakeHostClient();
  const adapter = {
    spawnPtyHost() {
      return new Promise((res) => {
        resolveSpawn = () => res({ client, hello: { v: 1, cols: 80, rows: 24, seq: 0, ringStart: 0, exited: false, childPid: 9 } });
      });
    },
    reattachPtyHost() { return Promise.reject(new Error("no")); },
    listPtyHosts() { return []; },
    removePtyHostDir() {},
  };
  const { mgr } = makeManager({ adapter });
  const p = mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  await sleep(30); // 停在 CREATING（spawn 未 resolve）
  const list = mgr.list();
  assert.equal(list[0].status, "CREATING");
  const r = mgr.close(list[0].terminalId, "devA");
  assert.equal(r.ok, true); // 不抛（旧行为会 s.client.close() TypeError）
  resolveSpawn();
  const view = await p;
  assert.notEqual(view.status, "RUNNING"); // 收尾为 STOPPING，绝不 RUNNING
  assert.equal(client.closed, true); // 就绪后确实发了 close
  mgr.stop();
});

test("中段重连 ring 有缺口：翻代 + resyncRequired + 清 ring", async () => {
  const first = new FakeHostClient();
  const second = new FakeHostClient();
  let spawnCount = 0;
  const adapter = {
    spawnPtyHost() {
      spawnCount++;
      return Promise.resolve({ client: first, hello: { v: 1, cols: 80, rows: 24, seq: 0, ringStart: 0, exited: false, childPid: 5 } });
    },
    reattachPtyHost() {
      // 重连成功但返回缺口（host ring 未覆盖断线期间输出）
      return Promise.resolve({ client: second, hello: { v: 1, cols: 80, rows: 24, ringStart: 999, exited: false, childPid: 5 } });
    },
    listPtyHosts() { return []; },
    removePtyHostDir() {},
  };
  const { mgr } = makeManager({ adapter });
  const view = await mgr.create({ presetId: "shell", cwd: tmpdir(), deviceId: "devA" });
  const sink = makeSink("devA");
  mgr.attach(sink, { terminalId: view.terminalId, deviceId: "devA" });
  first.feed("some output");
  await sleep(30);
  const genBefore = mgr.get(view.terminalId).generation;
  // host 连接断开 → 触发重连
  first.emit("close");
  await sleep(600); // 等重连（300ms 退避）+ attach
  // 重连后 host 送 replayEnd 带 gap
  second.emit("replayEnd", { from: 999, gap: true, next: 999 });
  await sleep(30);
  const s = mgr.get(view.terminalId);
  assert.notEqual(s.generation, genBefore, "gap 应翻代");
  assert.equal(s.ring.length, 0, "gap 应清 daemon ring");
  assert.ok(sink.of("terminal.resyncRequired").length >= 1, "应推 resyncRequired");
  mgr.stop();
});
