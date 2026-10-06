FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 5000

# Um processo com várias threads: suficiente para alguns dispositivos + dashboard,
# e evita que vários workers rodem o create_all() ao mesmo tempo.
# keep-alive de 5 s permite ao microcontrolador reaproveitar a conexão entre lotes.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "8", \
     "--keep-alive", "5", "--access-logfile", "-", "app:create_app()"]
