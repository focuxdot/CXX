// files.search / commands.list 的本地实现：手机端 @ 文件补全与斜杠命令面板的数据源。
// 只做有界扫描：跳过依赖/构建产物目录，条数与深度都有硬上限，结果短暂缓存以吸收连续按键。
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", ".venv", "Pods", "DerivedData",
]);
const MAX_FILES = 20_000; // 收集上限：超大仓只索引前 2 万个（BFS 序，浅层优先，够补全用）
const MAX_DEPTH = 10;
const CACHE_TTL_MS = 30_000;

const listCache = new Map(); // 规范化 cwd -> { at, entries: [{rel, base, dir}] }

async function collectEntries(root) {
  const norm = path.resolve(root);
  const hit = listCache.get(norm);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
  const entries = [];
  const queue = [{ abs: norm, rel: "", depth: 0 }];
  while (queue.length && entries.length < MAX_FILES) {
    const { abs, rel, depth } = queue.shift();
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // 无权限/已删除的目录直接跳过
    }
    for (const d of dirents) {
      if (entries.length >= MAX_FILES) break;
      const name = d.name;
      // 隐藏项一律不进索引（.git/.env 等；.claude 命令另有 commands.list 通道）
      if (name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        entries.push({ rel: childRel, base: name, dir: true });
        if (depth + 1 < MAX_DEPTH) queue.push({ abs: path.join(abs, name), rel: childRel, depth: depth + 1 });
      } else if (d.isFile()) {
        entries.push({ rel: childRel, base: name, dir: false });
      }
    }
  }
  // 缓存也做个总量兜底：同时缓存太多项目时最老的先扔
  if (listCache.size > 8) listCache.delete(listCache.keys().next().value);
  listCache.set(norm, { at: Date.now(), entries });
  return entries;
}

// 子序列匹配打分：文件名前缀 > 文件名包含 > 路径包含 > 稀疏子序列；短路径优先。
// 返回 null 表示不匹配。
function scoreEntry(entry, q) {
  if (!q) return 100 - Math.min(99, entry.rel.length / 4); // 空查询：浅而短的排前
  const base = entry.base.toLowerCase();
  const rel = entry.rel.toLowerCase();
  if (base.startsWith(q)) return 1000 - entry.rel.length;
  if (base.includes(q)) return 800 - entry.rel.length;
  const idx = rel.indexOf(q);
  if (idx >= 0) return 600 - idx - entry.rel.length / 8;
  // 稀疏子序列（如 "wgl" 命中 wrangler.toml）：间隙越大分越低
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    i = rel.indexOf(ch, i);
    if (i < 0) return null;
    if (last >= 0) gaps += i - last - 1;
    last = i;
    i += 1;
  }
  return 300 - gaps - entry.rel.length / 8;
}

// @ 补全：在 cwd 内模糊找文件/目录，返回相对路径（目录带尾斜杠）。
export async function searchFiles(cwd, query, limit = 20) {
  const entries = await collectEntries(cwd);
  const q = String(query || "").trim().toLowerCase();
  const scored = [];
  for (const e of entries) {
    const s = scoreEntry(e, q);
    if (s !== null) scored.push([s, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, e]) => ({
    path: e.dir ? `${e.rel}/` : e.rel,
    dir: e.dir,
  }));
}

// 解析命令 md 的 frontmatter：只取 description / argument-hint 两个展示字段
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { description: "", hint: "" };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(description|argument-hint):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1] === "description" ? "description" : "hint"] = kv[2].trim().slice(0, 120);
  }
  return out;
}

async function scanCommandDir(dir, scope, prefix, depth, out) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (out.length >= 200) return;
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory()) {
      // 子目录即命名空间（/ns:name），与 Claude Code 的组织方式一致
      if (depth < 2) await scanCommandDir(path.join(dir, d.name), scope, `${prefix}${d.name}:`, depth + 1, out);
    } else if (d.isFile() && d.name.endsWith(".md")) {
      const name = `${prefix}${d.name.slice(0, -3)}`;
      let fm = { description: "", hint: "" };
      try {
        fm = parseFrontmatter(await fs.readFile(path.join(dir, d.name), "utf8"));
      } catch {}
      out.push({ name, description: fm.description, hint: fm.hint, scope });
    }
  }
}

// 斜杠命令面板数据源：用户级 ~/.claude/commands + 项目级 <cwd>/.claude/commands。
// 同名时项目级在后（面板按序展示，客户端可自行去重）。
export async function listClaudeCommands(cwd) {
  const out = [];
  await scanCommandDir(path.join(homedir(), ".claude", "commands"), "user", "", 0, out);
  if (cwd) await scanCommandDir(path.join(cwd, ".claude", "commands"), "project", "", 0, out);
  return out;
}

// 测试钩子：清缓存，避免用例间互相污染
export function _clearFileSearchCache() {
  listCache.clear();
}
