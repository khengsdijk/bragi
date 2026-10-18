# The CPU worker image (specs/05 §1). GPU capabilities are a later work package;
# this image is enough for `echo` and the small-analysis smoke tests.
#
# Build with: docker compose -f infra/docker-compose.yml up -d --build worker
FROM python:3.12-slim
# uv from PyPI rather than the ghcr.io image, so the build needs no extra registry.
RUN pip install --no-cache-dir "uv==0.12.5"
WORKDIR /app
COPY services/workers ./services/workers
RUN cd services/workers && uv sync --frozen --no-dev
ENV PATH="/app/services/workers/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1
WORKDIR /app/services/workers
CMD ["python", "-m", "bragi_analysis"]
