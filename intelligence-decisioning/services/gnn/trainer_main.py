from pathlib import Path
import fcntl
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from auth import require_internal_token
from config import Settings, get_settings
from pretrain import pretrain_and_promote


class TrainingRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    lane: Literal["preference", "knowledge"]
    model_version: str = Field(alias="modelVersion", min_length=3, max_length=80)
    samples: list[dict] = Field(min_length=1, max_length=5000)


app = FastAPI(title="Roognis GNN Pretraining Worker")


@app.get("/health")
def health(settings: Settings = Depends(get_settings)):
    return {"status": "ok", "service": "gnn-trainer", "lane": settings.gnn_lane}


@app.post("/internal/gnn/v1/train")
def train(
    body: TrainingRequest,
    _: None = Depends(require_internal_token),
    settings: Settings = Depends(get_settings),
):
    if body.lane != settings.gnn_lane:
        raise HTTPException(status_code=409, detail="Training lane does not match this isolated worker.")
    if not settings.gnn_model_artifact:
        raise HTTPException(status_code=500, detail="Model artifact output is not configured.")
    path = Path(settings.gnn_model_artifact)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Shared artifact-volume lock also covers overlapping daily runs/replicas.
    with path.with_suffix('.training.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(status_code=409, detail="Training already in progress")
        return pretrain_and_promote(
        lane=body.lane,
        samples=body.samples,
        output=Path(settings.gnn_model_artifact),
        model_version=body.model_version,
        initial_seed=1729 if body.lane == "preference" else 1830,
    )
