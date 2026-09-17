from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    internal_service_token: str = ""
    decision_rule_version: str = "dual-graph-decisions-v1"
    gnn_min_confidence: float = 0.55
    gnn_max_blend_weight: float = 0.6

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
