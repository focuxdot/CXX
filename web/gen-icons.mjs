#!/usr/bin/env node
// Generate PWA/desktop icon assets from the canonical SVG logo in web/icons/.
// The SVG is kept as the source of truth; PNGs are rasterized for manifest,
// apple-touch-icon, README, and favicon usage.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "icons");
const SVG_NAME = "logo.svg";
const SVG_PATH = join(OUT, SVG_NAME);

const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">C叉叉 logo</title>
  <desc id="desc">微信绿背景，白色 C叉叉 和下划线。</desc>
  <rect width="512" height="512" fill="#07C160"/>
  <path d="M215 174c-21-21-57-28-90-13-43 20-62 71-42 114 20 43 71 62 114 42 12-6 23-14 32-24" transform="translate(-4 0)" fill="none" stroke="#FFFFFF" stroke-width="42" stroke-linecap="round"/>
  <text x="319" y="266" text-anchor="middle" dominant-baseline="middle" font-family="PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="108" font-weight="900" fill="#FFFFFF">叉叉</text>
  <path d="M323 349H394" stroke="#FFFFFF" stroke-width="21" stroke-linecap="round"/>
</svg>
`;

const ICONS = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", ...opts });
}

function findChrome() {
  const env = process.env.CHROME_BIN;
  const candidates = [
    env,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function rasterizeWithSips(size, outPath) {
  run("sips", ["-s", "format", "png", "-z", String(size), String(size), SVG_PATH, "--out", outPath]);
}

function rasterizeWithChrome(size, outPath) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("No rasterizer found. Install macOS sips or set CHROME_BIN to Chrome/Chromium.");
  }
  const dir = mkdtempSync(join(tmpdir(), "cxx-icon-render-"));
  const html = join(dir, "render.html");
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${pathToFileURL(SVG_PATH)}">`,
  );
  try {
    run(chrome, [
      "--headless=new",
      "--disable-gpu",
      `--screenshot=${outPath}`,
      `--window-size=${size},${size}`,
      pathToFileURL(html).href,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rasterize(size, outPath) {
  if (process.platform === "darwin") {
    try {
      rasterizeWithSips(size, outPath);
      return;
    } catch (error) {
      console.warn(`sips failed for ${size}x${size}, falling back to Chrome: ${error.message}`);
    }
  }
  rasterizeWithChrome(size, outPath);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(SVG_PATH, LOGO_SVG);
console.log(`生成 icons/${SVG_NAME}`);

for (const icon of ICONS) {
  rasterize(icon.size, join(OUT, icon.name));
  console.log(`生成 icons/${icon.name} (${icon.size}x${icon.size})`);
}
