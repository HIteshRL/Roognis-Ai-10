from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


NodeKind = Literal["Concept", "Misconception", "AssessmentItem", "Taxonomy"]
RelationshipKind = Literal["PREREQUISITE_OF", "SIBLING_OF", "MEASURES", "DISTRACTOR_FOR", "IN_TAXONOMY"]

# An LLM may PROPOSE a concept mapping; only a deterministic, human-gated flow
# may ACTIVATE it. These are the flows entitled to do so, and a node or edge that
# claims `active` must name the one that authorised it.
#
#   teacher_quiz_approval  — services/quiz syncApprovedQuizToKg, reachable only
#                            from POST /quizzes/:id/approve after approvalDecision.
#   lms_curriculum_publish — services/lms publish_chapter_version, which requires
#                            curriculum_mapping_status == "approved".
#
# This gate is enforced here rather than trusted to callers because /api/kg
# routes are Traefik-reachable and guarded only by INTERNAL_SERVICE_TOKEN, so
# the token holder — not the approval flow — would otherwise decide what is real.
ACTIVATION_AUTHORITIES = frozenset({"teacher_quiz_approval", "lms_curriculum_publish"})

# Which node kinds may sit at each end of a relationship. Without this, nothing
# stopped a Misconception being the target of PREREQUISITE_OF, or an
# AssessmentItem being filed IN_TAXONOMY.
RELATIONSHIP_ENDPOINTS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "PREREQUISITE_OF": (frozenset({"Concept"}), frozenset({"Concept"})),
    "SIBLING_OF": (frozenset({"Concept"}), frozenset({"Concept"})),
    "MEASURES": (frozenset({"AssessmentItem"}), frozenset({"Concept"})),
    "DISTRACTOR_FOR": (frozenset({"Misconception"}), frozenset({"Concept"})),
    "IN_TAXONOMY": (frozenset({"Concept", "AssessmentItem"}), frozenset({"Taxonomy"})),
}


def assert_valid_endpoints(relationship: str, from_kind: str, to_kind: str) -> None:
    """Raise ValueError if a relationship joins node kinds it may not join."""
    allowed = RELATIONSHIP_ENDPOINTS.get(relationship)
    if not allowed:
        raise ValueError(f"Unknown relationship {relationship}.")
    from_allowed, to_allowed = allowed
    if from_kind not in from_allowed or to_kind not in to_allowed:
        raise ValueError(
            f"{relationship} may only link "
            f"{'|'.join(sorted(from_allowed))} -> {'|'.join(sorted(to_allowed))}, "
            f"not {from_kind} -> {to_kind}."
        )


class GraphNodeInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    node_id: str = Field(alias="nodeId", min_length=2, max_length=160, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]+$")
    kind: NodeKind
    label: str = Field(min_length=1, max_length=240)
    status: Literal["proposed", "active", "retired"] = "proposed"
    board: str | None = Field(default=None, max_length=40)
    curriculum: str | None = Field(default=None, max_length=80)
    grade: int | None = Field(default=None, ge=1, le=12)
    subject: str | None = Field(default=None, max_length=80)
    chapter: str | None = Field(default=None, max_length=220)
    metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def only_validated_nodes_become_active(self) -> "GraphNodeInput":
        if self.status != "active":
            return self
        activation = self.metadata.get("activation")
        if activation not in ACTIVATION_AUTHORITIES:
            raise ValueError(
                "An active node must record the flow that activated it as "
                f"metadata.activation, one of {sorted(ACTIVATION_AUTHORITIES)}; "
                f"got {activation!r}."
            )
        return self


class GraphRelationshipInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    from_node_id: str = Field(alias="fromNodeId", min_length=2, max_length=160)
    to_node_id: str = Field(alias="toNodeId", min_length=2, max_length=160)
    relationship: RelationshipKind
    status: Literal["proposed", "active"] = "proposed"
    evidence_ref: str | None = Field(default=None, alias="evidenceRef", max_length=240)
    activation: str | None = Field(default=None, max_length=60)

    @model_validator(mode="after")
    def only_validated_edges_become_active(self) -> "GraphRelationshipInput":
        if self.status == "active" and self.activation not in ACTIVATION_AUTHORITIES:
            raise ValueError(
                "An active relationship must name the flow that activated it as "
                f"`activation`, one of {sorted(ACTIVATION_AUTHORITIES)}; "
                f"got {self.activation!r}."
            )
        return self


class SubgraphRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    node_ids: list[str] = Field(alias="nodeIds", min_length=1, max_length=500)
    active_only: bool = Field(default=True, alias="activeOnly")
