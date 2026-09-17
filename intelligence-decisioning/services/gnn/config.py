from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    internal_service_token: str = ""
    gnn_lane: Literal["knowledge", "preference"] = "knowledge"
    gnn_model_artifact: str = ""
    gnn_shadow_mode: bool = False
    gnn_min_preference_coverage: int = 3
    gnn_min_knowledge_coverage: int = 5
    gnn_min_confidence: float = 0.55
    gnn_max_model_age_hours: int = 72
    port: int = 3013

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
