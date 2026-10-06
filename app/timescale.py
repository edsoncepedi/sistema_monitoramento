"""Configuração do TimescaleDB, idempotente: roda a cada inicialização do app.

- leituras vira uma hypertable particionada por dia (chunks de 1 dia).
- Chunks com mais de COMPRIMIR_APOS são comprimidos (colunar, segmentado por dispositivo).
- leituras_1s é um agregado contínuo por segundo, usado em históricos e estatísticas longos.
"""
import logging

from sqlalchemy import text

log = logging.getLogger(__name__)

INTERVALO_CHUNK = "1 day"
COMPRIMIR_APOS = "7 days"

_SQL_AGREGADO = """
CREATE MATERIALIZED VIEW IF NOT EXISTS leituras_1s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 second', ts) AS bucket,
       device_id,
       count(*)            AS n,
       min(x) AS x_min, max(x) AS x_max, sum(x::float8) AS x_soma, sum(x::float8 * x) AS x_quad,
       min(y) AS y_min, max(y) AS y_max, sum(y::float8) AS y_soma, sum(y::float8 * y) AS y_quad,
       min(z) AS z_min, max(z) AS z_max, sum(z::float8) AS z_soma, sum(z::float8 * z) AS z_quad
FROM leituras
GROUP BY bucket, device_id
WITH NO DATA
"""


def configurar(conn):
    """Recebe uma Connection dentro de uma transação (engine.begin())."""
    conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))

    eh_hypertable = conn.scalar(text(
        "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'leituras'"
    ))
    if not eh_hypertable:
        # Tabelas criadas por versões anteriores tinham PK só em 'id'; a hypertable exige 'ts' na PK.
        pk = conn.scalars(text("""
            SELECT a.attname FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'leituras'::regclass AND i.indisprimary
        """)).all()
        if set(pk) != {"id", "ts"}:
            log.info("Ajustando chave primária de leituras para (id, ts)")
            conn.execute(text("ALTER TABLE leituras DROP CONSTRAINT IF EXISTS leituras_pkey"))
            conn.execute(text("ALTER TABLE leituras ADD PRIMARY KEY (id, ts)"))

        log.info("Convertendo leituras em hypertable")
        conn.execute(text(f"""
            SELECT create_hypertable('leituras', by_range('ts', INTERVAL '{INTERVALO_CHUNK}'),
                                     create_default_indexes => false, migrate_data => true)
        """))

    comprimido = conn.scalar(text(
        "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'leituras'"
    ))
    if not comprimido:
        log.info("Habilitando compressão em leituras")
        conn.execute(text("""
            ALTER TABLE leituras SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'device_id',
                timescaledb.compress_orderby = 'ts DESC, id DESC'
            )
        """))
    conn.execute(text(
        f"SELECT add_compression_policy('leituras', INTERVAL '{COMPRIMIR_APOS}', if_not_exists => true)"
    ))

    conn.execute(text(_SQL_AGREGADO))
    conn.execute(text("""
        SELECT add_continuous_aggregate_policy('leituras_1s',
            start_offset => INTERVAL '3 hours',
            end_offset => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists => true)
    """))
