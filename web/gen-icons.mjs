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
const MENUBAR_SVG_NAME = "menubar.svg";
const MENUBAR_SVG_PATH = join(OUT, MENUBAR_SVG_NAME);
const ICNS_NAME = "AppIcon.icns";

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

const MENUBAR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="54 132 372 246" role="img" aria-labelledby="title desc">
  <title id="title">C叉叉 menu bar logo</title>
  <desc id="desc">透明背景，绿色 C叉叉 和下划线。</desc>
  <path d="M215 174c-21-21-57-28-90-13-43 20-62 71-42 114 20 43 71 62 114 42 12-6 23-14 32-24" transform="translate(-4 0)" fill="none" stroke="#07C160" stroke-width="42" stroke-linecap="round"/>
  <text x="319" y="266" text-anchor="middle" dominant-baseline="middle" font-family="PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="108" font-weight="900" fill="#07C160">叉叉</text>
  <path d="M323 349H394" stroke="#07C160" stroke-width="21" stroke-linecap="round"/>
</svg>
`;

const ICONS = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" },
];

const APP_ICONSET = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
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

function rasterizeWithSips(svgPath, width, height, outPath) {
  run("sips", ["-s", "format", "png", "-z", String(height), String(width), svgPath, "--out", outPath]);
}

function rasterizeWithChrome(svgPath, width, height, outPath) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("No rasterizer found. Install macOS sips or set CHROME_BIN to Chrome/Chromium.");
  }
  const dir = mkdtempSync(join(tmpdir(), "cxx-icon-render-"));
  const html = join(dir, "render.html");
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}img{display:block;width:${width}px;height:${height}px}</style><img src="${pathToFileURL(svgPath)}">`,
  );
  try {
    run(chrome, [
      "--headless=new",
      "--disable-gpu",
      `--screenshot=${outPath}`,
      `--window-size=${width},${height}`,
      pathToFileURL(html).href,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rasterize(svgPath, width, height, outPath) {
  if (process.platform === "darwin") {
    try {
      rasterizeWithSips(svgPath, width, height, outPath);
      return;
    } catch (error) {
      console.warn(`sips failed for ${width}x${height}, falling back to Chrome: ${error.message}`);
    }
  }
  rasterizeWithChrome(svgPath, width, height, outPath);
}

function generateIcns() {
  if (process.platform !== "darwin") {
    console.warn(`跳过 icons/${ICNS_NAME}: iconutil is macOS-only`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cxx-app-icon-"));
  const iconset = join(dir, "AppIcon.iconset");
  mkdirSync(iconset, { recursive: true });
  try {
    for (const icon of APP_ICONSET) {
      rasterize(SVG_PATH, icon.size, icon.size, join(iconset, icon.name));
    }
    run("iconutil", ["-c", "icns", iconset, "-o", join(OUT, ICNS_NAME)]);
    console.log(`生成 icons/${ICNS_NAME}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(SVG_PATH, LOGO_SVG);
console.log(`生成 icons/${SVG_NAME}`);
writeFileSync(MENUBAR_SVG_PATH, MENUBAR_SVG);
console.log(`生成 icons/${MENUBAR_SVG_NAME}`);

for (const icon of ICONS) {
  rasterize(SVG_PATH, icon.size, icon.size, join(OUT, icon.name));
  console.log(`生成 icons/${icon.name} (${icon.size}x${icon.size})`);
}

rasterize(MENUBAR_SVG_PATH, 96, 64, join(OUT, "menubar.png"));
console.log("生成 icons/menubar.png (96x64)");

generateIcns();
