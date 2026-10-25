#!/usr/bin/env bash
# Installs Ollama as a systemd service on the PC (native Ubuntu, or WSL2 with
# systemd enabled), keeps the model loaded forever, and pulls the model.
#   usage: deploy/pc/setup-ollama.sh [model]   (default qwen3-vl:4b-instruct)
set -euo pipefail

MODEL=${1:-qwen3-vl:4b-instruct}

if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "WSL detected."
  [[ $(ps -p 1 -o comm=) == systemd ]] || {
    echo "systemd is not running. Add this to /etc/wsl.conf, then run 'wsl --shutdown' in Windows and reopen:"
    printf '  [boot]\n  systemd=true\n'
    exit 1
  }
  command -v nvidia-smi >/dev/null || echo "WARNING: nvidia-smi missing. Do NOT install a Linux NVIDIA driver in WSL; update the Windows driver instead."
fi

if command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
  echo "WARNING: no NVIDIA GPU visible; Ollama will run on the CPU (slow)."
fi

if ! command -v ollama >/dev/null; then
  echo "Installing Ollama (official script)..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Keep the model in VRAM all night and only listen locally (the tunnel connects to localhost).
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/ipsengpt.conf >/dev/null <<'CONF'
[Service]
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_NUM_PARALLEL=2"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
# Must match the app's OLLAMA_NUM_CTX: a request with a different context size
# makes Ollama reload the model (seconds), and bigger GPUs default to more than 4096.
Environment="OLLAMA_CONTEXT_LENGTH=4096"
CONF
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama

for _ in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
echo "Pulling $MODEL (models are stored on the Linux filesystem, not /mnt/c)..."
ollama pull "$MODEL"
echo "Warming up..."
curl -sf http://127.0.0.1:11434/api/chat -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say boo.\"}],\"stream\":false,\"think\":false}" >/dev/null
ollama ps
echo "Check: PROCESSOR should be 100% GPU and CONTEXT 4096 (same as OLLAMA_NUM_CTX on the droplet)."
echo "Done. Next: deploy/pc/tunnel.sh"
