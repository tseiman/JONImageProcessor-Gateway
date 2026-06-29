#!/usr/bin/env bash
set -Eeuo pipefail

PREFIX="${PREFIX:-/opt/JONImageProcessor-Gateway}"
SERVICE_NAME="${SERVICE_NAME:-jonimageprocessor-gateway.service}"
RUN_GIT_PULL="${RUN_GIT_PULL:-1}"
INSTALL_CONFIG="${INSTALL_CONFIG:-merge}"
SUDO="${SUDO:-sudo}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

step() {
  printf '\n==> %s\n' "$*"
}

info() {
  printf '    %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

trap 'die "failed at line $LINENO while running: $BASH_COMMAND"' ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

service_exists() {
  systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1
}

step "Checking tools"
require_command npm
require_command node
require_command systemctl
require_command "$SUDO"

if [[ "$RUN_GIT_PULL" == "1" && -d .git ]]; then
  step "Updating checkout"
  git pull --ff-only
else
  step "Skipping git pull"
  info "RUN_GIT_PULL=$RUN_GIT_PULL or no .git directory"
fi

step "Installing npm runtime dependencies"
npm install --omit=dev

step "Writing build version"
npm run version:write

if service_exists; then
  step "Stopping $SERVICE_NAME"
  "$SUDO" systemctl stop "$SERVICE_NAME"
else
  step "Service not installed yet"
  info "$SERVICE_NAME was not found; skipping stop"
fi

step "Creating deployment directories under $PREFIX"
"$SUDO" install -d -m 755 "$PREFIX"
"$SUDO" install -d -m 755 "$PREFIX/bin"
"$SUDO" install -d -m 755 "$PREFIX/src"
"$SUDO" install -d -m 755 "$PREFIX/public"
"$SUDO" install -d -m 700 "$PREFIX/etc"

step "Copying application files"
"$SUDO" cp -a bin/. "$PREFIX/bin/"
"$SUDO" cp -a src/. "$PREFIX/src/"
"$SUDO" cp -a public/. "$PREFIX/public/"
"$SUDO" cp -a node_modules package.json package-lock.json "$PREFIX/"

CONFIG_TARGET="$PREFIX/etc/gateway.config.json"
if [[ "$INSTALL_CONFIG" == "always" || ( "$INSTALL_CONFIG" == "missing" && ! -f "$CONFIG_TARGET" ) || ( "$INSTALL_CONFIG" == "merge" && ! -f "$CONFIG_TARGET" ) ]]; then
  step "Installing example config"
  "$SUDO" cp config/gateway.config.example.json "$CONFIG_TARGET"
elif [[ "$INSTALL_CONFIG" == "merge" ]]; then
  step "Merging missing config defaults"
  TMP_CONFIG="$(mktemp)"
  CONFIG_BACKUP="$CONFIG_TARGET.$(date -u +%Y%m%dT%H%M%SZ).bak"
  "$SUDO" cp "$CONFIG_TARGET" "$CONFIG_BACKUP"
  "$SUDO" cp "$CONFIG_TARGET" "$TMP_CONFIG"
  "$SUDO" chown "$(id -u):$(id -g)" "$TMP_CONFIG"
  MERGE_CONFIG_BACKUP=0 node scripts/merge-gateway-config.js "$TMP_CONFIG" config/gateway.config.example.json
  "$SUDO" cp "$TMP_CONFIG" "$CONFIG_TARGET"
  rm -f "$TMP_CONFIG"
  info "Backup written to $CONFIG_BACKUP"
else
  step "Keeping existing config"
  info "$CONFIG_TARGET"
fi

if service_exists; then
  step "Starting $SERVICE_NAME"
  "$SUDO" systemctl start "$SERVICE_NAME"
  "$SUDO" systemctl --no-pager --full status "$SERVICE_NAME" || true
else
  step "Service not started"
  info "Install packaging/systemd/jonimageprocessor-gateway.service first, then run:"
  info "sudo systemctl daemon-reload"
  info "sudo systemctl enable --now $SERVICE_NAME"
fi

step "Done"
info "Installed gateway from $ROOT_DIR to $PREFIX"
