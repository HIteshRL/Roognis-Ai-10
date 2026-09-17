from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class ReportPolicy(Base):
    """One active, versioned parent-report policy per service installation."""

    __tablename__ = "report_policies"

    policy_key: Mapped[str] = mapped_column(String(80), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    parameters: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
