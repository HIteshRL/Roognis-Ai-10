from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    jwt_secret: str = "development-secret"
    internal_service_token: str = ""
    lms_service_url: str = "http://lms:3006"
    psv_service_url: str = "http://psv:3011"
    privacy_min_cohort_size: int = 5
    upstream_timeout_seconds: float = 5.0
    port: int = 3015

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
