#!/usr/bin/env bash
# SPDX-FileCopyrightText: MartinLoop contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPOSITORY="Keesan12/martin-loop"
INSTALL_DIR="${MARTIN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${MARTIN_VERSION:-latest}"

fail() { printf '%s\n' "martin-loop install failed: $*" >&2; exit 1; }
say() { if [ "${MARTIN_QUIET:-0}" != "1" ]; then printf '%s\n' "$*"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

need curl
need uname
need mktemp

case "$(uname -s)" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *) fail "unsupported operating system; use install.ps1 on Windows" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCHITECTURE="x64" ;;
  arm64|aarch64) ARCHITECTURE="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required"
fi

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: martin-loop-installer" \
    "https://api.github.com/repos/${REPOSITORY}/releases/latest" |
    sed -n 's/.*"tag_name":[[:space:]]*"v\([^"]*\)".*/\1/p' |
    head -n 1)" || fail "could not resolve the latest release"
fi
case "$VERSION" in
  ''|*[!0-9A-Za-z.+-]*) fail "invalid release version: $VERSION" ;;
esac

TARGET="${PLATFORM}-${ARCHITECTURE}"
ASSET="martin-loop-${TARGET}"
BASE_URL="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
TEMP_DIR="$(mktemp -d)"
DOWNLOAD="${TEMP_DIR}/${ASSET}"
CHECKSUM="${DOWNLOAD}.sha256"
STAGED=""
BACKUP=""

cleanup() {
  rm -rf "$TEMP_DIR"
  [ -z "$STAGED" ] || rm -f "$STAGED"
}
trap cleanup EXIT

say "Downloading ${ASSET}..."
curl -fL --retry 2 --connect-timeout 15 -o "$DOWNLOAD" "${BASE_URL}/${ASSET}" ||
  fail "download failed for ${ASSET}"
curl -fL --retry 2 --connect-timeout 15 -o "$CHECKSUM" "${BASE_URL}/${ASSET}.sha256" ||
  fail "checksum asset is missing for ${ASSET}"

EXPECTED="$(awk -v name="$ASSET" '$2 == name || $2 == "*" name { print tolower($1) }' "$CHECKSUM")"
[ -n "$EXPECTED" ] || fail "checksum file does not name ${ASSET}"
ACTUAL="$(hash_file "$DOWNLOAD")"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for ${ASSET}"
[ "$(wc -c < "$DOWNLOAD")" -ge 1024 ] || fail "downloaded asset is too small"
chmod 755 "$DOWNLOAD"
"$DOWNLOAD" --version >/dev/null 2>&1 || fail "downloaded executable failed verification"

mkdir -p "$INSTALL_DIR"
STAGED="$(mktemp "${INSTALL_DIR}/.martin-loop.XXXXXX")"
cp "$DOWNLOAD" "$STAGED"
chmod 755 "$STAGED"
INSTALL_PATH="${INSTALL_DIR}/martin-loop"
ALIAS_PATH="${INSTALL_DIR}/martin"

if [ -e "$INSTALL_PATH" ]; then
  BACKUP="${INSTALL_DIR}/.martin-loop.$(date +%s).backup"
  mv "$INSTALL_PATH" "$BACKUP"
fi
if ! mv "$STAGED" "$INSTALL_PATH"; then
  [ -z "$BACKUP" ] || mv "$BACKUP" "$INSTALL_PATH"
  fail "atomic replacement failed"
fi
STAGED=""

if ! "$INSTALL_PATH" --version >/dev/null 2>&1; then
  rm -f "$INSTALL_PATH"
  [ -z "$BACKUP" ] || mv "$BACKUP" "$INSTALL_PATH"
  fail "installed executable failed verification; previous install restored"
fi

ALIAS_STAGE="${INSTALL_DIR}/.martin.alias.$$"
rm -f "$ALIAS_STAGE"
ln -s "$INSTALL_PATH" "$ALIAS_STAGE"
mv -f "$ALIAS_STAGE" "$ALIAS_PATH"

say "Installed martin-loop ${VERSION} to ${INSTALL_PATH}"
