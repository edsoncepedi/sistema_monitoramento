import csv
import hmac
import io
import math
from datetime import datetime, timedelta, timezone

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context
from sqlalchemy import func, insert, select

from .models import Leitura, db

api_bp = Blueprint("api", __name__, url_prefix="/api")

MAX_LOTE = 500           # leituras aceitas por POST
MAX_PONTOS = 2000        # acima disso o histórico é agregado em baldes de tempo
LIMITE_RECENTES = 20000  # teto de pontos por resposta do modo tempo real
MAX_ATRASO_MS = 3_600_000
ORIGEM_BALDES = datetime(2000, 1, 1, tzinfo=timezone.utc)


class ErroRequisicao(ValueError):
    pass


@api_bp.errorhandler(ErroRequisicao)
def _tratar_erro(e):
    return jsonify({"erro": str(e)}), 400


def _erro(msg, status=400):
    return jsonify({"erro": msg}), status


def _numero(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _ms(dt):
    return int(dt.timestamp() * 1000)


def _parse_dt(valor, nome):
    if not valor:
        return None
    try:
        dt = datetime.fromisoformat(valor.replace("Z", "+00:00"))
    except ValueError:
        raise ErroRequisicao(f"Parâmetro '{nome}' inválido; use ISO 8601 (ex. 2026-10-05T14:30:00Z)")
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _filtros():
    """Condições WHERE a partir de ?inicio=&fim=&device_id=."""
    inicio = _parse_dt(request.args.get("inicio"), "inicio")
    fim = _parse_dt(request.args.get("fim"), "fim")
    if inicio and fim and inicio > fim:
        raise ErroRequisicao("'inicio' deve ser anterior a 'fim'")
    device = request.args.get("device_id") or None

    conds = []
    if inicio:
        conds.append(Leitura.ts >= inicio)
    if fim:
        conds.append(Leitura.ts <= fim)
    if device:
        conds.append(Leitura.device_id == device)
    return conds


# --------------------------------------------------------------------------- ingestão

@api_bp.post("/leituras")
def receber_leituras():
    """Recebe um lote do microcontrolador.

    Corpo: {"device_id": "esp32-01", "enviado_ms": 123456,
            "leituras": [{"t": 122960, "x": 0.12, "y": -9.81, "z": 0.5}, ...]}

    't' e 'enviado_ms' são millis() do microcontrolador; o horário real de cada
    amostra é calculado aqui: agora - (enviado_ms - t).
    """
    chave_esperada = current_app.config["API_KEY"]
    if not chave_esperada:
        return _erro("API_KEY não configurada no servidor", 503)
    if not hmac.compare_digest(request.headers.get("X-API-Key", ""), chave_esperada):
        return _erro("Chave de API inválida", 401)

    dados = request.get_json(silent=True)
    if not isinstance(dados, dict):
        return _erro("O corpo deve ser um objeto JSON")

    device_id = dados.get("device_id")
    enviado_ms = dados.get("enviado_ms")
    leituras = dados.get("leituras")

    if not isinstance(device_id, str) or not 1 <= len(device_id) <= 64:
        return _erro("'device_id' deve ser um texto de 1 a 64 caracteres")
    if not _numero(enviado_ms):
        return _erro("'enviado_ms' deve ser numérico")
    if not isinstance(leituras, list) or not leituras:
        return _erro("'leituras' deve ser uma lista não vazia")
    if len(leituras) > MAX_LOTE:
        return _erro(f"No máximo {MAX_LOTE} leituras por lote")

    agora = datetime.now(timezone.utc)
    linhas = []
    for i, l in enumerate(leituras):
        if not isinstance(l, dict) or not all(_numero(l.get(k)) for k in ("t", "x", "y", "z")):
            return _erro(f"Leitura {i} inválida: precisa de t, x, y, z numéricos")
        # millis() é unsigned 32 bits e volta a zero a cada ~49 dias; o módulo trata a virada.
        atraso_ms = (int(enviado_ms) - int(l["t"])) % 2**32
        if atraso_ms > MAX_ATRASO_MS:
            atraso_ms = 0
        linhas.append({
            "device_id": device_id,
            "ts": agora - timedelta(milliseconds=atraso_ms),
            "x": float(l["x"]),
            "y": float(l["y"]),
            "z": float(l["z"]),
        })

    db.session.execute(insert(Leitura), linhas)
    db.session.commit()
    return jsonify({"inseridas": len(linhas)}), 201


# --------------------------------------------------------------------------- consultas

@api_bp.get("/dispositivos")
def listar_dispositivos():
    stmt = (
        select(Leitura.device_id, func.count(), func.max(Leitura.ts))
        .group_by(Leitura.device_id)
        .order_by(Leitura.device_id)
    )
    return jsonify([
        {"device_id": d, "total": total, "ultima": _ms(ultima)}
        for d, total, ultima in db.session.execute(stmt)
    ])


@api_bp.get("/leituras")
def listar_leituras():
    """Pontos para o gráfico do histórico; agrega por média se passar de MAX_PONTOS."""
    conds = _filtros()
    total, primeiro, ultimo = db.session.execute(
        select(func.count(), func.min(Leitura.ts), func.max(Leitura.ts)).where(*conds)
    ).one()

    if total <= MAX_PONTOS:
        stmt = select(Leitura.ts, Leitura.x, Leitura.y, Leitura.z).where(*conds).order_by(Leitura.ts)
        balde_s = None
    else:
        balde = max((ultimo - primeiro) / MAX_PONTOS, timedelta(milliseconds=1))
        balde_s = balde.total_seconds()
        bucket = func.date_bin(balde, Leitura.ts, ORIGEM_BALDES).label("bucket")
        stmt = (
            select(bucket, func.avg(Leitura.x), func.avg(Leitura.y), func.avg(Leitura.z))
            .where(*conds)
            .group_by(bucket)
            .order_by(bucket)
        )

    pontos = [
        {"t": _ms(ts), "x": round(x, 4), "y": round(y, 4), "z": round(z, 4)}
        for ts, x, y, z in db.session.execute(stmt)
    ]
    return jsonify({"total": total, "agregado": balde_s is not None, "balde_s": balde_s, "pontos": pontos})


@api_bp.get("/leituras/recentes")
def leituras_recentes():
    """Modo tempo real.

    Sem 'apos_id': devolve a última janela (padrão 60 s) até a leitura mais nova.
    Com 'apos_id': devolve só o que foi inserido depois desse id.
    """
    device = request.args.get("device_id") or None
    apos_id = request.args.get("apos_id", type=int)
    janela_s = min(max(request.args.get("janela_s", 60, type=int), 1), 600)

    conds = [Leitura.device_id == device] if device else []
    colunas = (Leitura.id, Leitura.ts, Leitura.x, Leitura.y, Leitura.z)

    if apos_id:
        stmt = select(*colunas).where(*conds, Leitura.id > apos_id).order_by(Leitura.id)
    else:
        ultimo_ts = db.session.scalar(select(func.max(Leitura.ts)).where(*conds))
        if ultimo_ts is None:
            return jsonify({"ultimo_id": 0, "pontos": []})
        stmt = (
            select(*colunas)
            .where(*conds, Leitura.ts >= ultimo_ts - timedelta(seconds=janela_s))
            .order_by(Leitura.ts)
        )

    linhas = db.session.execute(stmt.limit(LIMITE_RECENTES)).all()
    ultimo_id = max((linha.id for linha in linhas), default=apos_id or 0)
    pontos = [{"t": _ms(ts), "x": x, "y": y, "z": z} for _, ts, x, y, z in linhas]
    return jsonify({"ultimo_id": ultimo_id, "pontos": pontos})


@api_bp.get("/estatisticas")
def estatisticas():
    conds = _filtros()
    eixos = (Leitura.x, Leitura.y, Leitura.z)
    agregados = [func.count()]
    for col in eixos:
        agregados += [func.min(col), func.max(col), func.avg(col), func.stddev_samp(col)]
    linha = db.session.execute(select(*agregados).where(*conds)).one()

    def _f(v):
        return None if v is None else float(v)

    resultado = {"total": linha[0], "eixos": {}}
    for i, nome in enumerate("xyz"):
        mn, mx, media, desvio = linha[1 + i * 4: 5 + i * 4]
        resultado["eixos"][nome] = {"min": _f(mn), "max": _f(mx), "media": _f(media), "desvio": _f(desvio)}

    ultima = db.session.execute(
        select(Leitura.ts, *eixos).where(*conds).order_by(Leitura.ts.desc()).limit(1)
    ).first()
    resultado["ultima"] = (
        {"t": _ms(ultima.ts), "x": ultima.x, "y": ultima.y, "z": ultima.z} if ultima else None
    )
    return jsonify(resultado)


@api_bp.get("/leituras.csv")
def exportar_csv():
    """CSV em streaming. ?excel=1 usa ';' e vírgula decimal (Excel em português)."""
    conds = _filtros()
    excel = request.args.get("excel") == "1"
    sep = ";" if excel else ","

    def num(v):
        s = f"{v:.3f}"
        return s.replace(".", ",") if excel else s

    stmt = (
        select(Leitura.ts, Leitura.device_id, Leitura.x, Leitura.y, Leitura.z)
        .where(*conds)
        .order_by(Leitura.ts)
        .execution_options(yield_per=5000)
    )

    def gerar():
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=sep)
        if excel:
            buf.write("﻿")  # BOM para o Excel reconhecer UTF-8
        w.writerow(["ts", "device_id", "x", "y", "z"])
        for i, (ts, device_id, x, y, z) in enumerate(db.session.execute(stmt), 1):
            w.writerow([ts.isoformat(timespec="milliseconds"), device_id, num(x), num(y), num(z)])
            if i % 1000 == 0:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    nome = f"leituras_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(
        stream_with_context(gerar()),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{nome}"'},
    )
