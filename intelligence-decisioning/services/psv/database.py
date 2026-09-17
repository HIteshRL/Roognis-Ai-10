from collections.abc import Generator

from sqlalchemy import MetaData, create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateSchema

from config import get_settings

settings = get_settings()
metadata = MetaData(schema=settings.psv_db_schema if not settings.sqlalchemy_database_url.startswith("sqlite") else None)


class Base(DeclarativeBase):
    metadata = metadata


engine_options: dict = {"future": True, "pool_pre_ping": True}
if settings.sqlalchemy_database_url.startswith("sqlite"):
    engine_options.update({"connect_args": {"check_same_thread": False}, "poolclass": StaticPool})
else:
    engine_options.update({"pool_size": settings.db_pool_size, "max_overflow": settings.db_max_overflow})

engine = create_engine(settings.sqlalchemy_database_url, **engine_options)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


def init_db() -> None:
    if settings.psv_db_schema and engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(CreateSchema(settings.psv_db_schema, if_not_exists=True))
    import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    if engine.dialect.name == "postgresql":
        # create_all intentionally owns first installation, but it does not
        # evolve an already-created pilot schema. Keep these additive changes
        # idempotent so rolling out the learner-state service cannot strand an
        # older table shape before a full migration framework is introduced.
        schema = engine.dialect.identifier_preparer.quote(settings.psv_db_schema)
        with engine.begin() as connection:
            connection.execute(text(
                f"ALTER TABLE {schema}.knowledge_gap_snapshots "
                "ADD COLUMN IF NOT EXISTS next_concept_id VARCHAR(160)"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.knowledge_gap_snapshots "
                "ADD COLUMN IF NOT EXISTS concept_label VARCHAR(240) NOT NULL DEFAULT 'Assessed concept'"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.knowledge_gap_snapshots "
                "ADD COLUMN IF NOT EXISTS trend DOUBLE PRECISION NOT NULL DEFAULT 0"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.knowledge_gap_snapshots "
                "ADD COLUMN IF NOT EXISTS uncertainty DOUBLE PRECISION NOT NULL DEFAULT 1.0"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.refresh_runs "
                "ADD COLUMN IF NOT EXISTS training_status VARCHAR(24) NOT NULL DEFAULT 'not_started'"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.refresh_runs "
                "ADD COLUMN IF NOT EXISTS training_promoted BOOLEAN NOT NULL DEFAULT false"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.refresh_runs "
                "ADD COLUMN IF NOT EXISTS training_reason VARCHAR(80)"
            ))
            connection.execute(text(
                f"ALTER TABLE {schema}.refresh_runs "
                "ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ"
            ))
            # §7 event-envelope additions. All nullable, so an older event row
            # shape stays valid and back-fill is not required.
            for column, ddl_type in (
                ("course_id", "VARCHAR(64)"),
                ("chapter_id", "VARCHAR(64)"),
                ("content_id", "VARCHAR(160)"),
                ("curriculum_version", "VARCHAR(64)"),
                ("attempt_id", "VARCHAR(64)"),
                ("campaign_id", "VARCHAR(64)"),
                ("server_occurred_at", "TIMESTAMPTZ"),
                ("grading_authority", "VARCHAR(48)"),
                ("result_ref", "VARCHAR(200)"),
                ("source_service", "VARCHAR(48)"),
                ("evidence_kind", "VARCHAR(24)"),
            ):
                connection.execute(text(
                    f"ALTER TABLE {schema}.learning_events "
                    f"ADD COLUMN IF NOT EXISTS {column} {ddl_type}"
                ))
            connection.execute(text(
                f"CREATE INDEX IF NOT EXISTS ix_learning_events_chapter_id "
                f"ON {schema}.learning_events (chapter_id)"
            ))
            connection.execute(text(
                f"CREATE INDEX IF NOT EXISTS ix_learning_events_campaign_id "
                f"ON {schema}.learning_events (campaign_id)"
            ))
            connection.execute(text(
                f"CREATE INDEX IF NOT EXISTS ix_learning_events_evidence_kind "
                f"ON {schema}.learning_events (evidence_kind)"
            ))
            # §8 end-to-end correlation id on the immediate-path outputs.
            for table in ("knowledge_gap_snapshots", "retention_states", "intervention_campaigns"):
                connection.execute(text(
                    f"ALTER TABLE {schema}.{table} "
                    "ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(200)"
                ))
                connection.execute(text(
                    f"CREATE INDEX IF NOT EXISTS ix_{table}_correlation_id "
                    f"ON {schema}.{table} (correlation_id)"
                ))
            # §6.2 provenance: no learner-state row without the events it came
            # from and the gate version that admitted them.
            #
            # JSON, not JSONB: DecisionRecord.evidence_ids is SQLAlchemy JSON,
            # which compiles to Postgres JSON. Using JSONB here would leave a
            # freshly create_all'd database and an upgraded one with different
            # column types for the same logical field.
            #
            # The defaults exist only for this ALTER. Every write goes through
            # SQLAlchemy and always supplies a value, so an existing pilot row
            # reads as VISIBLY legacy rather than silently claiming current
            # provenance — and the next recompute_student overwrites it from the
            # append-only ledger, which is what makes the backfill a no-op.
            for table in ("trait_states", "knowledge_gap_snapshots", "retention_states"):
                connection.execute(text(
                    f"ALTER TABLE {schema}.{table} "
                    "ADD COLUMN IF NOT EXISTS event_ids JSON NOT NULL DEFAULT '[]'::json"
                ))
                connection.execute(text(
                    f"ALTER TABLE {schema}.{table} "
                    "ADD COLUMN IF NOT EXISTS gate_version VARCHAR(120) NOT NULL "
                    "DEFAULT 'legacy-unversioned'"
                ))
            for table in ("trait_states", "retention_states"):
                connection.execute(text(
                    f"ALTER TABLE {schema}.{table} "
                    "ADD COLUMN IF NOT EXISTS decision_source VARCHAR(24) NOT NULL "
                    "DEFAULT 'baseline'"
                ))
            connection.execute(text(
                f"ALTER TABLE {schema}.decision_records "
                "ADD COLUMN IF NOT EXISTS gate_version VARCHAR(120) NOT NULL "
                "DEFAULT 'legacy-unversioned'"
            ))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
