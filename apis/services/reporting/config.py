from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime wiring for the independently deployable reporting service.

    Report thresholds live in the service database rather than environment
    variables. This lets an approved operator change a metric policy without
    rebuilding the image, while this class keeps deployment concerns outside
    the report calculation itself.
    """

    database_url: str = "sqlite:///./reporting.db"
    reporting_db_schema: str = "reporting_db"
    jwt_secret: str = "development-secret"
    internal_service_token: str = ""
    auth_service_url: str = "http://auth:3001"
    analytics_service_url: str = "http://analytics:3004"
    lms_service_url: str = "http://lms:3006"
    psv_service_url: str = "http://psv:3011"
    # PSV is deployment-gated independently because it can initiate learner
    # interventions. Reporting remains usable without academic-insight data.
    psv_enabled: bool = False
    upstream_timeout_seconds: float = 5.0
    port: int = 3017

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
