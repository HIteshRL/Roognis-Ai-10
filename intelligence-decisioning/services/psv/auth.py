from dataclasses import dataclass
from typing import Annotated, Any

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, status
from jwt import InvalidTokenError

from config import Settings, get_settings


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    role: str
    school_id: str


def _required(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return value


def get_current_user(
    jwt_cookie: Annotated[str | None, Cookie(alias="jwt")] = None,
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    if not jwt_cookie:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    try:
        payload = jwt.decode(jwt_cookie, settings.jwt_secret, algorithms=["HS256"])
    except InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    return AuthUser(
        user_id=_required(payload, "userId"),
        role=_required(payload, "role"),
        school_id=_required(payload, "schoolId"),
    )


def require_student(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role != "student":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user


def require_internal_token(
    x_internal_service_token: Annotated[str | None, Header(alias="X-Internal-Service-Token")] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.internal_service_token:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal service token is not configured.")
    if x_internal_service_token != settings.internal_service_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
