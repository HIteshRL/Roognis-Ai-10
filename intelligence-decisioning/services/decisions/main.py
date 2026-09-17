from fastapi import Depends, FastAPI

from auth import require_internal_token
from config import Settings, get_settings
from policy import knowledge_decision, preference_decision
from schemas import KnowledgeDecisionInput, PreferenceDecisionInput

app = FastAPI(title="Roognis Decision Service")


@app.get("/health")
@app.get("/api/decisions/health")
def health(settings: Settings = Depends(get_settings)):
    return {"status": "ok", "service": "decisions", "ruleVersion": settings.decision_rule_version}


@app.post("/api/decisions/v1/preference")
def decide_preference(
    body: PreferenceDecisionInput,
    _: None = Depends(require_internal_token),
    settings: Settings = Depends(get_settings),
):
    return preference_decision(body, settings)


@app.post("/api/decisions/v1/knowledge")
def decide_knowledge(
    body: KnowledgeDecisionInput,
    _: None = Depends(require_internal_token),
    settings: Settings = Depends(get_settings),
):
    return knowledge_decision(body, settings)
