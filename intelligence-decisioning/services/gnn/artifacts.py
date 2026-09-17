from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True)
class ModelArtifact:
    model_version: str
    promoted: bool
    seed: int
    metrics: dict
    promoted_at: datetime | None = None
    weights: dict | None = None
    lane: str | None = None
    architecture: str | None = None
    rejected_reason: str | None = None


# `trainingMethod` is an OPTIMIZER tag; it cannot tell a v1 preference model
# from a v2 one trained the same way. Without a separate architecture stamp a
# stale artifact loads, fails restore() deep inside model construction, and is
# silently swapped for the bootstrap — indistinguishable to an operator from
# "no model configured at all".
EXPECTED_ARCHITECTURE = {
    "preference": "preference-hetero-signed-v1",
    "knowledge": "knowledge-temporal-v1",
}


BOOTSTRAP_ARTIFACT = ModelArtifact(
    model_version="bootstrap-unpromoted-v1",
    promoted=False,
    seed=1729,
    metrics={},
)


def load_artifact(path: str) -> ModelArtifact:
    if not path:
        return BOOTSTRAP_ARTIFACT
    file_path = Path(path)
    if not file_path.is_file():
        return BOOTSTRAP_ARTIFACT
    value = json.loads(file_path.read_text(encoding="utf-8"))
    lane = value.get("lane")
    architecture = value.get("architecture")
    claims_promoted = bool(
        value.get("promoted", False)
        and value.get("weights")
        and value.get("trainingMethod") == "spsa-v1"
    )
    expected = EXPECTED_ARCHITECTURE.get(lane) if lane else None
    architecture_ok = expected is None or architecture == expected

    reason = None
    if not claims_promoted:
        reason = "unpromoted_or_untrained"
    elif not architecture_ok:
        # Readable for audit, never loaded into a model.
        reason = f"architecture_mismatch:{architecture or 'absent'}"

    return ModelArtifact(
        model_version=str(value["modelVersion"]),
        promoted=claims_promoted and architecture_ok,
        seed=int(value.get("seed", 1729)),
        metrics=dict(value.get("metrics") or {}),
        promoted_at=datetime.fromisoformat(value["promotedAt"].replace("Z", "+00:00")) if value.get("promotedAt") else None,
        weights=value.get("weights") if architecture_ok else None,
        lane=lane,
        architecture=architecture,
        rejected_reason=reason,
    )


def can_promote(metrics: dict) -> bool:
    candidate = float(metrics.get("candidateMetric", 0))
    baseline = float(metrics.get("baselineMetric", 0))
    candidate_calibration = float(metrics.get("candidateCalibration", 1))
    baseline_calibration = float(metrics.get("baselineCalibration", 1))
    held_out = int(metrics.get("heldOutEvents", 0))
    # A random-looking improvement on a handful of events is not evidence that
    # a model should control a student's experience. Until the daily corpus has
    # a minimally useful held-out set, inference remains on the deterministic
    # baseline even if the candidate happens to score better.
    return held_out >= 20 and candidate > baseline and candidate_calibration <= baseline_calibration
