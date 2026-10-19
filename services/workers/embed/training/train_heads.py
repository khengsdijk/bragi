#!/usr/bin/env python
"""Train the small tagging heads on CLAP embeddings (WP-1.6, ADR-0011).

One two-layer MLP per category (genre, mood, instrument) over the taxonomy's labels. Embeddings
come from the pinned CLAP model (``--extra clap``); training itself is plain NumPy SGD, so the
same run needs no torch beyond the embedder.

This was **not** run for WP-1.6: no weights, no GPU and no labelled dataset are available in that
environment. See ``README.md`` for the dataset and the exact commands.

Usage::

    uv run --directory services/workers --extra clap \
        python services/workers/embed/training/train_heads.py \
        --dataset /data/jamendo.jsonl --out /models/bragi-heads
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import cast

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.embedding.clap import CLAPEmbedder
from bragi_analysis.tagging import taxonomy
from bragi_analysis.tagging.taxonomy import Category

type F64 = NDArray[np.float64]

TRAINABLE: tuple[Category, ...] = ("genres", "moods", "instruments")
SAMPLE_RATE = 48_000


def read_dataset(path: Path) -> list[dict[str, object]]:
    """Reads the JSONL of ``{"path", "genres", "moods", "instruments"}`` rows."""
    rows: list[dict[str, object]] = []
    for raw in path.read_text("utf-8").splitlines():
        line = raw.strip()
        if line:
            rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"{path} has no rows")
    return rows


def decode_mono(path: Path) -> NDArray[np.float32]:
    """Decodes an audio file to 48 kHz mono float32 (import a decoder lazily)."""
    import soundfile as sf  # a worker dependency, already installed

    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if rate != SAMPLE_RATE:
        from fractions import Fraction

        from scipy.signal import resample_poly

        ratio = Fraction(SAMPLE_RATE, rate)
        mono = np.asarray(
            resample_poly(mono, ratio.numerator, ratio.denominator, window=("kaiser", 9.0)),
            dtype=np.float32,
        )
    return np.asarray(mono, dtype=np.float32)


def embed_all(embedder: CLAPEmbedder, rows: list[dict[str, object]], root: Path) -> F64:
    """One pooled song embedding per dataset row."""
    from bragi_analysis.embedding import pipeline

    vectors: list[F64] = []
    for index, row in enumerate(rows):
        mono = decode_mono(root / str(row["path"]))
        vector, _ = pipeline.pooled_vector(embedder, mono, SAMPLE_RATE, None)
        vectors.append(vector)
        if (index + 1) % 100 == 0:
            print(f"embedded {index + 1}/{len(rows)}", file=sys.stderr)
    return np.stack(vectors)


def labels_for(
    rows: list[dict[str, object]], category: Category, vocabulary: taxonomy.Taxonomy
) -> tuple[F64, list[str]]:
    """A multi-hot target matrix and the label list for one category."""
    entries = vocabulary.entries(category)
    index_of = {entry.id: i for i, entry in enumerate(entries)}
    targets = np.zeros((len(rows), len(entries)), dtype=np.float64)
    dropped = 0
    for row, target in zip(rows, targets, strict=True):
        raw = row.get(category)
        if not isinstance(raw, list):
            continue
        for label in cast(list[object], raw):
            position = index_of.get(str(label))
            if position is None:
                dropped += 1
            else:
                target[position] = 1.0
    if dropped:
        print(f"{category}: dropped {dropped} unknown label ids", file=sys.stderr)
    return targets, [entry.id for entry in entries]


def train_head(
    features: F64, targets: F64, *, hidden: int, epochs: int, seed: int, learning_rate: float = 0.05
) -> tuple[F64, F64, F64, F64]:
    """A two-layer MLP with a sigmoid output, trained by minibatch SGD (BCE loss)."""
    rng = np.random.default_rng(seed)
    dim = features.shape[1]
    out = targets.shape[1]
    w1 = rng.standard_normal((hidden, dim)) * np.sqrt(1.0 / dim)
    b1 = np.zeros(hidden)
    w2 = rng.standard_normal((out, hidden)) * np.sqrt(1.0 / hidden)
    b2 = np.zeros(out)
    batch = 32

    def sigmoid(x: F64) -> F64:
        return 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))

    for epoch in range(epochs):
        order = rng.permutation(features.shape[0])
        for start in range(0, len(order), batch):
            index = order[start : start + batch]
            x = features[index]
            y = targets[index]
            hidden_pre = x @ w1.T + b1
            hidden_act = np.maximum(hidden_pre, 0.0)
            prob = sigmoid(hidden_act @ w2.T + b2)
            error = (prob - y) / len(index)
            grad_w2 = error.T @ hidden_act
            grad_b2 = error.sum(axis=0)
            grad_hidden = (error @ w2) * (hidden_pre > 0.0)
            grad_w1 = grad_hidden.T @ x
            grad_b1 = grad_hidden.sum(axis=0)
            w1 -= learning_rate * grad_w1
            b1 -= learning_rate * grad_b1
            w2 -= learning_rate * grad_w2
            b2 -= learning_rate * grad_b2
        print(f"epoch {epoch + 1}/{epochs}", file=sys.stderr)
    return w1, b1, w2, b2


def save_head(
    directory: Path,
    category: Category,
    label_ids: Sequence[str],
    arrays: tuple[F64, F64, F64, F64],
) -> None:
    """Writes ``<category>.npz`` in the layout ``load_heads`` expects."""
    directory.mkdir(parents=True, exist_ok=True)
    w1, b1, w2, b2 = arrays
    np.savez(
        directory / f"{category}.npz",
        labels=np.asarray(label_ids),
        w1=w1.astype(np.float32),
        b1=b1.astype(np.float32),
        w2=w2.astype(np.float32),
        b2=b2.astype(np.float32),
    )


def main(argv: Iterable[str] | None = None) -> int:
    """Trains every trainable category head and writes it to ``--out``."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="JSONL of clips + labels")
    parser.add_argument("--audio-root", type=Path, default=None, help="root for relative paths")
    parser.add_argument(
        "--taxonomy", type=Path, default=None, help="taxonomy.json (default: the packaged one)"
    )
    parser.add_argument("--out", type=Path, required=True, help="directory for <category>.npz")
    parser.add_argument("--hidden", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(list(argv) if argv is not None else None)

    rows = read_dataset(args.dataset)
    root = args.audio_root or args.dataset.parent
    vocabulary = taxonomy.load(args.taxonomy)

    embedder = CLAPEmbedder.load()
    features = embed_all(embedder, rows, root)
    print(f"embedded {features.shape[0]} clips into {features.shape[1]}-d vectors")

    for category in TRAINABLE:
        targets, label_ids = labels_for(rows, category, vocabulary)
        if targets.sum() == 0:
            print(f"{category}: no labels, skipping", file=sys.stderr)
            continue
        arrays = train_head(
            features, targets, hidden=args.hidden, epochs=args.epochs, seed=args.seed
        )
        save_head(args.out, category, label_ids, arrays)
        print(f"{category}: wrote {args.out / f'{category}.npz'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
