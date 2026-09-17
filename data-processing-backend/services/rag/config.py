from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(
        "postgresql+psycopg://postgres:postgres@postgres:5432/roognis",
        description="SQLAlchemy database URL for the RAG schema.",
    )
    rag_db_schema: str = Field(
        "rag_db",
        description="PostgreSQL schema used by the RAG/EKE service.",
    )
    jwt_secret: str = Field(
        "dev-only-rag-secret",
        description="Shared JWT secret used to verify teacher ingestion requests.",
    )
    chroma_url: str = Field(
        "http://chromadb:8000",
        description="ChromaDB HTTP endpoint for retrieval chunk embeddings.",
    )
    ollama_url: str = Field(
        "http://ollama:11434",
        description="Ollama endpoint used for local embedding generation.",
    )
    ollama_embedding_model: str = Field(
        "nomic-embed-text",
        description="Ollama embedding model for EKE retrieval chunks.",
    )
    file_storage_path: str = Field(
        "/app/storage",
        description="Shared storage path for uploaded PDFs and ingestion artifacts.",
    )
    rag_max_upload_mb: int = Field(
        50,
        ge=1,
        description="Maximum accepted PDF upload size in megabytes.",
    )
    rag_collection_prefix: str = Field(
        "school",
        description="Prefix for per-school Chroma collection names.",
    )
    rag_test_mode: bool = Field(
        False,
        description="Enables lightweight test defaults for pytest/TestClient runs.",
    )
    db_pool_size: int = Field(
        5,
        ge=1,
        description="SQLAlchemy connection pool size. Explicit rather than the "
        "library default, since 8 services already share one Postgres instance "
        "with a stock max_connections=100 and no PgBouncer in front of it.",
    )
    db_max_overflow: int = Field(
        5,
        ge=0,
        description="Extra connections allowed beyond db_pool_size under burst load.",
    )
    quiz_service_url: str = Field(
        "",
        description="Quiz Service base URL used for chapter-ready notifications.",
    )
    kg_service_url: str = Field(
        "",
        description="Knowledge Graph Service base URL for CurriculumContentPublished topology delivery.",
    )
    internal_service_token: str = Field(
        "",
        description="Shared service-to-service token for internal RAG/Quiz calls.",
    )
    rag_render_max_edge: int = Field(
        2048,
        ge=256,
        le=4096,
        description="Maximum long edge for a server-rendered curriculum PDF page.",
    )
    rag_render_max_bytes: int = Field(
        4 * 1024 * 1024,
        ge=256 * 1024,
        le=12 * 1024 * 1024,
        description="Maximum PNG payload produced for one internal curriculum page render.",
    )
    rag_render_max_concurrent: int = Field(
        4,
        ge=1,
        le=16,
        description="Bounded concurrent PDF renders so question-time vision cannot exhaust RAG.",
    )
    rag_render_timeout_seconds: int = Field(
        8,
        ge=1,
        le=30,
        description="Best-effort wall-clock budget for one page render.",
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        return self.database_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
