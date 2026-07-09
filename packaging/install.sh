#!/usr/bin/env bash
set -euo pipefail

DEFAULT_BASE_URL="https://github.com/focuxdot/CXX/releases/latest/download"
BASE_URL="${CXX_BASE_URL:-${DEFAULT_BASE_URL}}"
BASE_URL="${BASE_URL%/}"
PACKAGE_REVISION="${CXX_PACKAGE_REVISION:-latest}"
TMPDIR_CXX=""
CHECKSUMS_FILE=""

cleanup() {
  if [ -n "${TMPDIR_CXX}" ]; then
    rm -rf "${TMPDIR_CXX}"
  fi
}

trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'cxx installer: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

download() {
  local url="$1"
  local output="$2"
  log "Downloading ${url}"
  curl -fL --retry 3 --connect-timeout 10 --max-time 300 "$url" -o "$output"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "missing shasum or sha256sum for artifact verification"
  fi
}

download_checksums() {
  if [ -n "${CHECKSUMS_FILE}" ]; then
    return 0
  fi
  CHECKSUMS_FILE="${TMPDIR_CXX}/checksums.txt"
  download "${BASE_URL}/checksums.txt?v=${PACKAGE_REVISION}" "${CHECKSUMS_FILE}"
}

verify_artifact() {
  local path="$1"
  local name expected actual
  name="$(basename "$path")"
  download_checksums
  expected="$(awk -v n="${name}" '$2 == n { print $1 }' "${CHECKSUMS_FILE}" | head -n 1)"
  [ -n "${expected}" ] || fail "checksums.txt does not contain ${name}"
  actual="$(sha256_file "$path")"
  [ "${actual}" = "${expected}" ] || fail "checksum mismatch for ${name}"
  log "Verified ${name}"
}

# 全局 CLI：把 App 内的 daemon 二进制软链成 PATH 上的 `cxx`，让用户在任意终端
# 直接敲 `cxx pair` / `cxx notify` / `cxx status` 等（与菜单栏 GUI 共用同一二进制、
# 同一份 config）。best-effort：找不到可写的 PATH 目录也不影响 App 安装本身。
link_cli() {
  local target="/Applications/CXX.app/Contents/Resources/cxx-daemon"
  [ -x "${target}" ] || return 0
  # 优先选已在 PATH 上、当前用户可写的目录；都不行则退到 ~/.local/bin 并提示改 PATH。
  local dir=""
  local candidate
  for candidate in /usr/local/bin /opt/homebrew/bin "${HOME}/.local/bin"; do
    if [ -d "${candidate}" ] && [ -w "${candidate}" ]; then
      dir="${candidate}"
      break
    fi
  done
  if [ -z "${dir}" ]; then
    dir="${HOME}/.local/bin"
    mkdir -p "${dir}" 2>/dev/null || {
      log "warning: 无法创建 ${dir}，跳过全局 cxx 命令（可手动: sudo ln -sf \"${target}\" /usr/local/bin/cxx）"
      return 0
    }
  fi
  if ln -sf "${target}" "${dir}/cxx" 2>/dev/null; then
    log "已安装全局命令: ${dir}/cxx"
    case ":${PATH}:" in
      *":${dir}:"*) : ;;
      *) log "提示: ${dir} 不在 PATH 中，加入后即可使用 cxx（如 echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.zshrc）" ;;
    esac
  else
    log "warning: 无法写入 ${dir}/cxx（可手动: sudo ln -sf \"${target}\" /usr/local/bin/cxx）"
  fi
}

