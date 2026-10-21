"""Minimal HTTP client for the ACE-Step 1.5 REST API (WP-2.7 A1 spike).

ACE-Step runs as its own process (``scripts/ace-step-serve.sh``); the generation
worker only speaks HTTP to it. The client is deliberately narrow: health plus the
``repaint`` task, both as a forward extend (``ExtendRequest``, the A1 spike) and
with an explicit span (``RepaintRequest``, which A2's backward extend needs). The
``GenerationBackend`` adapter in ``ace_step.py`` builds on these calls.

The extend mapping (measured on M2 Pro / MPS, see ``docs/wp/2.7.md``):

* ``task_type="repaint"`` with the rendered context as ``src_audio_path``;
* ``repainting_start = src_duration - overlap`` so the model re-creates the last
  ``overlap`` seconds as well (the seam window) and continues past the end;
* ``repainting_end = src_duration + extend_sec``; ACE-Step pads the source with
  silence on the right and outpaints, and the returned WAV is the whole padded
  timeline (context + overlap + new audio);
* ``chunk_mask_mode="explicit"`` so the mask is the sampled range rather than
  the model's automatic chunking.

Only the standard library is used, so the worker keeps its dependency surface
unchanged and a hosted variant of the same API would be a base-URL change.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

DEFAULT_BASE_URL = "http://127.0.0.1:8001"
"""The address ``scripts/ace-step-serve.sh`` binds to."""

DEFAULT_STEPS = 8
"""ACE-Step's turbo default; ``preview`` uses fewer (see ``docs/wp/2.7.md``)."""

AudioFormat = Literal["wav", "wav32", "flac", "mp3"]


class AceStepError(RuntimeError):
    """An ACE-Step request failed, or the server reported a failed task."""


@dataclass(frozen=True)
class Health:
    """``GET /health`` payload."""

    status: str
    service: str
    version: str


@dataclass(frozen=True)
class ExtendRequest:
    """One forward extend through the repaint task.

    Args:
        src_audio_path: Absolute path of the rendered context WAV on the ACE-Step
            host. The JSON API accepts ``src_audio_path``; use the multipart
            ``src_audio`` field for a remote host (not needed for the local spike).
        src_duration_sec: Length of the context file. The call asserts this
            against the file only at ``submit`` time (the API does not probe it).
        extend_sec: Seconds of new audio after the context.
        overlap_sec: Context tail the model may re-create (the seam window).
        caption: Target description for the continued part. Empty means
            "continue seamlessly".
        lyrics: Ignored unless ``instrumental`` is false.
        instrumental: Sends empty lyrics, which ACE-Step treats as instrumental.
        bpm: Conditioning BPM, or ``None`` for the model's estimate.
        key_scale: ACE-Step key spelling, e.g. ``"Am"`` or ``"A minor"``.
        time_signature: ``"2"``, ``"3"``, ``"4"`` or ``"6"``.
        seed: Deterministic seed, or ``None`` for a random one.
        steps: Diffusion steps. Turbo recommends 8; fewer is the preview tier.
        guidance_scale: CFG scale; only effective on non-turbo DiT models.
        batch_size: Candidates per task (ACE-Step maximum is 8).
        repaint_mode: Preservation mode; ``balanced`` keeps the context and lets
            ``repaint_strength`` tune the boundary.
        repaint_strength: 0 = preserve the most source, 1 = re-create freely.
        output_format: Requested container. ``wav`` is 48 kHz float output.
        model: Optional DiT name (``/v1/models``); ``None`` uses the server default.
    """

    src_audio_path: str
    src_duration_sec: float
    extend_sec: float
    overlap_sec: float = 2.0
    caption: str = ""
    lyrics: str = ""
    instrumental: bool = True
    bpm: int | None = None
    key_scale: str = ""
    time_signature: str = "4"
    seed: int | None = None
    steps: int = DEFAULT_STEPS
    guidance_scale: float = 7.0
    batch_size: int = 1
    repaint_mode: Literal["conservative", "balanced", "aggressive"] = "balanced"
    repaint_strength: float = 0.5
    output_format: AudioFormat = "wav"
    model: str | None = None

    def __post_init__(self) -> None:
        """Reject ranges the API or the seam contract cannot express."""
        if not self.src_audio_path:
            raise ValueError("src_audio_path is required")
        if self.src_duration_sec <= 0:
            raise ValueError("src_duration_sec must be positive")
        if not 0 <= self.overlap_sec < self.src_duration_sec:
            raise ValueError("overlap_sec must be >= 0 and shorter than the source")
        if self.extend_sec <= 0:
            raise ValueError("extend_sec must be positive")
        if self.src_duration_sec + self.extend_sec > 600:
            raise ValueError("ACE-Step supports at most 600 s of output")
        if not 1 <= self.steps <= 200:
            raise ValueError("steps must be in 1..200")
        if not 1 <= self.batch_size <= 8:
            raise ValueError("batch_size must be in 1..8")
        if not 0 <= self.repaint_strength <= 1:
            raise ValueError("repaint_strength must be in 0..1")

    @property
    def repaint_start_sec(self) -> float:
        """Where the regenerated span starts (context tail included)."""
        return round(self.src_duration_sec - self.overlap_sec, 3)

    @property
    def repaint_end_sec(self) -> float:
        """Where the regenerated span ends: the end of the new audio."""
        return round(self.src_duration_sec + self.extend_sec, 3)


