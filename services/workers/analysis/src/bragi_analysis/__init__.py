"""Analysis workers: how a dropped file becomes a visible song.

Capabilities (``specs/04-analysis-pipeline.md``): ``ingest``, ``separate``,
``rhythm``, ``loudness_energy``, ``structure``, ``harmony``, ``tag``,
``describe``, and the deep-profile stages ``drum_split``, ``transcribe`` and
``lyrics``.

GPU code must also run on CPU, slowly, so CI can run tiny smoke tests, and
model weights are pinned by hash in ``MODELS.md`` and downloaded at image build
(``specs/13-agent-guide.md`` §3).

Status:
    Scaffold (WP-0.1). ``ingest``, ``rhythm`` and ``loudness_energy`` arrive
    with **WP-1.2**, ``separate`` with **WP-1.3**, then WP-1.4 to WP-1.7.
"""
