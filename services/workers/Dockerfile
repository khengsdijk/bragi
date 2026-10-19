# The worker image (specs/05 §1). The same image serves `echo`, the small analysis stages and
# `analysis.separation`; a GPU host runs it with the NVIDIA container runtime (the PyPI torch
# wheel for Linux bundles CUDA, and the worker picks cuda > mps > cpu on its own).
#
# Build with: docker compose -f infra/docker-compose.yml up -d --build worker
#
# WP-1.2 adds the OS binaries the analysis stages shell out to (ffmpeg for decoding,
# Chromaprint's fpcalc for fingerprints) and an opt-in neural layer:
#   docker build --build-arg WITH_ML=1 -f services/workers/Dockerfile .
# installs the `ml` extra (torch + beat-this) and fetches the SHA-256-pinned Beat This!
# checkpoint (services/workers/MODELS.md). Without it `rhythm` falls back to the
# weight-free DSP tracker. Neither layer has been built in the sandbox this was written in
# (Docker Hub pulls are blocked), so the first real build is the first test of this file.
FROM python:3.12-slim
ARG WITH_ML=0
ARG BEAT_THIS_URL=https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt
ARG BEAT_THIS_SHA256=8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# uv from PyPI rather than the ghcr.io image, so the build needs no extra registry.
RUN pip install --no-cache-dir "uv==0.12.5"
WORKDIR /app
COPY services/workers ./services/workers
# `--group models` adds torch + demucs (WP-1.3, ADR-0004); `--extra ml` (WITH_ML=1) adds Beat This!
# (WP-1.2, ADR-0007). The default local sync installs neither.
RUN cd services/workers \
    && if [ "$WITH_ML" = "1" ]; then uv sync --frozen --no-dev --group models --extra ml; \
       else uv sync --frozen --no-dev --group models; fi
ENV PATH="/app/services/workers/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    BRAGI_BEAT_THIS_CHECKPOINT=/models/beat_this-final0.ckpt
# Model weights are pulled HERE, at image build, pinned by hash (specs/04 §9, MODELS.md); the build
# fails on a mismatch and workers never download at runtime. Separation weights are pinned in
# bragi_analysis/separation/models_lock.json; the worker only reads /opt/bragi/models.
RUN if [ "$WITH_ML" = "1" ]; then \
      mkdir -p /models \
      && curl -fsSL -o /models/beat_this-final0.ckpt "$BEAT_THIS_URL" \
      && echo "$BEAT_THIS_SHA256  /models/beat_this-final0.ckpt" | sha256sum -c -; \
    fi
ENV BRAGI_MODELS_DIR=/opt/bragi/models \
    HF_HUB_OFFLINE=1
RUN python -m bragi_analysis.separation.weights "$BRAGI_MODELS_DIR"
WORKDIR /app/services/workers
CMD ["python", "-m", "bragi_analysis"]
