"""Create a promoted model manifest only when held-out metrics beat baseline."""

import argparse
import json
import os
from pathlib import Path
import tempfile
from datetime import datetime, timezone

from artifacts import EXPECTED_ARCHITECTURE, can_promote


def promote_candidate(metrics: dict, output: Path, *, model_version: str, seed: int, weights: dict | None = None, lane: str | None = None) -> bool:
    if (not weights or lane not in {"knowledge", "preference"}
            or not metrics.get("independentSplit") or not metrics.get("trained")
            or not metrics.get("weightsChanged") or metrics.get("heldOutPositive", 0) < 5
            or metrics.get("heldOutNegative", 0) < 5 or not can_promote(metrics)):
        return False
    value = {
        "modelVersion": model_version,
        "promoted": True,
        "seed": seed,
        "metrics": metrics,
        "promotedAt": datetime.now(timezone.utc).isoformat(),
        "weights": weights,
        "lane": lane,
        "trainingMethod": "spsa-v1",
        # Optimizer and architecture are different facts. Stamping both is what
        # lets a loader reject a model trained the same way against a different
        # network shape, instead of discovering the mismatch inside restore().
        "architecture": EXPECTED_ARCHITECTURE[lane],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file():
        previous = output.with_suffix(output.suffix + ".previous")
        with tempfile.NamedTemporaryFile("wb", dir=output.parent, delete=False) as backup_handle:
            backup_handle.write(output.read_bytes())
            backup_handle.flush()
            os.fsync(backup_handle.fileno())
            backup_temporary = backup_handle.name
        os.replace(backup_temporary, previous)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, delete=False) as handle:
        handle.write(json.dumps(value, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        temporary = handle.name
    os.replace(temporary, output)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("metrics")
    parser.add_argument("output")
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--seed", type=int, default=1729)
    args = parser.parse_args()

    metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))
    if not promote_candidate(metrics, Path(args.output), model_version=args.model_version, seed=args.seed):
        raise SystemExit("Candidate model did not beat the deterministic baseline and calibration gates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
