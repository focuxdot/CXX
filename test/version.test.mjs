import assert from "node:assert/strict";
import test from "node:test";

import { checkUpdate, shapeUpdateResult } from "../daemon/src/menu-backend.mjs";
import { checkMinVersion, compareVersions, cxxVersion, parseVersionTriple } from "../daemon/src/version.mjs";

test("cxxVersion dev 模式读取仓库 package.json", () => {
  assert.match(cxxVersion(), /^\d+\.\d+\.\d+$/);
});

test("compareVersions 数字比较且容忍 v 前缀/段数不齐", () => {
  assert.ok(compareVersions("0.1.3", "0.1.2") > 0);
  assert.ok(compareVersions("v0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0); // 数字段，非字典序
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
});

test("parseVersionTriple 从任意版本输出提取三元组", () => {
  assert.deepEqual(parseVersionTriple("codex-cli 0.142.5"), { major: 0, minor: 142, patch: 5 });
  assert.deepEqual(parseVersionTriple("2.1.201 (Claude Code)"), { major: 2, minor: 1, patch: 201 });
  assert.equal(parseVersionTriple("nonsense"), null);
  assert.equal(parseVersionTriple(null), null);
});

test("checkMinVersion 只有明确低于下限才拦,读不到/解析不出放行", () => {
  assert.deepEqual(checkMinVersion("codex-cli 0.142.5", "0.142.0"), {
    raw: "codex-cli 0.142.5",
    parsed: { major: 0, minor: 142, patch: 5 },
    ok: true,
    belowMin: false,
  });
  assert.equal(checkMinVersion("1.9.0", "2.0.0").belowMin, true);
  assert.equal(checkMinVersion("1.9.0", "2.0.0").ok, false);
  // 版本串格式变化/读不到:绝不能把新版 CLI 拦在启动之外
  assert.equal(checkMinVersion("future-format", "2.0.0").ok, true);
  assert.equal(checkMinVersion(null, "2.0.0").ok, true);
});

test("shapeUpdateResult 得出是否有更新与下载页", () => {
  const up = shapeUpdateResult("0.1.3", { tag_name: "v0.2.0", html_url: "https://x/rel" });
  assert.deepEqual(up, { ok: true, current: "0.1.3", latest: "0.2.0", update: true, url: "https://x/rel" });

  const same = shapeUpdateResult("0.1.3", { tag_name: "v0.1.3" });
  assert.equal(same.update, false);
  assert.match(same.url, /releases/); // html_url 缺失时兜底到发布页

  const bad = shapeUpdateResult("0.1.3", {});
  assert.ok(bad.error);
  assert.equal(bad.current, "0.1.3");
});

test("checkUpdate 网络失败返回 error + 发布页兜底", async () => {
  const res = await checkUpdate({}, {
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  assert.equal(res.error, "offline");
  assert.match(res.url, /github\.com\/focuxdot\/CXX\/releases/);
});

test("checkUpdate 正常响应走 shapeUpdateResult", async () => {
  const res = await checkUpdate({}, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ tag_name: "v99.0.0", html_url: "https://x/99" }),
    }),
  });
  assert.equal(res.update, true);
  assert.equal(res.latest, "99.0.0");
  assert.equal(res.url, "https://x/99");
});

test("checkUpdate 非 2xx 返回 HTTP 错误", async () => {
  const res = await checkUpdate({}, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.match(res.error, /403/);
});
