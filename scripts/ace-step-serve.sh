#!/usr/bin/env bash
# Start the ACE-Step 1.5 REST API for the generation worker (WP-2.7 A1,
# specs/09-generation.md §3). The model runs on the engine selected by
# BRAGI_ACE_STEP_ENGINE (mlx|pytorch, see scripts/ace-step-launch.py); on macOS the
# API's own default is MLX, PyTorch/MPS is the portable alternative. vLLM has no
# macOS backend, and the 5 Hz LM is not needed for repaint/extend (ACE-Step skips it
# for that task), so it stays disabled unless ACESTEP_INIT_LLM overrides it.
#
# Writes the PID to <checkout>/serve.pid. Stop it with:
#   kill "$(cat "$BRAGI_ACE_STEP_DIR/serve.pid")"
#
# Environment overrides: BRAGI_ACE_STEP_DIR, BRAGI_ACE_STEP_MODELS_DIR,
# BRAGI_ACE_STEP_ENGINE, ACESTEP_API_PORT, ACESTEP_INIT_LLM, ACESTEP_DEVICE.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git_common_dir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$git_common_dir")"

ace_dir="${BRAGI_ACE_STEP_DIR:-$main_root/.bragi/ace-step}"
models_dir="${BRAGI_ACE_STEP_MODELS_DIR:-$main_root/.bragi/models/ace-step}"
port="${ACESTEP_API_PORT:-8001}"
pid_file="$ace_dir/serve.pid"
log_file="$ace_dir/serve.log"

if [ ! -d "$ace_dir/.venv" ]; then
  echo "ace-step-serve: no environment at $ace_dir, run scripts/ace-step-setup.sh first" >&2
  exit 1
fi

if [ -f "$pid_file" ]; then
  old_pid="$(cat "$pid_file")"
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "ace-step-serve: already running (pid $old_pid, http://127.0.0.1:$port)"
    exit 0
  fi
  rm -f "$pid_file"
fi

mkdir -p "$models_dir"

export ACESTEP_CHECKPOINTS_DIR="$models_dir"
export ACESTEP_DEVICE="${ACESTEP_DEVICE:-mps}"
# `pytorch` pins PyTorch/MPS in the launcher and won the A2 measurement for a 30 s
# extend; `mlx` leaves ACE-Step's Apple Silicon defaults alone (docs/wp/2.7.md).
export BRAGI_ACE_STEP_ENGINE="${BRAGI_ACE_STEP_ENGINE:-pytorch}"
# vLLM is CUDA/Linux only; PyTorch is the portable backend on macOS.
export ACESTEP_LM_BACKEND="pt"
export ACESTEP_INIT_LLM="${ACESTEP_INIT_LLM:-false}"
export TOKENIZERS_PARALLELISM="false"
export PYTORCH_ENABLE_MPS_FALLBACK=1

cd "$ace_dir"
export ACESTEP_API_HOST="127.0.0.1"
export ACESTEP_API_PORT="$port"
# ACE-Step's API has no engine flag (its Apple Silicon tier selects MLX). The
# launcher applies BRAGI_ACE_STEP_ENGINE before the app imports ACE-Step.
nohup uv run --frozen python "$root/scripts/ace-step-launch.py" \
  >"$log_file" 2>&1 &
pid=$!
printf '%s\n' "$pid" >"$pid_file"

echo "ace-step-serve: starting pid $pid, log $log_file"
for _ in $(seq 1 120); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "ace-step-serve: process exited during startup, last log lines:" >&2
    tail -n 40 "$log_file" >&2
    rm -f "$pid_file"
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "ace-step-serve: ready on http://127.0.0.1:$port (pid $pid, $(uname -m) / $BRAGI_ACE_STEP_ENGINE)"
    exit 0
  fi
  sleep 1
done

echo "ace-step-serve: not healthy after 120 s; it is still running (pid $pid)." >&2
echo "ace-step-serve: follow the log with: tail -f $log_file" >&2
exit 1
