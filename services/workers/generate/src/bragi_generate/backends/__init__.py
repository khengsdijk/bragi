"""Generation backends (``specs/09-generation.md`` §3.1).

``backend.py`` holds the protocol; ``fake.py`` is the deterministic no-model backend
for tests and the live e2e, and ``ace_step.py`` wraps ``ace_step_api.py``, the thin
HTTP client proven by the WP-2.7 A1 spike.
"""