@dataclass(frozen=True)
class RepaintRequest:
    """One repaint with an explicit span (A2: backward extend).

    ``ExtendRequest`` expresses a forward extend as "last ``overlap`` seconds plus
    ``extend_sec`` past the source". A backward extend instead prepends silence and
    repaints ``[0, new + overlap]``, which no positive ``extend_sec`` can describe, so
    the span is explicit here. The conditioning fields are the same.

    Args:
        src_audio_path: Absolute path of the source WAV on the ACE-Step host.
        src_duration_sec: Length of that file (it may be shorter than ``end_sec``;
            ACE-Step pads silence on the right).
        start_sec: First repainted sample, in seconds.
        end_sec: End of the repainted span, in seconds.
        caption: Target description. Empty means "continue seamlessly".
        bpm: Conditioning BPM, or ``None`` for the model's estimate.
        key_scale: ACE-Step key spelling, e.g. ``"Am"``.
        time_signature: ``"2"``, ``"3"``, ``"4"`` or ``"6"``.
        seed: Deterministic seed, or ``None`` for a random one.
        steps: Diffusion steps.
        output_format: ``wav32`` keeps the model's float output (A1 saw int16 for ``wav``).
    """

    src_audio_path: str
    src_duration_sec: float
    start_sec: float
    end_sec: float
    caption: str = ""
    lyrics: str = ""
    instrumental: bool = True
    bpm: int | None = None
    key_scale: str = ""
    time_signature: str = "4"
    seed: int | None = None
    steps: int = DEFAULT_STEPS
    guidance_scale: float = 7.0
    batch_size: int = 1
    repaint_mode: Literal["conservative", "balanced", "aggressive"] = "balanced"
    repaint_strength: float = 0.5
    output_format: AudioFormat = "wav32"
    model: str | None = None

    def __post_init__(self) -> None:
        """Rejects a span the API cannot express."""
        if not self.src_audio_path:
            raise ValueError("src_audio_path is required")
        if self.src_duration_sec <= 0:
            raise ValueError("src_duration_sec must be positive")
        if not 0.0 <= self.start_sec < self.end_sec:
            raise ValueError("the repaint span must satisfy 0 <= start < end")
        if max(self.src_duration_sec, self.end_sec) > 600:
            raise ValueError("ACE-Step supports at most 600 s of output")
        if not 1 <= self.steps <= 200:
            raise ValueError("steps must be in 1..200")
        if not 1 <= self.batch_size <= 8:
            raise ValueError("batch_size must be in 1..8")
        if not 0 <= self.repaint_strength <= 1:
            raise ValueError("repaint_strength must be in 0..1")


