# ─────────────────────────────────────────────────────────────────────────────
# CurriculumContentPublished — a versioned signal that a chapter's teachable
# content changed, plus the deterministic Knowledge-Graph topology it implies.
#
# Retention plan §1:
#   - Neo4j owns curriculum topology.
#   - A chapter update mints a NEW curriculumVersion rather than rewriting the
#     meaning of historical evidence. Old evidence keeps the version it was
#     generated under.
#   - Concept nodes land as `proposed` and are inert until a deterministic
#     validation or a teacher's quiz approval promotes them to `active`
#     (services/quiz/server.js → syncApprovedQuizToKg).
#
# Everything here is a pure function of the chapter's identity, its extracted
# entities, and its content fingerprint. No LLM influences the version, the node
# ids, or the edges.
# ─────────────────────────────────────────────────────────────────────────────
from __future__ import annotations

import hashlib
import json
import logging
import re
from urllib import parse as urlparse
from urllib import request as urlrequest
from urllib.error import URLError

CURRICULUM_EVENT_SCHEMA_VERSION = 1
CURRICULUM_EVENT_TYPE = "CurriculumContentPublished"
MAX_CHAPTER_CONCEPTS = 250

logger = logging.getLogger("rag.curriculum_publish")

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(value: object) -> str:
    return _SLUG_RE.sub("-", str(value).strip().casefold()).strip("-") or "na"


def curriculum_version(identity_key: tuple, content_fingerprint: str) -> str:
    """Stable while the chapter's identity and chunk content are unchanged.

    A re-ingest that changes chunk text changes `content_fingerprint` and
    therefore the version, so historical evidence stamped with the old version
    is never silently reinterpreted against new content.
    """
    digest = hashlib.sha256()
    digest.update(json.dumps([str(part) for part in identity_key], separators=(",", ":")).encode("utf-8"))
    digest.update(b"\0")
    digest.update((content_fingerprint or "").encode("utf-8"))
    return "cv1-" + digest.hexdigest()[:20]


def _grade_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and 1 <= value <= 12 else None


def chapter_node_id(event: dict) -> str:
    parts = [
        event["schoolId"], event["board"], event["curriculum"], event["grade"],
        event["subject"], event["book"], event["chapterNumber"],
        event["language"], event["edition"],
    ]
    return "chapter:" + ":".join(_slug(part) for part in parts)


def build_curriculum_published_event(
    chapter_summary: dict, *, version: str, concepts: list[dict]
) -> dict:
    """`concepts` is an iterable of {conceptId, label}. Output ordering is
    deterministic so two ingests of identical content produce an identical
    event (and identical downstream KG writes)."""
    ordered: list[dict] = []
    seen: set[str] = set()
    for concept in sorted(
        (c for c in concepts if c.get("conceptId")),
        key=lambda c: str(c["conceptId"]),
    ):
        concept_id = str(concept["conceptId"])
        if concept_id in seen:
            continue
        seen.add(concept_id)
        ordered.append({"conceptId": concept_id, "label": (concept.get("label") or "Concept")[:240]})
        if len(ordered) >= MAX_CHAPTER_CONCEPTS:
            break
    return {
        "schemaVersion": CURRICULUM_EVENT_SCHEMA_VERSION,
        "eventType": CURRICULUM_EVENT_TYPE,
        "schoolId": chapter_summary["schoolId"],
        "board": chapter_summary["board"],
        "curriculum": chapter_summary["curriculum"],
        "grade": chapter_summary["grade"],
        "subject": chapter_summary["subject"],
        "book": chapter_summary["book"],
        "chapterNumber": chapter_summary["chapterNumber"],
        "chapterName": chapter_summary["chapterName"],
        "language": chapter_summary["language"],
        "edition": chapter_summary["edition"],
        "curriculumVersion": version,
        "contentFingerprint": chapter_summary["contentFingerprint"],
        "documentIds": list(chapter_summary.get("documentIds", [])),
        "concepts": ordered,
    }


def curriculum_graph_operations(event: dict) -> list[dict]:
    """Ordered KG writes implied by the event.

    The chapter is a `Taxonomy` node; each concept a `Concept`; containment is
    `IN_TAXONOMY` (the closed KG relationship union has no dedicated
    CHAPTER_CONTAINS_CONCEPT — taxonomy membership is the same statement). Every
    node and edge is `proposed`: activation is a human decision, not a
    side-effect of ingestion.
    """
    chapter_id = chapter_node_id(event)
    curriculum_fields = {
        "board": event["board"],
        "curriculum": event["curriculum"],
        "grade": _grade_or_none(event["grade"]),
        "subject": event["subject"],
        "chapter": event["chapterName"],
    }
    ops: list[dict] = [{
        "op": "upsert_node",
        "node": {
            "nodeId": chapter_id,
            "kind": "Taxonomy",
            "label": f"{event['subject']} · {event['chapterName']}"[:240],
            "status": "proposed",
            **curriculum_fields,
            "metadata": {
                "source": "rag_curriculum_publish",
                "curriculumVersion": event["curriculumVersion"],
                "contentFingerprint": event["contentFingerprint"],
                "documentIds": event["documentIds"],
            },
        },
    }]
    for concept in event["concepts"]:
        ops.append({
            "op": "upsert_node",
            "node": {
                "nodeId": concept["conceptId"],
                "kind": "Concept",
                "label": concept["label"],
                "status": "proposed",
                **curriculum_fields,
                "metadata": {
                    "source": "rag_curriculum_publish",
                    "curriculumVersion": event["curriculumVersion"],
                },
            },
        })
        ops.append({
            "op": "link",
            "relationship": {
                "fromNodeId": concept["conceptId"],
                "toNodeId": chapter_id,
                "relationship": "IN_TAXONOMY",
                "status": "proposed",
                "evidenceRef": f"curriculum:{event['curriculumVersion']}"[:240],
            },
        })
    return ops


def _send(url: str, method: str, body: dict, headers: dict, timeout: float) -> None:
    request = urlrequest.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method=method,
        headers={"Content-Type": "application/json", **headers},
    )
    with urlrequest.urlopen(request, timeout=timeout) as response:
        if response.status >= 300:
            raise URLError(f"{method} {url} returned {response.status}")


def deliver_curriculum_graph(
    event: dict, *, kg_service_url: str, internal_service_token: str, timeout: float = 3.0
) -> bool:
    """Best-effort delivery, mirroring notify_quiz_service_chapter_ready.

    KG upserts are idempotent, so a missed delivery is repaired by the next
    ingest of the same chapter. A durable outbox + claim-worker is the planned
    hardening (retention plan §8) and is tracked in HANDOFF.
    """
    if not kg_service_url or not internal_service_token:
        return False
    base = kg_service_url.rstrip("/")
    headers = {"X-Internal-Service-Token": internal_service_token}
    try:
        for operation in curriculum_graph_operations(event):
            if operation["op"] == "upsert_node":
                node = operation["node"]
                _send(
                    f"{base}/api/kg/v1/nodes/{urlparse.quote(node['nodeId'], safe='')}",
                    "PUT", node, headers, timeout,
                )
            else:
                _send(f"{base}/api/kg/v1/relationships", "POST", operation["relationship"], headers, timeout)
        return True
    except (OSError, URLError, ValueError) as exc:
        logger.warning("curriculum graph delivery failed: %s", exc)
        return False