install_macos() {
  need_cmd curl
  need_cmd hdiutil
  need_cmd ditto
  TMPDIR_CXX="$(mktemp -d)"

  local dmg mount app
  dmg="${TMPDIR_CXX}/CXX-macos.dmg"
  mount="${TMPDIR_CXX}/mnt"
  mkdir -p "${mount}"

  download "${BASE_URL}/CXX-macos.dmg?v=${PACKAGE_REVISION}" "${dmg}"
  verify_artifact "${dmg}"

  log "Mounting CXX installer image"
  hdiutil attach "${dmg}" -readonly -nobrowse -mountpoint "${mount}" >/dev/null
  trap 'hdiutil detach "${mount}" >/dev/null 2>&1 || true; cleanup' EXIT

  app="${mount}/CXX.app"
  [ -d "${app}" ] || fail "downloaded DMG does not contain CXX.app"

  log "Installing CXX.app to /Applications"
  # 覆盖前先退掉旧托盘：单实例锁（menu.lock）会让稍后的 open 变成空操作，
  # 不退的话用户手里还是旧托盘、看不到新菜单。
  osascript -e 'quit app "CXX"' >/dev/null 2>&1 || true
  pkill -f cxx-menubar >/dev/null 2>&1 || true
  rm -rf "/Applications/CXX.app"
  ditto "${app}" "/Applications/CXX.app"
  hdiutil detach "${mount}" >/dev/null
  trap cleanup EXIT

  # 安装/更新全局 `cxx` 命令（软链到 PATH 上的固定名，指向新装 App 内的二进制）
  link_cli

  # 远程之前已开启（LaunchAgent plist 在）：必须用新二进制重启后台服务，否则
  # 旧 daemon 会抱着已删除的旧二进制继续跑，更新等于没装。enable 自带
  # bootout → bootstrap，并按新安装路径重写 plist。
  if [ -f "${HOME}/Library/LaunchAgents/ai.wokey.cxx.remote.plist" ]; then
    log "Restarting CXX remote daemon"
    "/Applications/CXX.app/Contents/Resources/cxx-daemon" enable >/dev/null 2>&1 \
      || log "warning: daemon restart failed — toggle remote off/on from the menu-bar icon"
  fi

  log "Opening CXX"
  open "/Applications/CXX.app" || true
  log "CXX installed. Use the menu-bar icon to pair your phone."
}

# Linux: CLI-only SEA binary (no tray/GUI). Installs as `cxx` on PATH.
linux_asset_name() {
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) printf 'cxx-linux-x64' ;;
    aarch64|arm64) printf 'cxx-linux-arm64' ;;
    *) fail "unsupported Linux architecture: ${arch} (need x86_64 or aarch64)" ;;
  esac
}

# Place binary at a writable PATH dir as `cxx` (same CLI name as macOS/Windows).
install_linux_binary() {
  local src="$1"
  local dir="" candidate
  for candidate in "${HOME}/.local/bin" /usr/local/bin; do
    if [ -d "${candidate}" ] && [ -w "${candidate}" ]; then
      dir="${candidate}"
      break
    fi
  done
  if [ -z "${dir}" ]; then
    dir="${HOME}/.local/bin"
    mkdir -p "${dir}" 2>/dev/null || fail "cannot create ${dir}"
  fi
  # Atomic replace: never `cp` onto a running executable (Linux ETXTBSY when the
  # systemd unit still has ~/.local/bin/cxx mapped). Write a sibling then mv -f
  # so the old inode stays valid for the running process until restart.
  local dest="${dir}/cxx"
  local tmp="${dir}/.cxx.new.$$"
  cp "${src}" "${tmp}"
  chmod +x "${tmp}"
  mv -f "${tmp}" "${dest}"
  log "Installed CLI: ${dest}"
  case ":${PATH}:" in
    *":${dir}:"*) : ;;
    *) log "Note: ${dir} is not on PATH — add it, e.g. echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.bashrc" ;;
  esac
  printf '%s\n' "${dest}"
}

install_linux() {
  need_cmd curl
  TMPDIR_CXX="$(mktemp -d)"

  local asset bin_path installed
  asset="$(linux_asset_name)"
  bin_path="${TMPDIR_CXX}/${asset}"

  download "${BASE_URL}/${asset}?v=${PACKAGE_REVISION}" "${bin_path}"
  verify_artifact "${bin_path}"
  chmod +x "${bin_path}"

  installed="$(install_linux_binary "${bin_path}")"

  # If the systemd user unit was already enabled, rewrite + restart onto the new binary.
  if [ -f "${HOME}/.config/systemd/user/cxx-remote.service" ]; then
    log "Restarting CXX remote daemon"
    "${installed}" enable >/dev/null 2>&1 \
      || log "warning: daemon restart failed — run: ${installed} enable"
  fi

  log "CXX (Linux CLI) installed."
  log "Next:"
  log "  1. ${installed} enable          # systemd --user unit + start"
  log "  2. ${installed} pair            # print permanent device URL (JSON)"
  log "  3. Open the URL on your phone"
  log "If you use SSH and want the daemon to survive logout:"
  log "  loginctl enable-linger \"${USER:-$LOGNAME}\""
}

main() {
  case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) fail "this installer supports macOS and Linux. Windows: irm https://github.com/focuxdot/CXX/releases/latest/download/install.ps1 | iex" ;;
  esac
}

main "$@"
