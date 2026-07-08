import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { _clearFileSearchCache, listClaudeCommands, searchFiles } from "../daemon/src/file-search.mjs";

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "cxx-fs-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "src", "relay-link.mjs"), "");
  writeFileSync(path.join(root, "src", "main.mjs"), "");
  writeFileSync(path.join(root, "README.md"), "");
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
  writeFileSync(path.join(root, ".git", "HEAD"), "");
  return root;
}

test("searchFiles 模糊匹配并跳过依赖/隐藏目录", async (t) => {
  const root = makeTree();
  t.after(() => { rmSync(root, { recursive: true, force: true }); _clearFileSearchCache(); });

  const hits = await searchFiles(root, "relay");
  assert.equal(hits[0].path, "src/relay-link.mjs");

  const all = (await searchFiles(root, "", 50)).map((f) => f.path);
  assert.ok(all.includes("README.md"));
  assert.ok(all.includes("src/"));
  assert.ok(!all.some((p) => p.includes("node_modules")));
  assert.ok(!all.some((p) => p.startsWith(".git")));

  // 子序列匹配：稀疏字符也能命中
  const sparse = await searchFiles(root, "rlm");
  assert.ok(sparse.some((f) => f.path === "src/relay-link.mjs"));
});

test("listClaudeCommands 解析项目命令与 frontmatter", async (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".claude", "commands", "ops");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(root, ".claude", "commands", "deploy.md"),
    "---\ndescription: 部署到生产\nargument-hint: [env]\n---\n\n执行部署",
  );
  writeFileSync(path.join(dir, "restart.md"), "无 frontmatter 正文");

  const project = (await listClaudeCommands(root)).filter((c) => c.scope === "project");
  const names = project.map((c) => c.name).sort();
  assert.deepEqual(names, ["deploy", "ops:restart"]);
  const deploy = project.find((c) => c.name === "deploy");
  assert.equal(deploy.description, "部署到生产");
  assert.equal(deploy.hint, "[env]");
});
