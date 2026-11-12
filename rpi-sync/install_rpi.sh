#!/usr/bin/env bash
# ==============================================================================
# File: /opt/gemini-brain/rpi-sync/install_rpi.sh
# Purpose: Automated installer for the Gemini Brain AST & Markdown Sync Daemon
#          on Raspberry Pi 5 running Debian 13 (Trixie).
# Usage:   sudo ./install_rpi.sh <MCP_BEARER_TOKEN>
# ==============================================================================
set -euo pipefail

INSTALL_DIR="/opt/gemini-brain/rpi-sync"
ENV_DIR="/etc/gemini-brain"
ENV_FILE="${ENV_DIR}/brain-watcher.env"
SERVICE_NAME="gemini-brain-watcher.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}"
RUN_USER="${SUDO_USER:-thomas}"
RUN_HOME=$(getent passwd "${RUN_USER}" | cut -d: -f6)

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Please run as root: sudo ./install_rpi.sh <MCP_BEARER_TOKEN>" >&2
  exit 1
fi

TOKEN="${1:-${MCP_BEARER_TOKEN:-}}"
if [[ -z "${TOKEN}" ]]; then
  echo "[ERROR] MCP_BEARER_TOKEN is required as arg 1 or environment variable." >&2
  exit 1
fi

echo "==> [1/6] Ensuring Python 3 venv & SQLite packages on Debian 13 (Trixie)..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip sqlite3

echo "==> [2/6] Staging daemon files into ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
mkdir -p "${RUN_HOME}/.cache"
chown -R "${RUN_USER}:${RUN_USER}" "${RUN_HOME}/.cache"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]]; then
  cp -f "${SCRIPT_DIR}/brain_watcher.py" "${INSTALL_DIR}/brain_watcher.py"
  cp -f "${SCRIPT_DIR}/requirements.txt" "${INSTALL_DIR}/requirements.txt"
  cp -f "${SCRIPT_DIR}/${SERVICE_NAME}" "${INSTALL_DIR}/${SERVICE_NAME}"
fi
chmod 755 "${INSTALL_DIR}/brain_watcher.py"
chown -R "${RUN_USER}:${RUN_USER}" "/opt/gemini-brain"

echo "==> [3/6] Creating isolated Python virtual environment & installing dependencies..."
sudo -u "${RUN_USER}" python3 -m venv "${INSTALL_DIR}/.venv"
sudo -u "${RUN_USER}" "${INSTALL_DIR}/.venv/bin/pip" install --upgrade --quiet pip
sudo -u "${RUN_USER}" "${INSTALL_DIR}/.venv/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

echo "==> [4/6] Writing hardened secret environment file to ${ENV_FILE}..."
mkdir -p "${ENV_DIR}"
cat > "${ENV_FILE}" <<EOF
BRAIN_MCP_URL=https://brain.tsimon.me/mcp
MCP_BEARER_TOKEN=${TOKEN}
BRAIN_NAMESPACE=homelab
WATCH_DIRS=/opt/edge-rag-hub,${RUN_HOME}/obsidian-vault
BRAIN_STATE_DB=${RUN_HOME}/.cache/gemini-brain-sync.db
EOF
chmod 600 "${ENV_FILE}"
chown "${RUN_USER}:${RUN_USER}" "${ENV_FILE}"

echo "==> [5/6] Installing and enabling systemd unit ${SERVICE_NAME}..."
cp -f "${INSTALL_DIR}/${SERVICE_NAME}" "${SERVICE_DEST}"
chmod 644 "${SERVICE_DEST}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "==> [6/6] Verifying ${SERVICE_NAME} service status..."
systemctl --no-pager --full status "${SERVICE_NAME}" || true
echo "[OK] Gemini Brain RPi5 AST & Markdown Sync Daemon installed and running."
