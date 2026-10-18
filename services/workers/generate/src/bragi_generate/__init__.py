"""Generation and transformation workers.

Capabilities (``specs/09-generation.md``, ``specs/10-fusion.md``):
``generate.extend``, ``generate.inpaint``, ``generate.stem``,
``generate.fx``, ``text2music``, ``stem_resynth``, timbre swap and style
transfer, behind the ``GenerationBackend`` adapter and routing table.

Every output passes the quality gates in ``postprocess.py`` before it is
offered to the user, and the content policy in ``specs/10-fusion.md`` §7 is
binding on anything AI-facing.

Status:
    Scaffold (WP-0.1). Built from **WP-2.7** onwards (ADR-0004).
"""
