#!/usr/bin/env node
// Assemble CXX.app: the macOS menu-bar shell with the daemon binary embedded.
//
// Layout:
//   CXX.app/Contents/
//     Info.plist                 (LSUIElement — menu-bar only, no dock icon)
//     MacOS/cxx-menubar          (Swift shell, compiled with swiftc)
//     Resources/cxx-daemon       (Node SEA daemon, spawned by the shell)
//
// Signing: nested daemon signed first, then the app (deep). Ad-hoc by default; set
// CODESIGN_IDENTITY="Developer ID Application: …" for a distributable, notarizable build.
// Pass --dmg to also produce a DMG.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const appDir = join(distDir, "CXX.app");
const contents = join(appDir, "Contents");
const macosDir = join(contents, "MacOS");
const resourcesDir = join(contents, "Resources");
const daemonBin = join(distDir, "sea", "cxx-daemon");
const shellSrc = join(root, "shell", "macos", "Sources", "CXXMenuBar");
const shellBin = join(macosDir, "cxx-menubar");

const VERSION = "0.1.0";
const BUNDLE_ID = "ai.wokey.cxx";
const identity = process.env.CODESIGN_IDENTITY || "-";
const makeDmg = process.argv.includes("--dmg");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

if (process.platform !== "darwin") {
  console.error("build-app.mjs targets macOS only.");
  process.exit(1);
}

// 1. daemon binary must exist (build it first if missing)
if (!existsSync(daemonBin)) {
  console.log("→ daemon binary missing, building SEA ...");
  run(process.execPath, [join(root, "scripts", "build-sea.mjs")]);
}

// 2. fresh bundle skeleton
rmSync(appDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

// 3. compile the Swift shell directly with swiftc.
// (SwiftPM's ManifestAPI is broken under standalone Command Line Tools; swiftc works.)
console.log("→ compiling Swift menu-bar shell ...");
run("swiftc", [
  "-O",
  join(shellSrc, "Backend.swift"),
  join(shellSrc, "PairingWindow.swift"),
  join(shellSrc, "DevicesWindow.swift"),
  join(shellSrc, "NotifyWindow.swift"),
  join(shellSrc, "AppDelegate.swift"),
  join(shellSrc, "main.swift"),
  "-o",
  shellBin,
  "-framework",
  "AppKit",
  "-framework",
  "CoreImage",
  "-framework",
  "ServiceManagement",
  "-target",
  "arm64-apple-macosx13.0",
]);
chmodSync(shellBin, 0o755);

// 4. embed the daemon
copyFileSync(daemonBin, join(resourcesDir, "cxx-daemon"));
chmodSync(join(resourcesDir, "cxx-daemon"), 0o755);

// 5. Info.plist
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>CXX</string>
  <key>CFBundleDisplayName</key><string>C叉叉</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>cxx-menubar</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
`;
writeFileSync(join(contents, "Info.plist"), plist);

// 6. sign nested-first, then the app deep
console.log(`→ codesign (identity: ${identity}) ...`);
run("codesign", ["--force", "--sign", identity, "--timestamp=none", join(resourcesDir, "cxx-daemon")]);
run("codesign", ["--force", "--deep", "--sign", identity, "--timestamp=none", appDir]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appDir]);

console.log(`\n✓ built ${appDir}`);

// 7. optional DMG
if (makeDmg) {
  const dmg = join(distDir, `CXX-${VERSION}.dmg`);
  rmSync(dmg, { force: true });
  console.log("→ creating DMG ...");
  run("hdiutil", [
    "create",
    "-volname",
    "CXX",
    "-srcfolder",
    appDir,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
  console.log(`✓ built ${dmg}`);
}

if (identity === "-") {
  console.log(
    "\nℹ ad-hoc signed (identity '-'). For distribution, set CODESIGN_IDENTITY to a\n" +
      "  'Developer ID Application' cert and notarize with `xcrun notarytool submit`.",
  );
}
