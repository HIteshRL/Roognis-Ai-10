from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelScore(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    eligible: bool = False
    confidence: float = Field(default=0, ge=0, le=1)
    value: float = Field(ge=0, le=1)
    model_version: str | None = Field(default=None, alias="modelVersion")
    evidence_ids: list[str] = Field(default_factory=list, alias="evidenceIds", max_length=200)


class PreferenceDecisionInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    topic_id: str = Field(alias="topicId")
    baseline_affinity: float = Field(alias="baselineAffinity", ge=-1, le=1)
    gnn_affinity: float | None = Field(default=None, alias="gnnAffinity", ge=-1, le=1)
    gnn_eligible: bool = Field(default=False, alias="gnnEligible")
    gnn_confidence: float = Field(default=0, alias="gnnConfidence", ge=0, le=1)
    model_version: str | None = Field(default=None, alias="modelVersion")
    hard_stance: Literal["LIKE", "DISLIKE", "MUTE"] | None = Field(default=None, alias="hardStance")
    evidence_ids: list[str] = Field(default_factory=list, alias="evidenceIds", max_length=200)


class KnowledgeDecisionInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    concept_id: str = Field(alias="conceptId")
    baseline_mastery: float = Field(alias="baselineMastery", ge=0, le=1)
    baseline_readiness: float = Field(alias="baselineReadiness", ge=0, le=1)
    gnn_mastery: float | None = Field(default=None, alias="gnnMastery", ge=0, le=1)
    gnn_readiness: float | None = Field(default=None, alias="gnnReadiness", ge=0, le=1)
    gnn_eligible: bool = Field(default=False, alias="gnnEligible")
    gnn_confidence: float = Field(default=0, alias="gnnConfidence", ge=0, le=1)
    model_version: str | None = Field(default=None, alias="modelVersion")
    current_difficulty: Literal["simple", "medium", "hard"] = Field(default="medium", alias="currentDifficulty")
    evidence_ids: list[str] = Field(default_factory=list, alias="evidenceIds", max_length=200)
