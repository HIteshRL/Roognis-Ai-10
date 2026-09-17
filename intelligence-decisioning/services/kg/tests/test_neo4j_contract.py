import os
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
import main
from repository import Neo4jGraphRepository


@pytest.mark.skipif(not os.getenv("CORRECTIONS_NEO4J_URI"), reason="Requires isolated Neo4j")
def test_real_neo4j_http_node_and_subgraph_contract(monkeypatch):
    uri = os.environ["CORRECTIONS_NEO4J_URI"]
    assert uri == "bolt://127.0.0.1:17687", "Use only the isolated corrections database"
    repository = Neo4jGraphRepository(uri, "neo4j", "corrections-test-only")
    monkeypatch.setattr(main, "repository", repository)
    main.app.dependency_overrides[main.require_internal_token] = lambda: None
    try:
        with TestClient(main.app) as client:
            node_id = "test:" + str(uuid4())
            body = {"nodeId": node_id, "kind": "Concept", "label": "Fractions", "status": "active", "metadata": {"documentId": "test-document"}}
            response = client.put("/api/kg/v1/nodes/" + node_id, json=body)
            assert response.status_code == 200
            assert response.json()["metadata"] == body["metadata"]
            assert isinstance(response.json()["updatedAt"], str)
            assert client.get("/api/kg/v1/nodes/" + node_id).json()["nodeId"] == node_id
            graph = client.post("/api/kg/internal/subgraph", json={"nodeIds": [node_id]}).json()
            assert graph["nodes"][0]["metadata"] == body["metadata"]
    finally:
        main.app.dependency_overrides.clear()
