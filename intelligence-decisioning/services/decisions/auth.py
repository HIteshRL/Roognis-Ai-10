from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from config import Settings, get_settings


def require_internal_token(
    x_internal_service_token: Annotated[str | None, Header(alias="X-Internal-Service-Token")] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.internal_service_token:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal service token is not configured.")
    if x_internal_service_token != settings.internal_service_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
