import asyncio

import pytest

from config import Settings
from main import app, lifespan


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_shared_environments_require_explicit_psv_approval(environment):
    with pytest.raises(RuntimeError, match="PSV is not approved"):
        Settings(deployment_environment=environment).require_deployment_approval()


def test_shared_environment_requires_an_approval_reference():
    with pytest.raises(RuntimeError, match="PSV is not approved"):
        Settings(
            deployment_environment="production",
            psv_production_approval="founder-approved",
        ).require_deployment_approval()


def test_explicit_approval_with_reference_permits_shared_environment_startup():
    Settings(
        deployment_environment="production",
        psv_production_approval="founder-approved",
        psv_production_approval_reference="PSV-APPROVAL-2026-001",
    ).require_deployment_approval()


def test_lifespan_fails_closed_before_opening_the_database(monkeypatch):
    settings = Settings(deployment_environment="production")
    monkeypatch.setattr("main.get_settings", lambda: settings)

    async def start_unapproved_service():
        async with lifespan(app):
            raise AssertionError("Unapproved PSV must not finish startup")

    with pytest.raises(RuntimeError, match="PSV is not approved"):
        asyncio.run(start_unapproved_service())


@pytest.mark.parametrize("environment", ["development", "test"])
def test_local_and_test_environments_do_not_need_production_approval(environment):
    Settings(deployment_environment=environment).require_deployment_approval()
