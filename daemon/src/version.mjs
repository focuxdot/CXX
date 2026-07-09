// CXX 自身版本（供托盘「检查更新」比对）。
//
// SEA 打包没有随行的 package.json，版本在 build-sea.mjs 里用 esbuild --define 把
// __CXX_VERSION__ 烧进 bundle；dev 直跑源码时该标识符不存在，回退读仓库根 package.json。
import { readFileSync } from "node:fs";

export function cxxVersion() {
  // eslint 风格提示：typeof 守卫让未定义标识符不抛 ReferenceError；打包后被 define 常量替换
  if (typeof __CXX_VERSION__ !== "undefined") return __CXX_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // 源码布局被移动或 package.json 缺失——版本未知
  }
  return "0.0.0";
}

// 从任意版本输出里解析 semver 三元组（如 "codex-cli 0.142.5"、"2.1.201 (Claude Code)"）。
// 返回 { major, minor, patch } 或 null。
export function parseVersionTriple(text) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// 最低版本评估（claude/codex 门槛共用）。策略：只有解析成功且明确低于 min 才 belowMin；
// 读不到/解析不出一律 ok——版本串格式变化绝不能把全新的 CLI 拦在启动之外。
// 返回 { raw, parsed, ok, belowMin }。
export function checkMinVersion(raw, min) {
  const parsed = raw ? parseVersionTriple(raw) : null;
  const belowMin = parsed
    ? compareVersions(`${parsed.major}.${parsed.minor}.${parsed.patch}`, min) < 0
    : false;
  return { raw, parsed, ok: !belowMin, belowMin };
}

// 比较两个 "x.y.z" 形式的版本号（容忍 v 前缀与段数不齐）。返回 <0 / 0 / >0。
// 非数字段（如 -beta.1）按数字前缀参与比较，够用即可——发布 tag 一律是纯三段。
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((seg) => Number.parseInt(seg, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
