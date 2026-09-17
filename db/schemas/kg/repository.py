from __future__ import annotations

import json
from typing import Protocol

from neo4j import GraphDatabase

from schemas import GraphNodeInput, GraphRelationshipInput, assert_valid_endpoints


def public_node(properties: dict) -> dict:
    """Keep the Neo4j and in-memory wire contracts identical."""
    node = dict(properties)
    node["metadata"] = json.loads(node.pop("metadataJson", "{}"))
    if node.get("updatedAt") is not None:
        node["updatedAt"] = node["updatedAt"].iso_format()
    return node


class GraphRepository(Protocol):
    def health(self) -> bool: ...
    def ensure_schema(self) -> None: ...
    def upsert_node(self, item: GraphNodeInput) -> dict: ...
    def get_node(self, node_id: str) -> dict | None: ...
    def link(self, item: GraphRelationshipInput) -> dict: ...
    def subgraph(self, node_ids: list[str], active_only: bool = True) -> dict: ...
    def close(self) -> None: ...


class Neo4jGraphRepository:
    def __init__(self, uri: str, user: str, password: str, database: str = "neo4j"):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.database = database

    def health(self) -> bool:
        self.driver.verify_connectivity()
        return True

    def ensure_schema(self) -> None:
        queries = [
            "CREATE CONSTRAINT kg_node_id IF NOT EXISTS FOR (n:KnowledgeNode) REQUIRE n.nodeId IS UNIQUE",
            "CREATE INDEX kg_node_kind IF NOT EXISTS FOR (n:KnowledgeNode) ON (n.kind)",
            "CREATE INDEX kg_node_status IF NOT EXISTS FOR (n:KnowledgeNode) ON (n.status)",
        ]
        with self.driver.session(database=self.database) as session:
            for query in queries:
                session.run(query).consume()

    def upsert_node(self, item: GraphNodeInput) -> dict:
        values = item.model_dump(by_alias=True)
        metadata = values.pop("metadata", {})
        query = """
        MERGE (n:KnowledgeNode {nodeId: $nodeId})
        SET n += $properties, n.metadataJson = $metadataJson, n.updatedAt = datetime()
        RETURN properties(n) AS node
        """
        with self.driver.session(database=self.database) as session:
            record = session.run(query, nodeId=item.node_id, properties=values, metadataJson=json.dumps(metadata)).single()
            return public_node(record["node"])

    def get_node(self, node_id: str) -> dict | None:
        with self.driver.session(database=self.database) as session:
            record = session.run(
                "MATCH (n:KnowledgeNode {nodeId: $nodeId}) RETURN properties(n) AS node",
                nodeId=node_id,
            ).single()
            return public_node(record["node"]) if record else None

    def link(self, item: GraphRelationshipInput) -> dict:
        endpoints = self._endpoint_kinds(item.from_node_id, item.to_node_id)
        if endpoints is None:
            raise KeyError("Both graph nodes must exist before creating a relationship.")
        assert_valid_endpoints(item.relationship, *endpoints)
        # Relationship names cannot be parameterized in Cypher. Pydantic has
        # already restricted this value to the closed RelationshipKind union.
        query = f"""
        MATCH (a:KnowledgeNode {{nodeId: $fromNodeId}}), (b:KnowledgeNode {{nodeId: $toNodeId}})
        MERGE (a)-[r:{item.relationship}]->(b)
        SET r.status = $status, r.evidenceRef = $evidenceRef, r.updatedAt = datetime()
        RETURN a.nodeId AS fromNodeId, b.nodeId AS toNodeId, type(r) AS relationship,
               r.status AS status, r.evidenceRef AS evidenceRef
        """
        with self.driver.session(database=self.database) as session:
            record = session.run(
                query,
                fromNodeId=item.from_node_id,
                toNodeId=item.to_node_id,
                status=item.status,
                evidenceRef=item.evidence_ref,
            ).single()
            if not record:
                raise KeyError("Both graph nodes must exist before creating a relationship.")
            return dict(record)

    def _endpoint_kinds(self, from_node_id: str, to_node_id: str) -> tuple[str, str] | None:
        with self.driver.session(database=self.database) as session:
            record = session.run(
                "MATCH (a:KnowledgeNode {nodeId: $fromNodeId}), (b:KnowledgeNode {nodeId: $toNodeId}) "
                "RETURN a.kind AS fromKind, b.kind AS toKind",
                fromNodeId=from_node_id,
                toNodeId=to_node_id,
            ).single()
            return (record["fromKind"], record["toKind"]) if record else None

    def subgraph(self, node_ids: list[str], active_only: bool = True) -> dict:
        seed_status_clause = "AND seed.status = 'active'" if active_only else ""
        edge_status_clause = "AND a.status = 'active' AND b.status = 'active' AND r.status = 'active'" if active_only else ""
        query = f"""
        MATCH (seed:KnowledgeNode)
        WHERE seed.nodeId IN $nodeIds {seed_status_clause}
        OPTIONAL MATCH (a:KnowledgeNode)-[r]->(b:KnowledgeNode)
        WHERE (a = seed OR b = seed) {edge_status_clause}
        RETURN collect(DISTINCT properties(seed)) + collect(DISTINCT properties(a)) + collect(DISTINCT properties(b)) AS nodes,
               collect(DISTINCT {{fromNodeId:a.nodeId,toNodeId:b.nodeId,relationship:type(r),status:r.status}}) AS edges
        """
        with self.driver.session(database=self.database) as session:
            record = session.run(query, nodeIds=node_ids).single()
            if not record:
                return {"nodes": [], "edges": []}
            unique = {node["nodeId"]: public_node(node) for node in record["nodes"] if node}
            edges = [dict(edge) for edge in record["edges"] if edge.get("fromNodeId") and edge.get("toNodeId")]
            return {"nodes": list(unique.values()), "edges": edges}

    def close(self) -> None:
        self.driver.close()


