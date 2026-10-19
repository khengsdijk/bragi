"""The controlled tagging taxonomy (``specs/04`` §6.2).

``config/taxonomy.json`` is generated from ``packages/schemas/analysis/taxonomy.json`` by
``pnpm schemas:gen``; this module loads and validates it. Genres are hierarchical (a genre's
``parents`` are its ancestors, most general first); moods, instruments, descriptors and eras are
flat. Every entry carries a zero-shot ``prompt`` template, defaulted from the label when the file
omits one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Literal

type Category = Literal["genres", "moods", "instruments", "descriptors", "eras"]

CATEGORIES: tuple[Category, ...] = ("genres", "moods", "instruments", "descriptors", "eras")
_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
#: The spec's order-of-magnitude targets (04 §6.2); a superset is fine, fewer is a regression.
MINIMUMS: dict[Category, int] = {
    "genres": 140,
    "moods": 40,
    "instruments": 50,
    "descriptors": 100,
    "eras": 8,
}


class TaxonomyError(ValueError):
    """The taxonomy file is malformed or violates the 04 §6.2 contract."""


@dataclass(frozen=True)
class Entry:
    """One taxonomy label."""

    id: str
    label: str
    prompt: str
    parents: tuple[str, ...] = ()


@dataclass(frozen=True)
class Taxonomy:
    """The whole vocabulary."""

    version: int
    genres: tuple[Entry, ...]
    moods: tuple[Entry, ...]
    instruments: tuple[Entry, ...]
    descriptors: tuple[Entry, ...]
    eras: tuple[Entry, ...]

    def entries(self, category: Category) -> tuple[Entry, ...]:
        """The entries of one category."""
        groups: dict[Category, tuple[Entry, ...]] = {
            "genres": self.genres,
            "moods": self.moods,
            "instruments": self.instruments,
            "descriptors": self.descriptors,
            "eras": self.eras,
        }
        return groups[category]


def _default_prompt(category: Category, label: str) -> str:
    templates: dict[Category, str] = {
        "genres": "a {label} song",
        "moods": "{label} music",
        "instruments": "the sound of {label}",
        "descriptors": "a {label} sound",
        "eras": "music from the {label}",
    }
    return templates[category].format(label=label)


def validate(raw: object) -> Taxonomy:
    """Validates a parsed taxonomy document and returns it typed."""
    if not isinstance(raw, dict):
        raise TaxonomyError("the taxonomy must be a JSON object")
    version = raw.get("version")
    if not isinstance(version, int) or version < 1:
        raise TaxonomyError("`version` must be a positive integer")

    groups: dict[Category, tuple[Entry, ...]] = {}
    for category in CATEGORIES:
        items = raw.get(category)
        if not isinstance(items, list):
            raise TaxonomyError(f"`{category}` must be a list")
        if len(items) < MINIMUMS[category]:
            raise TaxonomyError(
                f"`{category}` has {len(items)} entries, below the {MINIMUMS[category]} target"
            )
        seen: set[str] = set()
        entries: list[Entry] = []
        for item in items:
            if not isinstance(item, dict):
                raise TaxonomyError(f"`{category}` entries must be objects")
            entry_id = item.get("id")
            label = item.get("label")
            if not isinstance(entry_id, str) or not _ID.match(entry_id):
                raise TaxonomyError(f"`{category}` has a bad id: {entry_id!r}")
            if entry_id in seen:
                raise TaxonomyError(f"duplicate id in `{category}`: {entry_id}")
            seen.add(entry_id)
            if not isinstance(label, str) or not label:
                raise TaxonomyError(f"`{category}`/{entry_id} needs a label")
            prompt = item.get("prompt")
            if not isinstance(prompt, str) or not prompt:
                prompt = _default_prompt(category, label.lower())
            parents = item.get("parents", [])
            if category != "genres" and parents:
                raise TaxonomyError(f"`{category}`/{entry_id} must not have parents")
            if not isinstance(parents, list) or any(not isinstance(p, str) for p in parents):
                raise TaxonomyError(f"genres/{entry_id}: `parents` must be a list of ids")
            entries.append(Entry(entry_id, label, prompt, tuple(parents)))
        groups[category] = tuple(entries)

    genre_ids = {entry.id for entry in groups["genres"]}
    for entry in groups["genres"]:
        if len(set(entry.parents)) != len(entry.parents):
            raise TaxonomyError(f"genres/{entry.id}: duplicate parent")
        for parent in entry.parents:
            if parent not in genre_ids:
                raise TaxonomyError(f"genres/{entry.id}: unknown parent {parent!r}")

    # Cycle detection over the parent graph (iterative DFS with a grey/black colouring).
    parents_of = {entry.id: entry.parents for entry in groups["genres"]}
    black: set[str] = set()
    for root in genre_ids:
        if root in black:
            continue
        grey: set[str] = set()
        stack: list[tuple[str, int]] = [(root, 0)]
        grey.add(root)
        while stack:
            node, index = stack[-1]
            if index < len(parents_of[node]):
                stack[-1] = (node, index + 1)
                parent = parents_of[node][index]
                if parent in grey:
                    raise TaxonomyError(f"genres/{node}: cycle through {parent!r}")
                if parent not in black:
                    grey.add(parent)
                    stack.append((parent, 0))
            else:
                stack.pop()
                grey.discard(node)
                black.add(node)
    return Taxonomy(version=version, **groups)


def load(path: Path | None = None) -> Taxonomy:
    """Loads and validates the taxonomy from ``path`` or the packaged file."""
    if path is not None:
        return validate(json.loads(path.read_text("utf-8")))
    return default()


@lru_cache(maxsize=1)
def default() -> Taxonomy:
    """The packaged taxonomy, validated once."""
    text = resources.files("bragi_analysis").joinpath("config/taxonomy.json").read_text("utf-8")
    return validate(json.loads(text))


__all__ = [
    "CATEGORIES",
    "MINIMUMS",
    "Category",
    "Entry",
    "Taxonomy",
    "TaxonomyError",
    "default",
    "load",
    "validate",
]
