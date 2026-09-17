from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # The image defaults this to production. Local source runs must set an
    # explicit development/test value instead of accidentally making a
    # production deployment permissive through an omitted environment value.
    deployment_environment: Literal["development", "test", "staging", "production"] = "development"
    # This is intentionally a literal rather than a truthy toggle so an
    # operator has to make a deliberate, auditable deployment decision.
    psv_production_approval: Literal["", "founder-approved"] = ""
    psv_production_approval_reference: str = ""
    database_url: str = "sqlite:///./psv.db"
    jwt_secret: str = "development-secret"
    internal_service_token: str = ""
    psv_db_schema: str = "psv_db"
    db_pool_size: int = 5
    db_max_overflow: int = 5
    gnn_service_url: str = "http://knowledge-gnn:3013"
    gnn_trainer_url: str = "http://knowledge-gnn-trainer:3016"
    kg_service_url: str = "http://kg:3012"
    decision_service_url: str = "http://decisions:3014"
    lms_service_url: str = "http://lms:3006"
    gnn_timeout_seconds: float = 2.0
    daily_refresh_enabled: bool = False
    daily_refresh_hour_utc: int = 2
    daily_refresh_poll_seconds: int = 3600
    campaign_projection_enabled: bool = True
    campaign_projection_poll_seconds: int = 10
    port: int = 3011

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        return self.database_url

    def require_deployment_approval(self) -> None:
        """Fail closed outside local/test environments until PSV is approved.

        PSV can create intervention campaigns and notification projections.
        It must not start in a shared environment based on a URL or a
        best-effort downstream fallback alone.  The reference is retained in
        deployment configuration/log provenance rather than hard-coding a
        person's name in source.
        """
        if self.deployment_environment not in {"staging", "production"}:
            return
        if (
            self.psv_production_approval != "founder-approved"
            or not self.psv_production_approval_reference.strip()
        ):
            raise RuntimeError(
                "PSV is not approved for staging or production. Set "
                "PSV_PRODUCTION_APPROVAL=founder-approved and provide a "
                "non-empty PSV_PRODUCTION_APPROVAL_REFERENCE after approval."
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