@dataclass(frozen=True)
class TaskEntry:
    """One parsed item from a ``/query_result`` result string.

    ACE-Step can report the outer task as finished while an entry is still
    ``status=0`` with an empty ``file``; treat that as not ready yet.
    """

    file: str = ""
    status: int = 0
    seed_values: tuple[int, ...] = ()
    dit_model: str | None = None
    lm_model: str | None = None
    prompt: str = ""
    metas: dict[str, object] = field(default_factory=dict)

    @property
    def ready(self) -> bool:
        """Whether this entry has a finished audio file."""
        return self.status == 1 and bool(self.file)


@dataclass(frozen=True)
class TaskResult:
    """Polled state of one ACE-Step task.

    ``status`` is ACE-Step's integer: 0 queued/running, 1 succeeded, 2 failed.
    ``entries`` is non-empty only once the task succeeded.
    """

    task_id: str
    status: int
    entries: tuple[TaskEntry, ...] = ()

    @property
    def succeeded(self) -> bool:
        """Whether the task finished successfully."""
        return self.status == 1

    @property
    def ready(self) -> bool:
        """Whether every entry has a finished audio file."""
        return self.succeeded and bool(self.entries) and all(e.ready for e in self.entries)

    @property
    def failed(self) -> bool:
        """Whether the task failed."""
        return self.status == 2


@dataclass(frozen=True)
class ExtendOutput:
    """A finished extend: the downloaded audio plus what the server reported."""

    task_id: str
    audio: bytes
    entry: TaskEntry


def build_extend_payload(request: ExtendRequest) -> dict[str, object]:
    """Build the JSON body for ``POST /release_task`` (an extend/repaint).

    Kept separate from the transport so the mapping can be unit-tested against a
    fake server and inspected without a model.
    """
    return _repaint_payload(
        src_audio_path=request.src_audio_path,
        start_sec=request.repaint_start_sec,
        end_sec=request.repaint_end_sec,
        caption=request.caption,
        lyrics=request.lyrics,
        instrumental=request.instrumental,
        bpm=request.bpm,
        key_scale=request.key_scale,
        time_signature=request.time_signature,
        seed=request.seed,
        steps=request.steps,
        guidance_scale=request.guidance_scale,
        batch_size=request.batch_size,
        repaint_mode=request.repaint_mode,
        repaint_strength=request.repaint_strength,
        output_format=request.output_format,
        model=request.model,
    )


def build_repaint_payload(request: RepaintRequest) -> dict[str, object]:
    """Build the JSON body for a repaint with an explicit span (see :class:`RepaintRequest`)."""
    return _repaint_payload(
        src_audio_path=request.src_audio_path,
        start_sec=request.start_sec,
        end_sec=request.end_sec,
        caption=request.caption,
        lyrics=request.lyrics,
        instrumental=request.instrumental,
        bpm=request.bpm,
        key_scale=request.key_scale,
        time_signature=request.time_signature,
        seed=request.seed,
        steps=request.steps,
        guidance_scale=request.guidance_scale,
        batch_size=request.batch_size,
        repaint_mode=request.repaint_mode,
        repaint_strength=request.repaint_strength,
        output_format=request.output_format,
        model=request.model,
    )


def _repaint_payload(
    *,
    src_audio_path: str,
    start_sec: float,
    end_sec: float,
    caption: str,
    lyrics: str,
    instrumental: bool,
    bpm: int | None,
    key_scale: str,
    time_signature: str,
    seed: int | None,
    steps: int,
    guidance_scale: float,
    batch_size: int,
    repaint_mode: str,
    repaint_strength: float,
    output_format: AudioFormat,
    model: str | None,
) -> dict[str, object]:
    """The one payload both request types share."""
    payload: dict[str, object] = {
        "prompt": caption or "continue the music seamlessly",
        "lyrics": "" if instrumental else lyrics,
        "task_type": "repaint",
        "src_audio_path": src_audio_path,
        "repainting_start": round(start_sec, 3),
        "repainting_end": round(end_sec, 3),
        "chunk_mask_mode": "explicit",
        "repaint_mode": repaint_mode,
        "repaint_strength": repaint_strength,
        "inference_steps": steps,
        "guidance_scale": guidance_scale,
        "batch_size": batch_size,
        "audio_format": output_format,
        # Repaint never consults the LM; keep the request cheap and deterministic.
        "thinking": False,
        "use_cot_caption": False,
        "use_cot_language": False,
    }
    if bpm is not None:
        payload["bpm"] = bpm
    if key_scale:
        payload["key_scale"] = key_scale
    if time_signature:
        payload["time_signature"] = time_signature
    if model is not None:
        payload["model"] = model
    if seed is None:
        payload["use_random_seed"] = True
    else:
        payload["use_random_seed"] = False
        payload["seed"] = seed
    return payload


