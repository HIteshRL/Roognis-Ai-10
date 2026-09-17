from pydantic import BaseModel, ConfigDict, Field
from typing import Annotated, Literal

BoundedFeature = Annotated[float, Field(ge=-10, le=10, allow_inf_nan=False)]

# ── Preference lane v2: heterogeneous and signed ────────────────────────────
#
# v1 flattened genres, entities, articles and videos into one `topics[]` list
# and smuggled the node type into features[3] as a magic number, so message
# passing was homogeneous and untyped. Sign was applied only at the final
# pooling step, which means it never affected aggregation — a "signed" model
# that could not tell a friend-of-enemy from a friend-of-friend.
#
# Node type and edge sign are now first-class. Both are derived deterministically
# by services/discover (from the node's own kind and from signalWeight's sign);
# a model never chooses either.
PreferenceNodeType = Literal["student", "topic", "article", "video"]
PreferenceRelationship = Literal[
    "STUDENT_PREFERS",   # student → topic     (explicit stance or promoted inference)
    "STUDENT_ENGAGED",   # student → article|video
    "CONTENT_COVERS",    # article|video → topic
    "TOPIC_CO_OCCURS",   # topic ↔ topic       (symmetric)
    "GENRE_CONTAINS",    # topic(genre) → topic
    "TOPIC_MENTIONS",    # topic → topic(entity)
]


class PreferenceNode(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    node_id: str = Field(alias="nodeId", min_length=1, max_length=200)
    node_type: PreferenceNodeType = Field(alias="nodeType")
    features: list[BoundedFeature] = Field(min_length=1, max_length=4)
    # Only topics carry a baseline; it is the deterministic score the decision
    # layer blends against, and the model must not invent one for other types.
    baseline_score: float = Field(default=0, alias="baselineScore", ge=-1, le=1)


class PreferenceEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    from_id: str = Field(alias="fromId", min_length=1, max_length=200)
    to_id: str = Field(alias="toId", min_length=1, max_length=200)
    relationship: PreferenceRelationship
    sign: Literal[-1, 1] = 1
    weight: float = Field(default=1, gt=0, le=10)


class PreferenceScoreRequest(BaseModel):
    # extra="forbid" is load-bearing: without it a caller still sending the v1
    # body would have `topics`/`interactions` silently dropped and every student
    # would score against an empty graph, which looks like a working deployment.
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    student_id: str = Field(alias="studentId")
    graph_version: Literal["pref-hetero-v1"] = Field(alias="graphVersion")
    nodes: list[PreferenceNode] = Field(min_length=1, max_length=2000)
    edges: list[PreferenceEdge] = Field(default_factory=list, max_length=20000)


class GraphEdge(BaseModel):
    """Knowledge-lane edge. Unchanged — the knowledge lane does not move here."""
    model_config = ConfigDict(populate_by_name=True)
    from_id: str = Field(alias="fromId")
    to_id: str = Field(alias="toId")
    relationship: str = "PREREQUISITE"


class KnowledgeConcept(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    concept_id: str = Field(alias="conceptId")
    # mastery, recall-now, readiness, confidence, theta, theta uncertainty
    features: list[BoundedFeature] = Field(min_length=1, max_length=6)
    baseline_mastery: float = Field(default=0.25, alias="baselineMastery", ge=0, le=1)


class KnowledgeEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    concept_id: str = Field(alias="conceptId")
    outcome: float = Field(ge=0, le=1)
    weight: float = Field(gt=0, le=2)
    difficulty: float = Field(default=0.5, ge=0, le=1)
    observed_at: float | None = Field(default=None, alias="observedAt", ge=0, allow_inf_nan=False)


class KnowledgeScoreRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    student_id: str = Field(alias="studentId")
    concepts: list[KnowledgeConcept] = Field(min_length=1, max_length=1000)
    events: list[KnowledgeEvent] = Field(default_factory=list, max_length=10000)
    edges: list[GraphEdge] = Field(default_factory=list, max_length=10000)
