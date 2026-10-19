# The CPU worker image (specs/05 §1). GPU capabilities are a later work package.
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
RUN cd services/workers \
    && if [ "$WITH_ML" = "1" ]; then uv sync --frozen --no-dev --extra ml; else uv sync --frozen --no-dev; fi
# Weights are pulled at build time and pinned by hash (04 §9); workers never download at runtime.
RUN if [ "$WITH_ML" = "1" ]; then \
      mkdir -p /models \
      && curl -fsSL -o /models/beat_this-final0.ckpt "$BEAT_THIS_URL" \
      && echo "$BEAT_THIS_SHA256  /models/beat_this-final0.ckpt" | sha256sum -c -; \
    fi
ENV PATH="/app/services/workers/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    BRAGI_BEAT_THIS_CHECKPOINT=/models/beat_this-final0.ckpt
WORKDIR /app/services/workers
CMD ["python", "-m", "bragi_analysis"]