def _parse_int(value: object) -> int:
    """Parse an int that the API may encode as a string (``seed_value``)."""
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        return int(float(value.strip()))
    raise ValueError(f"expected an integer, got {value!r}")


def _parse_seeds(value: object) -> tuple[int, ...]:
    """Parse the comma-separated ``seed_value`` field."""
    if not isinstance(value, str) or not value.strip():
        return ()
    seeds: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if part:
            seeds.append(_parse_int(part))
    return tuple(seeds)


def _parse_entry(raw: object) -> TaskEntry:
    """Parse one ``result`` array item."""
    if not isinstance(raw, dict):
        raise AceStepError(f"unexpected result entry: {raw!r}")
    entry = raw
    file = entry.get("file")
    if file is not None and not isinstance(file, str):
        raise AceStepError(f"result entry has a bad audio file: {raw!r}")
    metas = entry.get("metas")
    dit_model = entry.get("dit_model")
    lm_model = entry.get("lm_model")
    prompt = entry.get("prompt")
    return TaskEntry(
        file=file or "",
        status=_parse_int(entry.get("status", 0)),
        seed_values=_parse_seeds(entry.get("seed_value")),
        dit_model=dit_model if isinstance(dit_model, str) else None,
        lm_model=lm_model if isinstance(lm_model, str) else None,
        prompt=prompt if isinstance(prompt, str) else "",
        metas=metas if isinstance(metas, dict) else {},
    )


def parse_task_result(task_id: str, data: object) -> TaskResult:
    """Parse the ``data`` of ``POST /query_result`` for one task."""
    if not isinstance(data, list):
        raise AceStepError(f"query_result data is not a list: {data!r}")
    for raw in data:
        if not isinstance(raw, dict):
            continue
        if raw.get("task_id") != task_id:
            continue
        status = _parse_int(raw.get("status", 0))
        result = raw.get("result")
        entries: tuple[TaskEntry, ...] = ()
        if isinstance(result, str) and result.strip():
            decoded: object = json.loads(result)
            if not isinstance(decoded, list):
                raise AceStepError(f"task result is not a list: {result!r}")
            entries = tuple(_parse_entry(item) for item in decoded)
        elif isinstance(result, list):
            entries = tuple(_parse_entry(item) for item in result)
        return TaskResult(task_id=task_id, status=status, entries=entries)
    raise AceStepError(f"task {task_id} is not in the query_result response")


