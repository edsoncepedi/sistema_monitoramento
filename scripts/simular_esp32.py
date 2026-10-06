"""Simula um microcontrolador enviando lotes para a API (sem dependências externas).

Uso:
    python scripts/simular_esp32.py --chave troque-esta-chave
    python scripts/simular_esp32.py --url http://localhost:5000/api/leituras --device sim-01 --hz 100
"""
import argparse
import json
import math
import random
import time
import urllib.error
import urllib.request


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://localhost:5000/api/leituras")
    p.add_argument("--chave", default="troque-esta-chave", help="valor do API_KEY do .env")
    p.add_argument("--device", default="simulador-01")
    p.add_argument("--hz", type=float, default=100, help="amostras por segundo")
    p.add_argument("--lote", type=int, default=50, help="amostras por POST")
    args = p.parse_args()

    inicio = time.monotonic()
    millis = lambda: int((time.monotonic() - inicio) * 1000)  # noqa: E731
    periodo = 1 / args.hz

    print(f"Enviando para {args.url} como '{args.device}' ({args.hz:g} Hz, lotes de {args.lote}). Ctrl+C para parar.")
    while True:
        leituras = []
        for _ in range(args.lote):
            t = millis()
            s = t / 1000
            # vibração de 5 Hz + ruído, com a gravidade no eixo Z
            leituras.append({
                "t": t,
                "x": round(0.8 * math.sin(2 * math.pi * 5 * s) + random.gauss(0, 0.05), 3),
                "y": round(0.4 * math.sin(2 * math.pi * 1.3 * s + 1) + random.gauss(0, 0.05), 3),
                "z": round(9.81 + 0.2 * math.sin(2 * math.pi * 0.5 * s) + random.gauss(0, 0.05), 3),
            })
            time.sleep(periodo)

        corpo = json.dumps({"device_id": args.device, "enviado_ms": millis(), "leituras": leituras}).encode()
        req = urllib.request.Request(
            args.url,
            data=corpo,
            headers={"Content-Type": "application/json", "X-API-Key": args.chave},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                print(f"HTTP {r.status} {r.read().decode()}")
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code} {e.read().decode()}")
        except urllib.error.URLError as e:
            print(f"Falha de conexão: {e.reason}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
