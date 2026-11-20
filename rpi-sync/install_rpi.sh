#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/opt/gemini-brain"
ENV_DIR="/etc/gemini-brain"
ENV_FILE="${ENV_DIR}/watcher.env"

echo "=== [1/4] Preparing Python 3 venv inside ${REPO_DIR}/rpi-sync ==="
sudo mkdir -p "${ENV_DIR}"
cd "${REPO_DIR}/rpi-sync"
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

if [ ! -f "${ENV_FILE}" ]; then
  echo "=== [2/4] Creating ${ENV_FILE} template ==="
  sudo tee "${ENV_FILE}" > /dev/null << 'EOF'
RPI_SYNC_ENABLED=true
BRAIN_MCP_URL=https://brain.tsimon.me/mcp
MCP_BEARER_TOKEN=REPLACE_WITH_MCP_BEARER_TOKEN
WATCH_DIRS=/opt/edge-rag-hub,/opt/gemini-brain
BRAIN_NAMESPACE=homelab
BRAIN_CLIENT_ID=rpi5-debian13-daemon
CLI_SYNC_ENABLED=true
CLI_CLIENT_ID=antigravity-cli-rpi5
CLI_GEMINI_DIR=/root/.gemini
EOF
  sudo chmod 600 "${ENV_FILE}"
  echo "IMPORTANT: Update MCP_BEARER_TOKEN in ${ENV_FILE}"
fi

echo "=== [3/5] Installing systemd unit ==="
sudo cp "${REPO_DIR}/rpi-sync/gemini-brain-watcher.service" /etc/systemd/system/gemini-brain-watcher.service
sudo sed -i "s/^User=.*/User=$(whoami)/" /etc/systemd/system/gemini-brain-watcher.service
sudo systemctl daemon-reload
sudo systemctl enable gemini-brain-watcher.service

echo "=== [4/5] Installing /usr/local/bin/brain-monitor CLI wrapper ==="
sudo tee /usr/local/bin/brain-monitor > /dev/null << EOF
#!/usr/bin/env bash
set -euo pipefail
if [ -f "${ENV_FILE}" ]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi
exec python3 "${REPO_DIR}/brain_monitor.py" "\$@"
EOF
sudo chmod +x /usr/local/bin/brain-monitor

echo "=== [5/5] Starting gemini-brain-watcher.service ==="
sudo systemctl restart gemini-brain-watcher.service
sudo systemctl status gemini-brain-watcher.service --no-pager