class AceStepClient:
    """Blocking stdlib client for the local ACE-Step REST API."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, timeout_sec: float = 60.0) -> None:
        """Create a client; ``base_url`` may include a path prefix."""
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_sec

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, object] | None = None,
    ) -> object:
        """Send one request and return the unwrapped ``data`` field."""
        url = f"{self._base_url}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        # The base URL is operator configuration (local or a self-hosted ACE-Step),
        # not user input; still only allow HTTP(S) so a typo cannot become file://.
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise AceStepError(f"unsupported URL scheme in {url!r}")
        request = urllib.request.Request(  # noqa: S310 - scheme checked above
            url, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                raw: bytes = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise AceStepError(f"{method} {path} failed: HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise AceStepError(f"{method} {path} failed: {exc.reason}") from exc

        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AceStepError(f"{method} {path} returned invalid JSON") from exc
        if not isinstance(envelope, dict):
            raise AceStepError(f"{method} {path} returned a non-object envelope")
        code = envelope.get("code")
        if code != 200:
            raise AceStepError(f"{method} {path} failed: {envelope.get('error') or code}")
        return envelope.get("data")

    def health(self) -> Health:
        """Return the server health, or raise if it is unreachable."""
        data = self._request("GET", "/health")
        if not isinstance(data, dict):
            raise AceStepError("health returned no object")
        return Health(
            status=str(data.get("status", "")),
            service=str(data.get("service", "")),
            version=str(data.get("version", "")),
        )

    def init(self, *, model: str | None = None) -> None:
        """Load the DiT, VAE and text encoder (``POST /v1/init``).

        The server loads lazily, so the first generation pays the load; the warm-up
        ping (09 §5) makes it pay it before the user is waiting. ``model`` selects a
        DiT from the server's inventory; ``None`` keeps the server's default.
        """
        self._request("POST", "/v1/init", body={"model": model, "init_llm": False})

    def submit_extend(self, request: ExtendRequest) -> str:
        """Queue an extend and return its task id."""
        return self._submit(build_extend_payload(request))

    def submit_repaint(self, request: RepaintRequest) -> str:
        """Queue a repaint with an explicit span and return its task id."""
        return self._submit(build_repaint_payload(request))

    def _submit(self, payload: dict[str, object]) -> str:
        data = self._request("POST", "/release_task", body=payload)
        if not isinstance(data, dict):
            raise AceStepError("release_task returned no object")
        task_id = data.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise AceStepError("release_task returned no task_id")
        return task_id

    def task(self, task_id: str) -> TaskResult:
        """Query one task's current state."""
        data = self._request(
            "POST",
            "/query_result",
            body={"task_id_list": [task_id]},
        )
        return parse_task_result(task_id, data)

    def wait(
        self,
        task_id: str,
        *,
        poll_interval_sec: float = 1.0,
        timeout_sec: float = 600.0,
    ) -> TaskResult:
        """Poll until the task succeeds, fails, or ``timeout_sec`` elapses."""
        deadline = time.monotonic() + timeout_sec
        while True:
            result = self.task(task_id)
            if result.ready:
                return result
            if result.failed:
                raise AceStepError(f"task {task_id} failed on the server")
            if time.monotonic() >= deadline:
                raise AceStepError(f"task {task_id} did not finish within {timeout_sec:.0f}s")
            time.sleep(poll_interval_sec)

    def download(self, audio_path: str) -> bytes:
        """Download a returned ``file`` URL (an absolute or relative path)."""
        url = urllib.parse.urljoin(f"{self._base_url}/", audio_path.lstrip("/"))
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise AceStepError(f"unsupported URL scheme in {url!r}")
        try:
            with urllib.request.urlopen(url, timeout=self._timeout) as response:  # noqa: S310
                return bytes(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise AceStepError(f"download failed: HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise AceStepError(f"download failed: {exc.reason}") from exc

    def extend(
        self,
        request: ExtendRequest,
        output_path: str | Path,
        *,
        poll_interval_sec: float = 1.0,
        timeout_sec: float = 600.0,
    ) -> ExtendOutput:
        """Run one extend to completion and write the audio to ``output_path``."""
        return self._finish(
            self.submit_extend(request),
            output_path,
            poll_interval_sec=poll_interval_sec,
            timeout_sec=timeout_sec,
        )

    def repaint(
        self,
        request: RepaintRequest,
        output_path: str | Path,
        *,
        poll_interval_sec: float = 1.0,
        timeout_sec: float = 600.0,
    ) -> ExtendOutput:
        """Run one explicit-span repaint to completion and write its audio."""
        return self._finish(
            self.submit_repaint(request),
            output_path,
            poll_interval_sec=poll_interval_sec,
            timeout_sec=timeout_sec,
        )

    def _finish(
        self,
        task_id: str,
        output_path: str | Path,
        *,
        poll_interval_sec: float,
        timeout_sec: float,
    ) -> ExtendOutput:
        """Wait for a submitted task, download its first file and return it."""
        result = self.wait(
            task_id,
            poll_interval_sec=poll_interval_sec,
            timeout_sec=timeout_sec,
        )
        if not result.entries:
            raise AceStepError(f"task {task_id} succeeded without an audio file")
        entry = result.entries[0]
        audio = self.download(entry.file)
        Path(output_path).write_bytes(audio)
        return ExtendOutput(task_id=task_id, audio=audio, entry=entry)
