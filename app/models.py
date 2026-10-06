from datetime import datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import REAL, BigInteger, DateTime, Index, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)


class Leitura(db.Model):
    """Uma amostra de aceleração (m/s²) enviada pelo microcontrolador."""

    __tablename__ = "leituras"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    x: Mapped[float] = mapped_column(REAL, nullable=False)
    y: Mapped[float] = mapped_column(REAL, nullable=False)
    z: Mapped[float] = mapped_column(REAL, nullable=False)
    recebido_em: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_leituras_device_ts", "device_id", "ts"),
        Index("ix_leituras_ts", "ts"),
    )
