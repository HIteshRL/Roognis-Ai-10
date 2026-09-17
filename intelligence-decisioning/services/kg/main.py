from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException

from auth import require_internal_token
from config import get_settings
from repository import MemoryGraphRepository, Neo4jGraphRepository
from schemas import GraphNodeInput, GraphRelationshipInput, SubgraphRequest

settings = get_settings()
repository = MemoryGraphRepository() if settings.kg_test_mode else Neo4jGraphRepository(
    settings.neo4j_uri,
    settings.neo4j_user,
    settings.neo4j_password,
    settings.neo4j_database,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    repository.ensure_schema()
    yield
    repository.close()


app = FastAPI(title="Roognis Knowledge Graph Service", lifespan=lifespan)


@app.get("/health")
@app.get("/api/kg/health")
def health():
    try:
        return {"status": "ok" if repository.health() else "degraded", "service": "kg"}
    except Exception as exc:
        return {"status": "degraded", "service": "kg", "error": str(exc)}


@app.put("/api/kg/v1/nodes/{node_id}")
def upsert_node(node_id: str, body: GraphNodeInput, _: None = Depends(require_internal_token)):
    if node_id != body.node_id:
        raise HTTPException(status_code=400, detail="Path node id must match body nodeId.")
    return repository.upsert_node(body)


@app.get("/api/kg/v1/nodes/{node_id}")
def get_node(node_id: str, _: None = Depends(require_internal_token)):
    value = repository.get_node(node_id)
    if not value:
        raise HTTPException(status_code=404, detail="Knowledge graph node not found.")
    return value


@app.post("/api/kg/v1/relationships")
def create_relationship(body: GraphRelationshipInput, _: None = Depends(require_internal_token)):
    try:
        return repository.link(body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        # An endpoint-kind violation is a malformed request, not a server fault.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/kg/internal/subgraph")
def load_subgraph(body: SubgraphRequest, _: None = Depends(require_internal_token)):
    return repository.subgraph(body.node_ids, body.active_only)
