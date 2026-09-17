from dataclasses import dataclass
from typing import Annotated, Any

import jwt
from fastapi import Cookie, Depends, HTTPException, status
from jwt import InvalidTokenError

from config import Settings, get_settings


@dataclass(frozen=True)
class TeacherAuth:
    user_id: str
    school_id: str
    jwt_cookie: str


def _required(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise HTTPException(status_code=401, detail="Invalid token")
    return value


def require_teacher(
    jwt_cookie: Annotated[str | None, Cookie(alias="jwt")] = None,
    settings: Settings = Depends(get_settings),
) -> TeacherAuth:
    if not jwt_cookie:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    try:
        payload = jwt.decode(jwt_cookie, settings.jwt_secret, algorithms=["HS256"])
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    if payload.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Forbidden")
    return TeacherAuth(
        user_id=_required(payload, "userId"),
        school_id=_required(payload, "schoolId"),
        jwt_cookie=jwt_cookie,
    )
