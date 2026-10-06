import logging
import os
import time

from flask import Flask
from sqlalchemy.exc import OperationalError

from . import timescale
from .models import Leitura, db

log = logging.getLogger(__name__)


def create_app():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://sensor:sensor123@localhost:5432/sensoriamento",
    )
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}
    app.config["API_KEY"] = os.environ.get("API_KEY", "")
    app.json.ensure_ascii = False

    if not app.config["API_KEY"]:
        log.warning("API_KEY não definida: POST /api/leituras vai recusar todos os envios.")

    db.init_app(app)

    from .api import api_bp
    from .dashboard import dashboard_bp

    app.register_blueprint(api_bp)
    app.register_blueprint(dashboard_bp)

    _criar_tabelas(app)
    return app


def _criar_tabelas(app, tentativas=10):
    """Cria a tabela e a estrutura do TimescaleDB, esperando o Postgres ficar disponível."""
    with app.app_context():
        for tentativa in range(1, tentativas + 1):
            try:
                with db.engine.begin() as conn:
                    # Só 'leituras': 'leituras_1s' é um agregado contínuo criado pelo timescale.py.
                    Leitura.__table__.create(conn, checkfirst=True)
                    timescale.configurar(conn)
                return
            except OperationalError:
                if tentativa == tentativas:
                    raise
                log.warning("Banco indisponível (tentativa %d/%d), aguardando...", tentativa, tentativas)
                time.sleep(2)
