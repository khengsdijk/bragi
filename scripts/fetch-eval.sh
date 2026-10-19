#!/usr/bin/env bash
# Fetch the private analysis eval audio into fixtures/eval/audio/ (specs/04 section 8,
# specs/13 section 6). The audio is never committed: it lives in the owner's private
# bucket and is referenced by SHA-256 in fixtures/eval/manifest.json.
#
# Required environment:
#   BRAGI_EVAL_BUCKET     s3://<bucket>[/<prefix>] holding the audio files named in the manifest
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credentials with read access to it
# Optional:
#   BRAGI_EVAL_ENDPOINT   S3-compatible endpoint URL (MinIO, R2, ...)
#
# Verification: `pnpm eval:analysis` re-hashes every file against the manifest and reports a
# hash_mismatch instead of scoring it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/fixtures/eval/audio"

missing=()
for name in BRAGI_EVAL_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "fetch-eval: cannot fetch the eval set, missing: ${missing[*]}"
    echo "  The eval audio is private and needs the owner's credentials (specs/13 section 6)."
    echo "  Until it exists, 'pnpm eval:analysis' reports every gate as PENDING."
  } >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "fetch-eval: the 'aws' CLI is required (https://aws.amazon.com/cli/)" >&2
  exit 1
fi

endpoint=()
if [ -n "${BRAGI_EVAL_ENDPOINT:-}" ]; then
  endpoint=(--endpoint-url "$BRAGI_EVAL_ENDPOINT")
fi

mkdir -p "$dest"
aws ${endpoint[@]+"${endpoint[@]}"} s3 sync "${BRAGI_EVAL_BUCKET%/}/" "$dest/" --only-show-errors
echo "fetch-eval: audio synced to $dest"
echo "fetch-eval: run 'pnpm eval:analysis' (it verifies every SHA-256 against the manifest)"
