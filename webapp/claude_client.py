# Integración con la API de Claude (Anthropic) — análisis narrativo de la
# pantalla de Rendimiento. Como google_ads_client.py, usa urllib en vez del
# SDK oficial `anthropic`: el Dockerfile no corre `pip install` (ver
# webapp/Dockerfile), así que solo hay librería estándar disponible en el
# deploy.
#
# La API key vive solo en el servidor (ANTHROPIC_API_KEY) y nunca se expone
# al navegador — el cliente solo manda resumen/recs ya calculados y recibe
# de vuelta el texto de la narrativa.

import json
import os
import urllib.error
import urllib.request

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
MODEL = "claude-opus-5"
TIMEOUT_SECONDS = 45
MAX_RECS_SENT = 12  # ya vienen ordenados por impacto_gasto desc — basta con los más relevantes

SYSTEM_PROMPT = (
    "Eres un estratega senior de Google Ads que ayuda a un equipo de agencia a "
    "priorizar su trabajo. Te doy un resumen de cuenta y una lista de hallazgos "
    "ya calculados por reglas (CPA alto, presupuesto limitado, CTR bajo, "
    "ranking/Quality Score bajo) para varias campañas, ordenados por cuánto "
    "gasto representan.\n\n"
    "Tu trabajo NO es repetir los números — el equipo ya los ve en pantalla. Tu "
    "trabajo es interpretarlos: en 3-5 párrafos breves, en español, di cuáles "
    "2-3 cosas importan más esta semana y por qué, si hay un patrón que conecta "
    "varios hallazgos (ej. varias campañas del mismo tipo con el mismo "
    "problema), y qué harías primero si tuvieras que elegir. Sé directo y "
    "específico — nombra campañas por su nombre cuando ayude. Escribe en prosa "
    "corrida, sin viñetas ni encabezados, como si se lo explicaras a un "
    "colega. No repitas cifras exactas que ya están en la tabla; refiérete a "
    "ellas en términos relativos (\"la más cara\", \"casi el doble del "
    "óptimo\") cuando haga falta."
)


def is_configured():
    return bool(ANTHROPIC_API_KEY)


def _auth_headers():
    return {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    }


def analizar_rendimiento(resumen, recs):
    """resumen: dict de engine.summarize() (JS) serializado a JSON por el
    cliente. recs: lista de hallazgos de engine.generateRecommendations(),
    ya ordenada por impacto_gasto desc. Devuelve el texto de la narrativa."""
    recs_top = recs[:MAX_RECS_SENT]
    user_content = (
        "Resumen de cuenta:\n" + json.dumps(resumen, ensure_ascii=False) +
        "\n\nHallazgos (ordenados por impacto de gasto, de mayor a menor):\n" +
        json.dumps(recs_top, ensure_ascii=False)
    )
    body = {
        "model": MODEL,
        "max_tokens": 2000,
        "output_config": {"effort": "low"},
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Claude: {e.reason}") from e

    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("Claude no generó una respuesta para estos datos (refusal).")

    text_parts = [
        block.get("text", "") for block in payload.get("content", [])
        if block.get("type") == "text"
    ]
    narrativa = "\n".join(part for part in text_parts if part).strip()
    if not narrativa:
        raise RuntimeError("Claude no devolvió texto en la respuesta.")
    return narrativa


AUDIT_SYSTEM_PROMPT = (
    "Eres un estratega senior de Google Ads especializado en hoteles. Te doy el "
    "resultado de una auditoría estructural de una cuenta: los hallazgos ya "
    "calculados por reglas (con su gravedad), el puntaje, las revisiones que no se "
    "pudieron verificar y el contexto del negocio que llenó el equipo.\n\n"
    "Tu trabajo NO es repetir la lista: el equipo ya la ve en pantalla. En 3-5 "
    "párrafos breves, en español, di por dónde empezarías y por qué, qué hallazgos "
    "comparten una misma causa de fondo, qué corregirías primero para que la "
    "medición sea confiable antes de tocar pujas o presupuestos, y qué dejarías "
    "para después. Usa solo lo que está en los datos: si algo no se pudo "
    "verificar, dilo en vez de suponerlo, y no inventes cifras ni problemas que "
    "no aparezcan. Escribe en prosa corrida, sin viñetas ni encabezados, como se "
    "lo explicarías a un colega."
)


def analizar_auditoria(resumen, findings, no_verificables, contexto):
    """resumen: puntaje y totales de la auditoría. findings: hallazgos (ya
    ordenados por gravedad). Devuelve el texto de la narrativa."""
    user_content = (
        "Contexto del negocio:\n" + json.dumps(contexto, ensure_ascii=False) +
        "\n\nResumen y puntaje:\n" + json.dumps(resumen, ensure_ascii=False) +
        "\n\nHallazgos (de más grave a menos grave):\n" + json.dumps(findings[:25], ensure_ascii=False) +
        "\n\nRevisiones que no se pudieron verificar:\n" + json.dumps(no_verificables[:15], ensure_ascii=False)
    )
    body = {
        "model": MODEL,
        "max_tokens": 2000,
        "output_config": {"effort": "low"},
        "system": AUDIT_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Claude: {e.reason}") from e
    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("Claude no generó una respuesta para estos datos (refusal).")
    text = "\n".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text").strip()
    if not text:
        raise RuntimeError("Claude no devolvió texto en la respuesta.")
    return text
