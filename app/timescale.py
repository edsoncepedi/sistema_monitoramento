"""Configuração do TimescaleDB, idempotente: roda a cada inicialização do app.

Para cada tabela de leituras (aceleração e energia):
- a tabela vira uma hypertable particionada por dia (chunks de 1 dia);
- chunks com mais de COMPRIMIR_APOS são comprimidos (colunar, segmentado por dispositivo);
- <tabela>_1s é um agregado contínuo por segundo, usado em históricos e estatísticas longos.
"""
import logging

from sqlalchemy import text

log = logging.getLogger(__name__)

INTERVALO_CHUNK = "1 day"
COMPRIMIR_APOS = "7 days"

# tabela -> colunas medidas; o agregado guarda mín/máx/Σ/Σ² de cada uma.
TABELAS = {
    "leituras": ("x", "y", "z"),
    "leituras_energia": ("tensao", "corrente", "potencia"),
}


def _sql_agregado(tabela, campos):
    colunas = ",\n       ".join(
        f"min({c}) AS {c}_min, max({c}) AS {c}_max, "
        f"sum({c}::float8) AS {c}_soma, sum({c}::float8 * {c}) AS {c}_quad"
        for c in campos
    )
    return f"""
CREATE MATERIALIZED VIEW IF NOT EXISTS {tabela}_1s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 second', ts) AS bucket,
       device_id,
       count(*)            AS n,
       {colunas}
FROM {tabela}
GROUP BY bucket, device_id
WITH NO DATA
"""


def configurar(conn):
    """Recebe uma Connection dentro de uma transação (engine.begin())."""
    conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
    for tabela, campos in TABELAS.items():
        _configurar_tabela(conn, tabela, campos)


def _configurar_tabela(conn, tabela, campos):
    eh_hypertable = conn.scalar(text(
        "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = :t"
    ), {"t": tabela})
    if not eh_hypertable:
        # Tabelas criadas por versões anteriores tinham PK só em 'id'; a hypertable exige 'ts' na PK.
        pk = conn.scalars(text("""
            SELECT a.attname FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = CAST(:t AS regclass) AND i.indisprimary
        """), {"t": tabela}).all()
        if set(pk) != {"id", "ts"}:
            log.info("Ajustando chave primária de %s para (id, ts)", tabela)
            conn.execute(text(f"ALTER TABLE {tabela} DROP CONSTRAINT IF EXISTS {tabela}_pkey"))
            conn.execute(text(f"ALTER TABLE {tabela} ADD PRIMARY KEY (id, ts)"))

        log.info("Convertendo %s em hypertable", tabela)
        conn.execute(text(f"""
            SELECT create_hypertable('{tabela}', by_range('ts', INTERVAL '{INTERVALO_CHUNK}'),
                                     create_default_indexes => false, migrate_data => true)
        """))

    comprimido = conn.scalar(text(
        "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = :t"
    ), {"t": tabela})
    if not comprimido:
        log.info("Habilitando compressão em %s", tabela)
        conn.execute(text(f"""
            ALTER TABLE {tabela} SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'device_id',
                timescaledb.compress_orderby = 'ts DESC, id DESC'
            )
        """))
    conn.execute(text(
        f"SELECT add_compression_policy('{tabela}', INTERVAL '{COMPRIMIR_APOS}', if_not_exists => true)"
    ))

    conn.execute(text(_sql_agregado(tabela, campos)))
    conn.execute(text(f"""
        SELECT add_continuous_aggregate_policy('{tabela}_1s',
            start_offset => INTERVAL '3 hours',
            end_offset => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists => true)
    """))
