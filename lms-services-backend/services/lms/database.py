from collections.abc import Generator
from pathlib import Path

from sqlalchemy import MetaData, create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateSchema

from config import get_settings

settings = get_settings()
metadata = MetaData(schema=settings.lms_db_schema or None)


class Base(DeclarativeBase):
    metadata = metadata


engine_options = {
    "future": True,
    "pool_pre_ping": True,
}

if settings.sqlalchemy_database_url.startswith("sqlite"):
    engine_options.update(
        {
            "connect_args": {"check_same_thread": False},
            "poolclass": StaticPool,
        }
    )
else:
    # Explicit rather than the library default (pool_size=5, max_overflow=10):
    # 8 services already share one Postgres instance with a stock
    # max_connections=100 and no PgBouncer in front of it. StaticPool (above,
    # used for SQLite in tests) doesn't accept these kwargs, hence the branch.
    engine_options.update(
        {
            "pool_size": settings.db_pool_size,
            "max_overflow": settings.db_max_overflow,
        }
    )

engine = create_engine(settings.sqlalchemy_database_url, **engine_options)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


def init_db() -> None:
    # Import models so they register on Base.metadata either way.
    import models  # noqa: F401

    if engine.dialect.name != "postgresql":
        # SQLite (tests/conftest.py talks to Base.metadata directly and never
        # calls init_db(), but this keeps the function correct if it ever
        # does): Alembic's schema handling has nothing to do here.
        Base.metadata.create_all(bind=engine)
        return

    if settings.lms_db_schema:
        with engine.begin() as connection:
            connection.execute(CreateSchema(settings.lms_db_schema, if_not_exists=True))

    from alembic import command
    from alembic.config import Config

    alembic_cfg = Config(str(Path(__file__).parent / "alembic.ini"))
    alembic_cfg.attributes["configure_logger"] = False

    # This service ran on create_all() before Alembic existed (Sprint 0,
    # S0.2), so any database that already has these tables predates Alembic
    # tracking them — 0001_baseline.py's CREATE TABLEs would collide with
    # what create_all() already built. Detected once, deterministically: no
    # alembic_version table yet, but the metadata's own tables already exist.
    # Stamp baseline as applied instead of re-running its DDL; upgrade() then
    # picks up correctly from there for any revision beyond the baseline.
    inspector = inspect(engine)
    schema = settings.lms_db_schema or None
    has_version_table = inspector.has_table("alembic_version", schema=schema)
    has_existing_tables = any(
        inspector.has_table(table.name, schema=schema) for table in Base.metadata.tables.values()
    )
    if has_existing_tables and not has_version_table:
        command.stamp(alembic_cfg, "0001")

    command.upgrade(alembic_cfg, "head")


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