class MemoryGraphRepository:
    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}

    def health(self) -> bool:
        return True

    def ensure_schema(self) -> None:
        return None

    def upsert_node(self, item: GraphNodeInput) -> dict:
        value = item.model_dump(by_alias=True)
        self.nodes[item.node_id] = value
        return value

    def get_node(self, node_id: str) -> dict | None:
        return self.nodes.get(node_id)

    def link(self, item: GraphRelationshipInput) -> dict:
        if item.from_node_id not in self.nodes or item.to_node_id not in self.nodes:
            raise KeyError("Both graph nodes must exist before creating a relationship.")
        assert_valid_endpoints(
            item.relationship,
            self.nodes[item.from_node_id]["kind"],
            self.nodes[item.to_node_id]["kind"],
        )
        value = item.model_dump(by_alias=True)
        self.edges[(item.from_node_id, item.relationship, item.to_node_id)] = value
        return value

    def subgraph(self, node_ids: list[str], active_only: bool = True) -> dict:
        selected = []
        for edge in self.edges.values():
            if edge["fromNodeId"] not in node_ids and edge["toNodeId"] not in node_ids:
                continue
            if active_only:
                from_node = self.nodes.get(edge["fromNodeId"])
                to_node = self.nodes.get(edge["toNodeId"])
                if (
                    edge["status"] != "active"
                    or not from_node
                    or not to_node
                    or from_node["status"] != "active"
                    or to_node["status"] != "active"
                ):
                    continue
            selected.append(edge)
        ids = set(node_ids)
        ids.update(value for edge in selected for value in (edge["fromNodeId"], edge["toNodeId"]))
        nodes = [node for key, node in self.nodes.items() if key in ids and (not active_only or node["status"] == "active")]
        return {"nodes": nodes, "edges": selected}

    def close(self) -> None:
        return None
