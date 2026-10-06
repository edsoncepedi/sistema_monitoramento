import logging
import os
import time

from flask import Flask
from sqlalchemy.exc import OperationalError

from .models import db

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
    """Cria as tabelas, esperando o Postgres ficar disponível."""
    with app.app_context():
        for tentativa in range(1, tentativas + 1):
            try:
                db.create_all()
                return
            except OperationalError:
                if tentativa == tentativas:
                    raise
                log.warning("Banco indisponível (tentativa %d/%d), aguardando...", tentativa, tentativas)
                time.sleep(2)
