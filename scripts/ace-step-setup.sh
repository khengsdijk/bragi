#!/usr/bin/env bash
# Install ACE-Step 1.5 into the git-ignored .bragi/ directory (WP-2.7 A1,
# specs/09-generation.md §3). The model runs as its own process with its own uv
# environment, so its torch/transformers pins never reach the workers workspace.
#
# The checkout and the weights live outside the worktree, under the main
# checkout's .bragi/ (the only path this script writes outside the repo):
#   BRAGI_ACE_STEP_DIR         checkout        (default <main>/.bragi/ace-step)
#   BRAGI_ACE_STEP_MODELS_DIR  weights         (default <main>/.bragi/models/ace-step)
#
# Idempotent: re-running checks out the pinned commit, re-syncs the environment
# (a no-op when nothing changed) and lets the downloader skip existing files.
#
# Usage:
#   scripts/ace-step-setup.sh                  # install + download the weights
#   scripts/ace-step-setup.sh --skip-download  # install only
#
# Start the API afterwards with scripts/ace-step-serve.sh.
set -euo pipefail

# Pinned 2026-08-29: fix(jetson): remove GPL video codecs, fix ffmpeg/examples/healthcheck.
# Bump deliberately and re-run the A1 spike when the pin changes.
ace_step_commit="ca1e85fe9430179831e6bc6be790c332190a3866"
ace_step_repo="https://github.com/ACE-Step/ACE-Step-1.5.git"

download="true"
for arg in "$@"; do
  case "$arg" in
    --skip-download) download="false" ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ace-step-setup: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git_common_dir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$git_common_dir")"

ace_dir="${BRAGI_ACE_STEP_DIR:-$main_root/.bragi/ace-step}"
models_dir="${BRAGI_ACE_STEP_MODELS_DIR:-$main_root/.bragi/models/ace-step}"

for tool in git uv; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ace-step-setup: '$tool' is required (https://docs.astral.sh/uv/)" >&2
    exit 1
  }
done

echo "ace-step-setup: checkout $ace_dir"
echo "ace-step-setup: weights  $models_dir"

if [ ! -d "$ace_dir/.git" ]; then
  mkdir -p "$(dirname "$ace_dir")"
  git clone "$ace_step_repo" "$ace_dir"
fi

# The checkout is detached on the pin, so updates never move it silently.
if ! git -C "$ace_dir" cat-file -e "$ace_step_commit^{commit}" 2>/dev/null; then
  git -C "$ace_dir" fetch --depth 1 origin "$ace_step_commit"
fi
current="$(git -C "$ace_dir" rev-parse HEAD 2>/dev/null || true)"
if [ "$current" != "$ace_step_commit" ]; then
  git -C "$ace_dir" checkout --detach "$ace_step_commit"
fi
actual="$(git -C "$ace_dir" rev-parse HEAD)"
if [ "$actual" != "$ace_step_commit" ]; then
  echo "ace-step-setup: HEAD is $actual, expected $ace_step_commit" >&2
  exit 1
fi
echo "ace-step-setup: pinned at $actual"

mkdir -p "$models_dir"

# ACESTEP_CHECKPOINTS_DIR is ACE-Step's shared model directory; the downloader and
# the server both honour it, so weights never land inside the checkout.
export ACESTEP_CHECKPOINTS_DIR="$models_dir"

echo "ace-step-setup: uv sync (own .venv, its own pins)"
(cd "$ace_dir" && uv sync --frozen --no-dev)

if [ "$download" = "true" ]; then
  echo "ace-step-setup: downloading the main model (vae, text encoder, turbo DiT, LM)"
  echo "ace-step-setup: this is several GB and can take 30-60 minutes on a slow link"
  (cd "$ace_dir" && uv run --frozen acestep-download --dir "$models_dir")
else
  echo "ace-step-setup: --skip-download, weights will download on first run"
fi

# The API server always looks in <checkout>/checkpoints, ignoring
# ACESTEP_CHECKPOINTS_DIR, so point that path at the shared model dir. Without
# the symlink a second 9.4 GB copy appears the first time the API initialises.
if [ -d "$ace_dir/checkpoints" ] && [ ! -L "$ace_dir/checkpoints" ]; then
  echo "ace-step-setup: consolidating the checkout's checkpoints into $models_dir"
  mkdir -p "$models_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --ignore-existing "$ace_dir/checkpoints/" "$models_dir/"
  else
    cp -R "$ace_dir/checkpoints/." "$models_dir/"
  fi
  rm -rf "$ace_dir/checkpoints"
fi
ln -sfn "$models_dir" "$ace_dir/checkpoints"

echo
echo "ace-step-setup: done"
echo "  checkout: $ace_dir"
echo "  weights:  $models_dir"
echo "  start:    scripts/ace-step-serve.sh    (REST API on 127.0.0.1:8001)"
