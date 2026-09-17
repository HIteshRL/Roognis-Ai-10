from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from sqlalchemy.schema import CreateSchema

from alembic import context

# `prepend_sys_path = .` in alembic.ini resolves relative to services/lms/,
# so these are the same bare imports database.py, models.py and
# tests/conftest.py already use.
from config import get_settings
from database import Base
import models  # noqa: F401  (registers all mapped classes on Base.metadata)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.sqlalchemy_database_url)

target_metadata = Base.metadata
schema_name = settings.lms_db_schema or None


def run_migrations_offline() -> None:
    context.configure(
        url=settings.sqlalchemy_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=True,
        version_table_schema=schema_name,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        # Mirrors database.py's init_db(): the schema must exist before
        # Alembic's version table (or any revision's tables) can be created
        # in it. Postgres-only, matching init_db()'s own guard.
        if schema_name and connection.dialect.name == "postgresql":
            connection.execute(CreateSchema(schema_name, if_not_exists=True))
            connection.commit()

        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            version_table_schema=schema_name,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
