#!/usr/bin/env bash
# Migra os dados do Postgres puro (volume 'pgdata') para o TimescaleDB (volume 'tsdata').
#
# Rodar UMA vez, na pasta do projeto, depois do 'git pull' que trouxe o TimescaleDB e
# ANTES de qualquer 'docker compose up' (o container antigo do banco precisa estar rodando):
#
#     bash scripts/migrar_para_timescale.sh
#
# O que faz:
#   1. para o serviço web (o microcontrolador recebe erro e descarta lotes durante a migração);
#   2. faz backup completo do banco atual em backups/ (pg_dump);
#   3. recria o serviço db com a imagem do TimescaleDB e o volume novo 'tsdata';
#   4. cria o schema (hypertable, compressão, agregado contínuo) e restaura as leituras;
#   5. confere a contagem de linhas e sobe o web de novo.
#
# O volume antigo 'pgdata' NÃO é alterado. Para voltar atrás:
#     git checkout <commit anterior> && docker compose up -d --build
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1090
. <(tr -d '\r' < .env)
set +a

PSQL=(docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA)
DUMP="backups/antes_timescale_$(date +%Y%m%d_%H%M%S).dump"

passo() { printf '\n==> %s\n' "$*"; }
falha() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

passo "Verificando o banco atual"
[ -n "$(docker compose ps -q --status running db)" ] || falha "o container do banco (db) não está rodando"
if [ "$("${PSQL[@]}" -c "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'")" != "0" ]; then
    falha "o banco atual já é TimescaleDB; nada a migrar"
fi
ORIGEM=$("${PSQL[@]}" -c "SELECT count(*) FROM leituras")
echo "Leituras no banco atual: $ORIGEM"

passo "Construindo a imagem nova do web (antes de parar, para reduzir a parada)"
docker compose build web

passo "Parando o serviço web"
docker compose stop web

passo "Backup completo em $DUMP"
mkdir -p backups
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DUMP"
[ -s "$DUMP" ] || falha "backup vazio"
ls -lh "$DUMP"

passo "Recriando o banco com TimescaleDB (volume novo 'tsdata')"
docker compose up -d --wait db
DISPONIVEL=$("${PSQL[@]}" -c "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'")
[ -n "$DISPONIVEL" ] || falha "extensão timescaledb indisponível na imagem nova"
echo "TimescaleDB $DISPONIVEL"

passo "Criando schema (hypertable, compressão, agregado contínuo)"
docker compose run --rm --no-deps web python -c "from app import create_app; create_app()"
JA_EXISTENTES=$("${PSQL[@]}" -c "SELECT count(*) FROM leituras")
[ "$JA_EXISTENTES" = "0" ] || falha "o banco novo já tem $JA_EXISTENTES leituras; abortando para não duplicar"

passo "Restaurando as leituras"
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --data-only --table=leituras --no-owner < "$DUMP"
"${PSQL[@]}" -c "SELECT setval(pg_get_serial_sequence('leituras', 'id'), (SELECT coalesce(max(id), 1) FROM leituras))" >/dev/null

DESTINO=$("${PSQL[@]}" -c "SELECT count(*) FROM leituras")
echo "Leituras restauradas: $DESTINO (origem: $ORIGEM)"
[ "$DESTINO" = "$ORIGEM" ] || falha "contagem diferente; o web continua parado. Backup em $DUMP"

passo "Calculando o agregado por segundo para o histórico"
"${PSQL[@]}" -c "CALL refresh_continuous_aggregate('leituras_1s', NULL, NULL)"

passo "Subindo o serviço web"
docker compose up -d web

passo "Migração concluída"
"${PSQL[@]}" -c "SELECT hypertable_name, num_chunks, compression_enabled FROM timescaledb_information.hypertables"
cat <<EOF

Backup: $DUMP
O volume antigo 'pgdata' continua intacto. Depois de validar o sistema por alguns dias,
ele pode ser removido com:  docker volume rm $(basename "$PWD")_pgdata
EOF
