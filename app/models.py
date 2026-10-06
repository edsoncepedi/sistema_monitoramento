from datetime import datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import REAL, BigInteger, DateTime, Double, Index, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)


class Leitura(db.Model):
    """Uma amostra de aceleração (m/s²) enviada pelo microcontrolador.

    A tabela é uma hypertable do TimescaleDB particionada por 'ts' (ver timescale.py),
    por isso a chave primária precisa incluir 'ts'.
    """

    __tablename__ = "leituras"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
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


class Leitura1s(db.Model):
    """Agregado contínuo do TimescaleDB: uma linha por dispositivo por segundo.

    Criado em timescale.py, nunca pelo create_all. Guarda somas em vez de médias
    para que médias e desvios de períodos longos possam ser combinados com exatidão.
    """

    __tablename__ = "leituras_1s"

    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    n: Mapped[int] = mapped_column(BigInteger)
    x_min: Mapped[float] = mapped_column(REAL)
    x_max: Mapped[float] = mapped_column(REAL)
    x_soma: Mapped[float] = mapped_column(Double)
    x_quad: Mapped[float] = mapped_column(Double)
    y_min: Mapped[float] = mapped_column(REAL)
    y_max: Mapped[float] = mapped_column(REAL)
    y_soma: Mapped[float] = mapped_column(Double)
    y_quad: Mapped[float] = mapped_column(Double)
    z_min: Mapped[float] = mapped_column(REAL)
    z_max: Mapped[float] = mapped_column(REAL)
    z_soma: Mapped[float] = mapped_column(Double)
    z_quad: Mapped[float] = mapped_column(Double)
