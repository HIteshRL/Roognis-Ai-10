import re

from curriculum_publish import (
    build_curriculum_published_event,
    chapter_node_id,
    curriculum_graph_operations,
    curriculum_version,
    deliver_curriculum_graph,
)

# The closed unions KG accepts (services/kg/schemas.py). Kept here as literals so
# a drift in either service is caught by this test rather than at runtime.
KG_NODE_KINDS = {"Concept", "Misconception", "AssessmentItem", "Taxonomy"}
KG_RELATIONSHIPS = {"PREREQUISITE_OF", "SIBLING_OF", "MEASURES", "DISTRACTOR_FOR", "IN_TAXONOMY"}
KG_NODE_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]+$")

IDENTITY = ("school-1", "cbse", "ncert", 7, "science", "book-a", 3, "en", "2026-27")


def summary(**overrides):
    base = {
        "schoolId": "school-1", "board": "CBSE", "curriculum": "NCERT", "grade": 7,
        "subject": "Science", "book": "Book A", "chapterNumber": 3,
        "chapterName": "Heat", "language": "EN", "edition": "2026-27",
        "documentIds": ["doc-1", "doc-2"], "contentFingerprint": "fp-aaa",
    }
    base.update(overrides)
    return base


def test_curriculum_version_is_deterministic_and_content_sensitive():
    a = curriculum_version(IDENTITY, "fingerprint-1")
    assert a == curriculum_version(IDENTITY, "fingerprint-1")
    assert a != curriculum_version(IDENTITY, "fingerprint-2")
    assert a != curriculum_version(("school-1", "cbse", "ncert", 8, *IDENTITY[4:]), "fingerprint-1")
    assert a.startswith("cv1-")


def test_event_carries_every_section_1_field():
    event = build_curriculum_published_event(
        summary(), version="cv1-xyz",
        concepts=[{"conceptId": "c-2", "label": "B"}, {"conceptId": "c-1", "label": "A"}],
    )
    assert event["schemaVersion"] == 1
    assert event["eventType"] == "CurriculumContentPublished"
    for field in ("schoolId", "board", "curriculum", "grade", "subject", "book",
                  "chapterNumber", "chapterName", "language", "edition",
                  "curriculumVersion", "contentFingerprint", "documentIds"):
        assert field in event
    # Deterministic ordering regardless of input order.
    assert [c["conceptId"] for c in event["concepts"]] == ["c-1", "c-2"]


def test_event_dedupes_and_caps_concepts():
    concepts = [{"conceptId": f"c-{n}", "label": "x"} for n in range(400)] + [{"conceptId": "c-1", "label": "dup"}]
    event = build_curriculum_published_event(summary(), version="cv1-x", concepts=concepts)
    ids = [c["conceptId"] for c in event["concepts"]]
    assert len(ids) == len(set(ids)) <= 250


def test_graph_operations_are_all_proposed_and_valid_for_kg():
    event = build_curriculum_published_event(
        summary(grade=99), version="cv1-x",
        concepts=[{"conceptId": "11111111-1111-1111-1111-111111111111", "label": "Conduction"}],
    )
    ops = curriculum_graph_operations(event)
    assert ops[0]["op"] == "upsert_node" and ops[0]["node"]["kind"] == "Taxonomy"
    for op in ops:
        if op["op"] == "upsert_node":
            node = op["node"]
            assert node["kind"] in KG_NODE_KINDS
            assert node["status"] == "proposed"
            assert KG_NODE_ID_RE.match(node["nodeId"]), node["nodeId"]
            assert node["grade"] is None  # 99 is out of the KG 1..12 range
        else:
            rel = op["relationship"]
            assert rel["relationship"] in KG_RELATIONSHIPS
            assert rel["status"] == "proposed"
            assert rel["relationship"] == "IN_TAXONOMY"
            assert rel["toNodeId"] == chapter_node_id(event)
            assert rel["fromNodeId"] == "11111111-1111-1111-1111-111111111111"


def test_delivery_is_a_noop_without_configuration():
    event = build_curriculum_published_event(summary(), version="cv1-x", concepts=[])
    assert deliver_curriculum_graph(event, kg_service_url="", internal_service_token="") is False
    assert deliver_curriculum_graph(event, kg_service_url="http://kg", internal_service_token="") is False
