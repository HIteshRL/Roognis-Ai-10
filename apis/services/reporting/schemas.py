from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PolicyParameters(BaseModel):
    """Changeable calculation controls, deliberately bounded and auditable."""

    model_config = ConfigDict(extra="forbid")

    minimum_evidence_count: int = Field(default=2, ge=1, le=100)
    minimum_confidence: float = Field(default=0.45, ge=0, le=1)
    gap_score_threshold: float = Field(default=0.45, ge=0, le=1)
    strength_mastery_threshold: float = Field(default=0.75, ge=0, le=1)
    stale_after_days: int = Field(default=30, ge=1, le=365)
    maximum_concepts: int = Field(default=5, ge=1, le=12)


class PolicyUpdate(BaseModel):
    parameters: PolicyParameters
    updated_by: str = Field(min_length=1, max_length=120)

    model_config = ConfigDict(extra="forbid")


class PolicyView(BaseModel):
    version: int
    parameters: PolicyParameters
    updated_at: datetime

    model_config = ConfigDict()
