"""Simula um microcontrolador enviando lotes para a API (sem dependências externas).

Uso:
    python scripts/simular_esp32.py --chave troque-esta-chave
    python scripts/simular_esp32.py --url http://localhost:5000/api/leituras --device sim-01 --hz 100
    python scripts/simular_esp32.py --tipo energia --chave troque-esta-chave
"""
import argparse
import json
import math
import random
import time
import urllib.error
import urllib.request

# tipo -> (rota, device padrão, Hz padrão, amostras por POST padrão)
TIPOS = {
    "aceleracao": ("/api/leituras", "simulador-01", 100, 50),
    "energia": ("/api/energia", "simulador-energia-01", 1, 2),
}


def amostra_aceleracao(s):
    # vibração de 5 Hz + ruído, com a gravidade no eixo Z
    return {
        "x": round(0.8 * math.sin(2 * math.pi * 5 * s) + random.gauss(0, 0.05), 3),
        "y": round(0.4 * math.sin(2 * math.pi * 1.3 * s + 1) + random.gauss(0, 0.05), 3),
        "z": round(9.81 + 0.2 * math.sin(2 * math.pi * 0.5 * s) + random.gauss(0, 0.05), 3),
    }


def amostra_energia(s):
    # rede de 220 V oscilando devagar e uma carga que alterna entre ~1 A e ~5 A a cada 30 s
    tensao = 220 + 3 * math.sin(2 * math.pi * s / 120) + random.gauss(0, 0.3)
    corrente = (5.0 if int(s // 30) % 2 else 1.0) + random.gauss(0, 0.05)
    potencia = tensao * corrente * 0.92  # fator de potência fixo
    return {"tensao": round(tensao, 1), "corrente": round(corrente, 3), "potencia": round(potencia, 1)}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tipo", choices=TIPOS, default="aceleracao")
    p.add_argument("--url", help="padrão: http://localhost:5000 + rota do tipo")
    p.add_argument("--chave", default="troque-esta-chave", help="valor do API_KEY do .env")
    p.add_argument("--device")
    p.add_argument("--hz", type=float, help="amostras por segundo")
    p.add_argument("--lote", type=int, help="amostras por POST")
    args = p.parse_args()

    rota, device, hz, lote = TIPOS[args.tipo]
    url = args.url or "http://localhost:5000" + rota
    device = args.device or device
    hz = args.hz or hz
    lote = args.lote or lote
    gerar = amostra_energia if args.tipo == "energia" else amostra_aceleracao

    inicio = time.monotonic()
    millis = lambda: int((time.monotonic() - inicio) * 1000)  # noqa: E731
    periodo = 1 / hz

    print(f"Enviando para {url} como '{device}' ({hz:g} Hz, lotes de {lote}). Ctrl+C para parar.")
    while True:
        leituras = []
        for _ in range(lote):
            t = millis()
            leituras.append({"t": t, **gerar(t / 1000)})
            time.sleep(periodo)

        corpo = json.dumps({"device_id": device, "enviado_ms": millis(), "leituras": leituras}).encode()
        req = urllib.request.Request(
            url,
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
