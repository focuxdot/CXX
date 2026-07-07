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
  rm -rf "/Applications/CXX.app"
  ditto "${app}" "/Applications/CXX.app"
  hdiutil detach "${mount}" >/dev/null
  trap cleanup EXIT

  log "Opening CXX"
  open "/Applications/CXX.app" || true
  log "CXX installed. Use the menu-bar icon to pair your phone."
}

main() {
  case "$(uname -s)" in
    Darwin) install_macos ;;
    *) fail "this installer currently supports macOS only. Download release assets manually from https://github.com/focuxdot/CXX/releases/latest" ;;
  esac
}

main "$@"
