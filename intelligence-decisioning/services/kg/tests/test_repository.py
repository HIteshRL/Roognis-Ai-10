import pytest
from pydantic import ValidationError

from repository import MemoryGraphRepository
from schemas import GraphNodeInput, GraphRelationshipInput

# Activating a node or edge now requires naming the flow that authorised it.
APPROVED = {"activation": "teacher_quiz_approval"}


def test_only_active_nodes_and_edges_enter_the_default_subgraph():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="concept.fractions", kind="Concept", label="Fractions", status="active", metadata=APPROVED))
    repo.upsert_node(GraphNodeInput(nodeId="concept.decimals", kind="Concept", label="Decimals", status="active", metadata=APPROVED))
    repo.link(GraphRelationshipInput(
        fromNodeId="concept.fractions",
        toNodeId="concept.decimals",
        relationship="PREREQUISITE_OF",
        status="active",
        activation="teacher_quiz_approval",
    ))
    graph = repo.subgraph(["concept.fractions"])
    assert len(graph["nodes"]) == 2
    assert graph["edges"][0]["relationship"] == "PREREQUISITE_OF"


def test_proposed_relationships_are_not_measurement_graph_edges():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="item.1", kind="AssessmentItem", label="Question 1", status="active", metadata=APPROVED))
    repo.upsert_node(GraphNodeInput(nodeId="concept.1", kind="Concept", label="Concept", status="active", metadata=APPROVED))
    repo.link(GraphRelationshipInput(fromNodeId="item.1", toNodeId="concept.1", relationship="MEASURES"))
    assert repo.subgraph(["concept.1"])["edges"] == []


def test_active_isolated_concept_is_distinct_from_unknown_concept():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="concept.known", kind="Concept", label="Known", status="active", metadata=APPROVED))
    assert [node["nodeId"] for node in repo.subgraph(["concept.known"])["nodes"]] == ["concept.known"]
    assert repo.subgraph(["concept.unknown"])["nodes"] == []


def test_active_subgraph_never_returns_an_edge_to_a_proposed_node():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="concept.active", kind="Concept", label="Active", status="active", metadata=APPROVED))
    repo.upsert_node(GraphNodeInput(nodeId="concept.proposed", kind="Concept", label="Proposed", status="proposed"))
    repo.link(GraphRelationshipInput(
        fromNodeId="concept.active",
        toNodeId="concept.proposed",
        relationship="SIBLING_OF",
        status="active",
        activation="teacher_quiz_approval",
    ))
    graph = repo.subgraph(["concept.active"])
    assert [node["nodeId"] for node in graph["nodes"]] == ["concept.active"]
    assert graph["edges"] == []


def test_an_active_node_must_name_the_flow_that_activated_it():
    """The validator used to be named this and return its input unchanged, so any
    holder of INTERNAL_SERVICE_TOKEN could publish a concept as curriculum."""
    with pytest.raises(ValidationError):
        GraphNodeInput(nodeId="concept.smuggled", kind="Concept", label="Smuggled", status="active")
    with pytest.raises(ValidationError):
        GraphNodeInput(nodeId="concept.smuggled", kind="Concept", label="Smuggled",
                       status="active", metadata={"activation": "i-said-so"})
    # Proposing is always allowed; that is the LLM-reachable half of the flow.
    assert GraphNodeInput(nodeId="concept.proposed", kind="Concept", label="Proposed").status == "proposed"


def test_an_active_relationship_must_name_the_flow_that_activated_it():
    with pytest.raises(ValidationError):
        GraphRelationshipInput(fromNodeId="a.one", toNodeId="b.two",
                               relationship="PREREQUISITE_OF", status="active")


def test_relationships_cannot_join_node_kinds_they_may_not_join():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="misconception.1", kind="Misconception",
                                    label="Confuses area and perimeter", status="active", metadata=APPROVED))
    repo.upsert_node(GraphNodeInput(nodeId="concept.area", kind="Concept",
                                    label="Area", status="active", metadata=APPROVED))
    # A misconception is not a prerequisite of anything.
    with pytest.raises(ValueError, match="PREREQUISITE_OF"):
        repo.link(GraphRelationshipInput(fromNodeId="misconception.1", toNodeId="concept.area",
                                         relationship="PREREQUISITE_OF"))
    # But it is a legitimate distractor for one.
    edge = repo.link(GraphRelationshipInput(fromNodeId="misconception.1", toNodeId="concept.area",
                                            relationship="DISTRACTOR_FOR"))
    assert edge["relationship"] == "DISTRACTOR_FOR"


def test_measures_runs_from_assessment_item_to_concept_not_the_reverse():
    repo = MemoryGraphRepository()
    repo.upsert_node(GraphNodeInput(nodeId="item.9", kind="AssessmentItem", label="Q9",
                                    status="active", metadata=APPROVED))
    repo.upsert_node(GraphNodeInput(nodeId="concept.9", kind="Concept", label="C9",
                                    status="active", metadata=APPROVED))
    with pytest.raises(ValueError, match="MEASURES"):
        repo.link(GraphRelationshipInput(fromNodeId="concept.9", toNodeId="item.9",
                                         relationship="MEASURES"))
    assert repo.link(GraphRelationshipInput(fromNodeId="item.9", toNodeId="concept.9",
                                            relationship="MEASURES"))["relationship"] == "MEASURES"
