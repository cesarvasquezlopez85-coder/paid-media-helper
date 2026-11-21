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
import threading
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


# --- Idioma de la respuesta ---------------------------------------------------------------------------
# Los datos y las instrucciones van en español; si la persona usa la plataforma en inglés, se le pide a Claude que
# escriba su respuesta en inglés. Lo que valida el código (llaves del JSON, valores fijos, ids, términos de
# búsqueda y nombres de campañas) no cambia de idioma.
def idioma_valido(lang):
    return "en" if lang == "en" else "es"


def _con_idioma(system, lang):
    if idioma_valido(lang) != "en":
        return system
    return (
        system + "\n\nIDIOMA DE LA RESPUESTA: escribe todo el texto que redactes (párrafos, razones, preguntas, nombres de "
        "temas y de grupos) en inglés claro y profesional, aunque las instrucciones y los datos estén en español. "
        "No traduzcas las llaves del JSON, los valores fijos (como FRASE o EXACTA), los ids, los nombres de campañas "
        "ni los términos de búsqueda ni las palabras negativas que propongas: esos se dejan tal como están en los datos."
    )


# --- Consumo de tokens -------------------------------------------------------------------------------
# Cada llamado a Claude suma sus tokens (y cuántos llamados fueron) a un contador del hilo que atiende la
# petición: el servidor lo abre con begin_usage() y lo cierra con end_usage() para guardarlo por usuario y
# por día (ver track_ai_usage en server.py). Se anota también cuando la respuesta termina mal (cortada o
# rechazada), porque esos tokens se cobran igual.
_usage_tls = threading.local()

# USD por millón de tokens (entrada, salida), precios de lista. Si cambian, se ajustan aquí.
PRICES_PER_MILLION = {"claude-opus-5": (5.0, 25.0)}


def begin_usage():
    _usage_tls.rec = {"calls": 0, "input": 0, "output": 0}


def _note_usage(payload):
    rec = getattr(_usage_tls, "rec", None)
    if rec is None:
        return
    usage = payload.get("usage") or {}
    rec["calls"] += 1
    # Los tokens de caché cuentan como entrada; hoy no se usa caché, así que suelen ser 0.
    rec["input"] += int(usage.get("input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0)
    rec["output"] += int(usage.get("output_tokens") or 0)


def estimate_cost(input_tokens, output_tokens, model=None):
    price_in, price_out = PRICES_PER_MILLION.get(model or MODEL, (0.0, 0.0))
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def end_usage():
    """Cierra el contador del hilo y devuelve {"calls", "input", "output", "cost_usd"}."""
    rec = getattr(_usage_tls, "rec", None) or {"calls": 0, "input": 0, "output": 0}
    _usage_tls.rec = None
    return {**rec, "cost_usd": estimate_cost(rec["input"], rec["output"])}


def is_configured():
    return bool(ANTHROPIC_API_KEY)


def _auth_headers():
    return {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    }


def analizar_rendimiento(resumen, recs, lang="es"):
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
        "system": _con_idioma(SYSTEM_PROMPT, lang),
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            _note_usage(payload)
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


def analizar_auditoria(resumen, findings, no_verificables, contexto, lang="es"):
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
        "system": _con_idioma(AUDIT_SYSTEM_PROMPT, lang),
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            _note_usage(payload)
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


# ---------------------------------------------------------------------------
# Generador de copys con IA. Un formato = un conjunto de grupos de texto, cada
# uno con su cantidad y su límite de caracteres. Los límites salen de la ayuda
# de Google Ads (consultada el 2026-11-01): Search (RSA) 15 títulos de 30 y 4
# descripciones de 90; Performance Max 3-15 títulos de 30 (uno de 15 o menos),
# 1-5 títulos largos de 90 y 2-5 descripciones de 90; Video (acción) 30/90/90 y
# botón de 10; In-feed 2 líneas de 40 y 2 de 35. Demand Gen (títulos de 40 y
# descripciones de 90, hasta 5) NO aparece en la página oficial que se pudo
# leer: está por verificar en el editor de Google Ads.
# ---------------------------------------------------------------------------

COPY_FORMATS = {
    "search": {
        "label": "Search (anuncio de búsqueda responsivo)",
        "groups": [
            {"key": "titulares", "label": "Títulos", "count": 15, "limit": 30, "kind": "headline"},
            {"key": "descripciones", "label": "Descripciones", "count": 4, "limit": 90, "kind": "description"},
        ],
    },
    "pmax": {
        "label": "Performance Max (grupo de recursos)",
        "groups": [
            {"key": "titulares", "label": "Títulos", "count": 15, "limit": 30, "kind": "headline", "need_short": 15},
            {"key": "titulares_largos", "label": "Títulos largos", "count": 5, "limit": 90, "kind": "headline"},
            {"key": "descripciones", "label": "Descripciones", "count": 5, "limit": 90, "kind": "description"},
        ],
        "note": "El nombre del negocio (máx. 25) debe coincidir con el nombre verificado o el dominio, y el botón de acción se elige en Google Ads: aquí no se generan.",
    },
    "dgen": {
        "label": "Demand Gen",
        "groups": [
            {"key": "titulares", "label": "Títulos", "count": 5, "limit": 40, "kind": "headline"},
            {"key": "descripciones", "label": "Descripciones", "count": 5, "limit": 90, "kind": "description"},
        ],
        "note": "Límites de Demand Gen por verificar en el editor de Google Ads: su página oficial de especificaciones no los lista. El nombre del negocio (máx. 25) va aparte.",
    },
    "meta": {
        "label": "Meta (Facebook e Instagram)",
        "groups": [
            {"key": "textos_principales", "label": "Texto principal", "count": 5, "limit": 125, "kind": "description"},
            {"key": "titulares", "label": "Titulares", "count": 5, "limit": 27, "kind": "headline"},
            {"key": "descripciones", "label": "Descripciones del enlace", "count": 3, "limit": 30, "kind": "headline"},
        ],
        "note": "Límites recomendados por Meta para el feed (texto principal de 50 a 150, se corta con \"Ver más\" cerca de 125; titular de 27); verifícalos en el Administrador de anuncios. El botón de acción se elige de una lista de Meta, aquí no se genera.",
        "extra": "Es publicidad para redes sociales: tono más conversacional y cercano que en buscadores, puede abrir con una pregunta o una imagen mental, pero sin referirte a características personales de quien lo lee (edad, estado civil, salud, etc.) y sin prometer resultados.",
    },
    "youtube": {
        "label": "YouTube (video)",
        "groups": [
            {"key": "titulares", "label": "Títulos (video)", "count": 5, "limit": 30, "kind": "headline"},
            {"key": "titulares_largos", "label": "Títulos largos (video)", "count": 5, "limit": 90, "kind": "headline"},
            {"key": "descripciones", "label": "Descripciones (video)", "count": 5, "limit": 90, "kind": "description"},
            {"key": "botones", "label": "Texto del botón", "count": 3, "limit": 10, "kind": "cta"},
            {"key": "infeed_titulares", "label": "In-feed: líneas de título", "count": 6, "limit": 40, "kind": "headline"},
            {"key": "infeed_descripciones", "label": "In-feed: líneas de descripción", "count": 6, "limit": 35, "kind": "description"},
        ],
        "note": "El anuncio in-feed usa 2 líneas de título (40) y 2 de descripción (35): se dan líneas sueltas para combinar.",
    },
}

COPY_LANGUAGES = {"es": "español", "en": "inglés", "pt": "portugués"}
COPY_MAX_TOKENS = 3000
COPY_TIMEOUT_SECONDS = 90
# Afirmaciones que Google suele rechazar o que el hotel no puede respaldar: solo se aceptan si la página ya las dice.
COPY_RISKY_WORDS = ("mejor", "número 1", "numero 1", "n.º 1", "#1", "garantizad", "único", "unico", "líder", "lider",
                    "el más", "la más", "best", "number one", "guarantee", "melhor", "garantid")
COPY_EMOJI_RE = None  # se compila al primer uso (re no está importado arriba)

COPY_SYSTEM_PROMPT = (
    "Eres un redactor publicitario senior de Google Ads especializado en hoteles. Escribes textos para anuncios a "
    "partir de lo que dice una página web del hotel.\n\n"
    "REGLAS ESTRICTAS:\n"
    "1. Usa SOLO hechos que aparezcan en los datos de la página (nombre, ciudad, servicios, ofertas). No inventes "
    "precios, descuentos, estrellas, premios, cercanías ni servicios. Si un dato no está, no lo menciones.\n"
    "2. Prohibido: superlativos y promesas absolutas (mejor, número 1, garantizado, único, líder) salvo que la "
    "página los diga literalmente. Nada de emojis, nada de TODO EN MAYÚSCULAS, sin signos de exclamación en títulos "
    "y como máximo uno en una descripción. No nombres a otras marcas.\n"
    "3. Respeta el límite de caracteres de cada grupo contando espacios; cada texto debe ser distinto de los demás "
    "y aportar un ángulo diferente (ubicación, servicio, oferta, motivo para reservar, llamada a la acción).\n"
    "4. Escribe en el idioma pedido (sin mezclar idiomas: nada de \"off\", \"free\" o \"check-in\" si el idioma es español, salvo nombres propios), con ortografía y tildes correctas, en un tono cálido y directo.\n"
    "5. Responde SOLO con un objeto JSON válido, sin texto antes ni después ni bloques de código, con esta forma: "
    "{\"grupos\": {\"<clave>\": [\"texto\", ...], ...}}."
)


def _copy_http(system, user_content):
    body = {
        "model": MODEL,
        "max_tokens": COPY_MAX_TOKENS,
        "output_config": {"effort": "medium"},
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=COPY_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            _note_usage(payload)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Claude: {e.reason}") from e
    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("Claude no generó una respuesta para esta página (refusal).")
    text = "\n".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text").strip()
    if not text:
        raise RuntimeError("Claude no devolvió texto en la respuesta.")
    return text


def _parse_copy_json(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("La respuesta de Claude no trae un JSON válido.")
    data = json.loads(text[start:end + 1])
    grupos = data.get("grupos") if isinstance(data, dict) else None
    if not isinstance(grupos, dict):
        raise RuntimeError("La respuesta de Claude no trae el campo 'grupos'.")
    return grupos


def _page_corpus(signals):
    """Todo el texto de la página que se le mostró a Claude, en minúsculas: sirve para comprobar que un
    número o una afirmación del copy sí sale de la página."""
    parts = [signals.get("title"), signals.get("meta_description"), signals.get("h1"), signals.get("brand"), signals.get("keyword"), signals.get("domain")]
    for k in ("h2s", "li_texts", "cta_texts", "offers"):
        parts += [str(x) for x in (signals.get(k) or [])]
    return " ".join(str(p) for p in parts if p).lower()


def _copy_item_ok(text, group, corpus):
    import re as _re
    global COPY_EMOJI_RE
    if COPY_EMOJI_RE is None:
        COPY_EMOJI_RE = _re.compile("[\U0001F300-\U0001FAFF☀-➿⭐⬆️]")
    if not text or len(text) > group["limit"]:
        return False
    if COPY_EMOJI_RE.search(text):
        return False
    kind = group["kind"]
    if kind in ("headline", "cta") and "!" in text:
        return False
    if text.count("!") > 1:
        return False
    letters = [w for w in _re.findall(r"[A-Za-zÁÉÍÓÚÑÜáéíóúñü]{4,}", text)]
    if letters and sum(1 for w in letters if w.isupper()) >= 2:
        return False
    low = text.lower()
    for num in _re.findall(r"\d+(?:[.,]\d+)?", text):
        if num not in corpus:
            return False
    for word in COPY_RISKY_WORDS:
        if word in low and word not in corpus:
            return False
    return True


def generar_copys(formato, signals, idioma="es", keywords=""):
    """Devuelve {"formato", "label", "note", "groups": [{key,label,limit,count,items:[{text,chars}],short}]}.
    Pide un poco más de lo necesario, valida largos y afirmaciones, y si falta algo repite una vez solo lo que falta."""
    spec = COPY_FORMATS.get(formato)
    if not spec:
        raise ValueError("Formato no válido.")
    idioma_txt = COPY_LANGUAGES.get(idioma, "español")
    sig = {k: signals.get(k) for k in ("title", "meta_description", "h1", "h2s", "li_texts", "cta_texts", "offers", "brand", "keyword", "domain")}
    corpus = _page_corpus(sig)
    kw = (keywords or "").strip()[:300]
    accepted = {g["key"]: [] for g in spec["groups"]}

    def request_missing(groups_needed):
        lines = []
        for g, n in groups_needed:
            extra = f" Incluye al menos 3 de 15 caracteres o menos." if g.get("need_short") and not any(len(t) <= g["need_short"] for t in accepted[g["key"]]) else ""
            have = accepted[g["key"]]
            avoid = f" Ya existen (no los repitas): {json.dumps(have, ensure_ascii=False)}." if have else ""
            lines.append(f"- clave \"{g['key']}\" ({g['label']}): {n} textos de máximo {g['limit']} caracteres.{extra}{avoid}")
        user_content = (
            f"Formato: {spec['label']}. Idioma: {idioma_txt}.\n"
            + (f"Palabras clave que el equipo quiere que aparezcan cuando encajen: {kw}\n" if kw else "")
            + (f"Indicación del formato: {spec['extra']}\n" if spec.get("extra") else "")
            + "\nDatos de la página (lo único que puedes afirmar):\n" + json.dumps(sig, ensure_ascii=False)
            + "\n\nEscribe estos grupos:\n" + "\n".join(lines)
        )
        return _parse_copy_json(_copy_http(COPY_SYSTEM_PROMPT, user_content))

    for attempt in range(2):
        needed = []
        for g in spec["groups"]:
            have = accepted[g["key"]]
            missing = g["count"] - len(have)
            if g.get("need_short") and not any(len(t) <= g["need_short"] for t in have):
                missing = max(missing, 3)
            if missing > 0:
                # pedir de más la primera vez: algunos textos no pasarán la validación
                needed.append((g, missing + (4 if attempt == 0 else 3)))
        if not needed:
            break
        grupos = request_missing(needed)
        for g, _n in needed:
            seen = {t.lower() for t in accepted[g["key"]]}
            for raw in grupos.get(g["key"], []) or []:
                text = " ".join(str(raw).split()).strip().strip('"').strip()
                if text.lower() in seen or not _copy_item_ok(text, g, corpus):
                    continue
                seen.add(text.lower())
                accepted[g["key"]].append(text)

    out_groups = []
    for g in spec["groups"]:
        items = accepted[g["key"]][:g["count"]]
        if g.get("need_short") and items and not any(len(t) <= g["need_short"] for t in items):
            short = next((t for t in accepted[g["key"]][g["count"]:] if len(t) <= g["need_short"]), None)
            if short:
                items[-1] = short
        out_groups.append({
            "key": g["key"], "label": g["label"], "limit": g["limit"], "count": g["count"],
            "items": [{"text": t, "chars": len(t)} for t in items],
            "short": len(items) < g["count"],
            "need_short": g.get("need_short"),
        })
    return {"formato": formato, "label": spec["label"], "note": spec.get("note", ""), "groups": out_groups}


# ---------------------------------------------------------------------------
# Textos de «Anuncios nuevos» con IA: la persona escribe solo las indicaciones (qué debe tener en cuenta) y Claude redacta
# los títulos (hasta 30 caracteres) y las descripciones (hasta 90) de un anuncio de búsqueda adaptable. La IA propone y el
# código valida: largo, duplicados, emojis, mayúsculas, exclamaciones, cifras y afirmaciones que no estén en las
# indicaciones, y que solo se usen las variables permitidas.
# ---------------------------------------------------------------------------
ADTEXT_LANGUAGES = {"es": "español", "en": "inglés", "pt": "portugués", "de": "alemán", "fr": "francés", "it": "italiano", "nl": "neerlandés"}
ADTEXT_BRIEF_MAX = 2000
ADTEXT_HEAD_MAX = 30
ADTEXT_DESC_MAX = 90
ADTEXT_HOTEL_SAMPLE = "Hotel Estelar Mar"  # largo típico de un nombre de hotel (17): sirve solo para medir los textos con {HOTEL}

ADTEXT_SYSTEM_PROMPT = (
    "Eres un redactor publicitario senior de Google Ads especializado en hoteles. Escribes los títulos y las "
    "descripciones de un anuncio de búsqueda adaptable a partir de las indicaciones del equipo.\n\n"
    "REGLAS ESTRICTAS:\n"
    "1. Usa SOLO hechos que estén en las indicaciones (hotel, destino, servicios, ofertas, fechas, públicos). No inventes "
    "precios, descuentos, estrellas, premios, cercanías, políticas ni servicios. Si un dato no está, no lo menciones. "
    "Si las indicaciones traen una condición (fechas, mínimo de noches, código), respétala tal cual.\n"
    "2. Prohibido: superlativos y promesas absolutas (mejor, número 1, garantizado, único, líder) salvo que las "
    "indicaciones los pidan literalmente. Nada de emojis, nada de TODO EN MAYÚSCULAS, sin signos de exclamación en "
    "los títulos y como máximo uno en una descripción. No nombres a otras marcas.\n"
    "3. Respeta el límite de caracteres de cada grupo contando espacios. Cada texto debe ser distinto de los demás y "
    "aportar un ángulo diferente (destino, servicio, oferta, motivo para reservar, llamada a la acción). Los títulos "
    "deben tener sentido solos y también combinados entre sí en cualquier orden; no repitas la misma idea con otras "
    "palabras.\n"
    "4. Escribe en el idioma pedido, sin mezclar idiomas (salvo nombres propios), con ortografía y tildes correctas, en "
    "un tono cálido y directo.\n"
    "5. Posiciones fijadas (pin): cada texto lleva \"posicion\" 0 (sin fijar, lo normal), 1 o 2. Usa 1 o 2 SOLO si las "
    "indicaciones piden explícitamente fijar un texto en el título o la descripción 1 o 2 (por ejemplo: \"el título 1 "
    "debe ser el nombre del hotel\"). Si fijas, entrega al menos 2 textos distintos para esa posición para que Google "
    "pueda alternar, y el resto con posicion 0.\n"
    "6. Responde SOLO con un objeto JSON válido, sin texto antes ni después ni bloques de código, con esta forma: "
    "{\"grupos\": {\"titulares\": [{\"texto\": \"...\", \"posicion\": 0}, ...], \"descripciones\": [{\"texto\": \"...\", \"posicion\": 0}, ...]}}."
)

ADTEXT_MAX_TOKENS = 4000
_ADTEXT_ITEM = {"type": "object", "properties": {"texto": {"type": "string"}, "posicion": {"type": "integer"}},
                "required": ["texto", "posicion"], "additionalProperties": False}
ADTEXT_SCHEMA = {
    "type": "object",
    "properties": {"grupos": {"type": "object", "properties": {
        "titulares": {"type": "array", "items": _ADTEXT_ITEM},
        "descripciones": {"type": "array", "items": _ADTEXT_ITEM}},
        "required": ["titulares", "descripciones"], "additionalProperties": False}},
    "required": ["grupos"], "additionalProperties": False,
}

_ADTEXT_VAR_RE = None


def _adtext_vars_ok(text, variables, mode):
    """Valida las llaves del texto: en el modo simple no se permiten; en el de plantilla solo las variables dadas.
    Devuelve el texto medido (con las variables sustituidas) o None si no es válido."""
    import re as _re
    global _ADTEXT_VAR_RE
    if _ADTEXT_VAR_RE is None:
        _ADTEXT_VAR_RE = _re.compile(r"\{([^{}]*)\}")
    if mode != "plantilla":
        return None if ("{" in text or "}" in text) else text
    measured = text
    for name in _ADTEXT_VAR_RE.findall(text):
        key = name.strip().upper()
        if key not in variables:
            return None
        measured = measured.replace("{" + name + "}", variables[key])
    if "{" in measured or "}" in measured:
        return None
    return measured


def generar_textos_anuncio(indicaciones, idioma="es", mode="simple", variables=None):
    """Devuelve {"titulares": [...], "descripciones": [...], "pines": {"titulares": [0|1|2, ...], "descripciones": [...]},
    "faltan": {"titulares": n, "descripciones": n}}; los pines van alineados con los textos (0 = sin fijar).
    `mode`: «simple» (15 títulos y 4 descripciones, sin variables) o «plantilla» (20 títulos y 6 descripciones; pueden
    usar {HOTEL} y las variables dadas, que el servidor sustituye por cada hotel). Pide de más, valida y, si falta, repite
    una vez solo lo que falta."""
    brief = " ".join(str(indicaciones or "").split())[:ADTEXT_BRIEF_MAX]
    if len(brief) < 15:
        raise ValueError("Escribe las indicaciones: qué debe tener en cuenta el anuncio (hotel o destino, oferta, fechas, servicios, público…).")
    idioma_txt = ADTEXT_LANGUAGES.get(idioma) or f"el idioma con código ISO «{idioma}»"
    plantilla = mode == "plantilla"
    # Variables permitidas (en mayúsculas) y el valor con el que se mide el largo de los textos que las usan.
    vars_ok = {}
    if plantilla:
        vars_ok["HOTEL"] = ADTEXT_HOTEL_SAMPLE
        for key, value in (variables or {}).items():
            k = str(key or "").strip().upper()
            if k and k != "HOTEL":
                vars_ok[k] = str(value or "").strip() or "Valor"
    groups = [
        {"key": "titulares", "label": "títulos", "count": 20 if plantilla else 15, "limit": ADTEXT_HEAD_MAX, "kind": "headline"},
        {"key": "descripciones", "label": "descripciones", "count": 6 if plantilla else 4, "limit": ADTEXT_DESC_MAX, "kind": "description"},
    ]
    corpus = brief.lower() + " " + " ".join(str(v).lower() for v in (variables or {}).values())
    accepted = {g["key"]: [] for g in groups}
    pins = {g["key"]: [] for g in groups}
    var_rule = ""
    if plantilla:
        names = ", ".join("{" + k + "}" for k in vars_ok)
        var_rule = (
            f"\nEste texto es una PLANTILLA que se aplica a muchos hoteles: donde haga falta el nombre del hotel escribe {{HOTEL}} "
            f"(se sustituye por el nombre de cada hotel; no escribas ningún nombre de hotel concreto). Variables permitidas: {names}. "
            "No uses ninguna otra llave. Pon primero los textos que usan variables y deja varios genéricos, sin variables, de "
            "reserva (hay hoteles con nombres largos y el texto con {HOTEL} puede no caber). Cuenta {HOTEL} como unos 17 caracteres.\n"
            + (f"Valores por defecto de las variables personalizadas: {json.dumps({k: v for k, v in vars_ok.items() if k != 'HOTEL'}, ensure_ascii=False)}\n" if len(vars_ok) > 1 else "")
        )
    else:
        var_rule = "\nEl mismo texto se usará en muchas cuentas: no uses llaves ni variables.\n"

    def ask(needed):
        lines = []
        for g, n in needed:
            have = accepted[g["key"]]
            avoid = f" Ya existen (no los repitas): {json.dumps(have, ensure_ascii=False)}." if have else ""
            lines.append(f"- clave \"{g['key']}\" ({g['label']}): {n} textos de máximo {g['limit']} caracteres.{avoid}")
        user_content = (
            f"Idioma de los textos: {idioma_txt}.\n{var_rule}\n"
            f"Indicaciones del equipo (lo único que puedes afirmar):\n\"\"\"\n{brief}\n\"\"\"\n\n"
            "Escribe estos grupos:\n" + "\n".join(lines)
        )
        data = _hotel_json_call(ADTEXT_SYSTEM_PROMPT, ADTEXT_SCHEMA, user_content, max_tokens=ADTEXT_MAX_TOKENS)
        grupos = data.get("grupos")
        if not isinstance(grupos, dict):
            raise RuntimeError("La respuesta de Claude no trae el campo 'grupos'.")
        return grupos

    for attempt in range(2):
        needed = []
        for g in groups:
            missing = g["count"] - len(accepted[g["key"]])
            if missing > 0:
                needed.append((g, missing + (4 if attempt == 0 else 3)))
        if not needed:
            break
        grupos = ask(needed)
        for g, _n in needed:
            seen = {t.lower() for t in accepted[g["key"]]}
            for raw_item in grupos.get(g["key"], []) or []:
                raw = raw_item.get("texto") if isinstance(raw_item, dict) else raw_item
                pin = raw_item.get("posicion") if isinstance(raw_item, dict) else 0
                pin = pin if pin in (1, 2) else 0
                text = " ".join(str(raw or "").split()).strip().strip('"').strip()
                if not text or text.lower() in seen:
                    continue
                measured = _adtext_vars_ok(text, vars_ok, mode)
                if measured is None:
                    continue
                # Las llaves no cuentan como cifras ni como palabras: se valida el texto con las variables ya sustituidas.
                if not _copy_item_ok(measured, g, corpus + " " + ADTEXT_HOTEL_SAMPLE.lower()):
                    continue
                seen.add(text.lower())
                accepted[g["key"]].append(text)
                pins[g["key"]].append(pin)
    out = {g["key"]: accepted[g["key"]][:g["count"]] for g in groups}
    out["pines"] = {g["key"]: pins[g["key"]][:g["count"]] for g in groups}
    out["faltan"] = {g["key"]: max(0, g["count"] - len(out[g["key"]])) for g in groups}
    return out


# ---------------------------------------------------------------------------
# Textos de Performance Max con IA: igual que los de Anuncios nuevos (la IA propone y el código valida), pero con los tres
# grupos de un grupo de recursos: títulos (hasta 30), títulos largos (hasta 90) y descripciones (hasta 90, una de 60 o menos).
# Siempre es plantilla: pueden llevar {HOTEL}. El idioma de los textos lo elige la persona (`idioma`), por eso aquí no se
# aplica _con_idioma: pediría los textos en el idioma de la pantalla y chocaría con el idioma pedido.
# ---------------------------------------------------------------------------
PMXTEXT_LONG_MAX = 90
PMXTEXT_SHORT_DESC_MAX = 60
PMXTEXT_COUNTS = {"titulares": 15, "titulares_largos": 5, "descripciones": 5}
PMXTEXT_MAX_TOKENS = 5000

PMXTEXT_SYSTEM_PROMPT = (
    "Eres un redactor publicitario senior de Google Ads especializado en hoteles. Escribes los textos de un grupo de "
    "recursos de Performance Max (títulos, títulos largos y descripciones) a partir de las indicaciones del equipo.\n\n"
    "REGLAS ESTRICTAS:\n"
    "1. Usa SOLO hechos que estén en las indicaciones (hotel, destino, servicios, ofertas, fechas, públicos). No inventes "
    "precios, descuentos, estrellas, premios, cercanías, políticas ni servicios. Si un dato no está, no lo menciones. "
    "Si las indicaciones traen una condición (fechas, mínimo de noches, código), respétala tal cual.\n"
    "2. Prohibido: superlativos y promesas absolutas (mejor, número 1, garantizado, único, líder) salvo que las "
    "indicaciones los pidan literalmente. Nada de emojis, nada de TODO EN MAYÚSCULAS, sin signos de exclamación en "
    "los títulos y como máximo uno en una descripción. No nombres a otras marcas.\n"
    "3. Respeta el límite de caracteres de cada grupo contando espacios. Cada texto debe ser distinto de los demás y "
    "aportar un ángulo diferente (destino, servicio, oferta, motivo para reservar, llamada a la acción). En Performance "
    "Max Google combina los textos en cualquier orden y en distintos formatos: cada título debe tener sentido solo y "
    "combinado con otros; los títulos largos son frases completas que funcionan solos; no repitas la misma idea con "
    "otras palabras.\n"
    "4. Escribe en el idioma pedido, sin mezclar idiomas (salvo nombres propios), con ortografía y tildes correctas, en "
    "un tono cálido y directo.\n"
    "5. Responde SOLO con un objeto JSON válido, sin texto antes ni después ni bloques de código, con esta forma: "
    "{\"grupos\": {\"titulares\": [\"...\"], \"titulares_largos\": [\"...\"], \"descripciones\": [\"...\"]}}."
)
PMXTEXT_SCHEMA = {
    "type": "object",
    "properties": {"grupos": {"type": "object", "properties": {
        "titulares": {"type": "array", "items": {"type": "string"}},
        "titulares_largos": {"type": "array", "items": {"type": "string"}},
        "descripciones": {"type": "array", "items": {"type": "string"}}},
        "required": ["titulares", "titulares_largos", "descripciones"], "additionalProperties": False}},
    "required": ["grupos"], "additionalProperties": False,
}


def generar_textos_pmax(indicaciones, idioma="es"):
    """Devuelve {"titulares": [...], "titulares_largos": [...], "descripciones": [...], "faltan": {clave: n}}.
    Objetivo: 15 títulos (hasta 30), 5 títulos largos (hasta 90) y 5 descripciones (hasta 90, al menos una de 60 o
    menos). Todos pueden usar {HOTEL} (el servidor la sustituye por cada hotel). Pide de más, valida y, si falta, repite
    una vez solo lo que falta."""
    brief = " ".join(str(indicaciones or "").split())[:ADTEXT_BRIEF_MAX]
    if len(brief) < 15:
        raise ValueError("Escribe las indicaciones: qué debe tener en cuenta el grupo de recursos (hotel o destino, oferta, fechas, servicios, público…).")
    idioma_txt = ADTEXT_LANGUAGES.get(idioma) or f"el idioma con código ISO «{idioma}»"
    vars_ok = {"HOTEL": ADTEXT_HOTEL_SAMPLE}
    groups = [
        {"key": "titulares", "label": "títulos", "count": PMXTEXT_COUNTS["titulares"], "limit": ADTEXT_HEAD_MAX, "kind": "headline"},
        {"key": "titulares_largos", "label": "títulos largos", "count": PMXTEXT_COUNTS["titulares_largos"], "limit": PMXTEXT_LONG_MAX, "kind": "headline"},
        {"key": "descripciones", "label": "descripciones", "count": PMXTEXT_COUNTS["descripciones"], "limit": ADTEXT_DESC_MAX, "kind": "description"},
    ]
    corpus = brief.lower() + " " + ADTEXT_HOTEL_SAMPLE.lower()
    accepted = {g["key"]: [] for g in groups}
    short_desc = []  # descripciones aceptadas de 60 caracteres o menos (medidas con el hotel de muestra)
    var_rule = (
        "\nEste texto es una PLANTILLA que se aplica a muchos hoteles: donde haga falta el nombre del hotel escribe {HOTEL} "
        "(se sustituye por el nombre de cada hotel; no escribas ningún nombre de hotel concreto). No uses ninguna otra "
        "llave. Pon primero los textos que usan {HOTEL} y deja varios genéricos, sin variables, de reserva (hay hoteles con "
        "nombres largos y el texto con {HOTEL} puede no caber). Cuenta {HOTEL} como unos 17 caracteres.\n"
    )

    def ask(needed, need_short):
        lines = []
        for g, n in needed:
            have = accepted[g["key"]]
            avoid = f" Ya existen (no los repitas): {json.dumps(have, ensure_ascii=False)}." if have else ""
            extra = ""
            if g["key"] == "descripciones" and need_short:
                extra = f" Al menos una de esas descripciones debe tener {PMXTEXT_SHORT_DESC_MAX} caracteres o menos."
            lines.append(f"- clave \"{g['key']}\" ({g['label']}): {n} textos de máximo {g['limit']} caracteres.{extra}{avoid}")
        user_content = (
            f"Idioma de los textos: {idioma_txt}.\n{var_rule}\n"
            f"Indicaciones del equipo (lo único que puedes afirmar):\n\"\"\"\n{brief}\n\"\"\"\n\n"
            "Escribe estos grupos:\n" + "\n".join(lines)
        )
        data = _hotel_json_call(PMXTEXT_SYSTEM_PROMPT, PMXTEXT_SCHEMA, user_content, max_tokens=PMXTEXT_MAX_TOKENS)
        grupos = data.get("grupos")
        if not isinstance(grupos, dict):
            raise RuntimeError("La respuesta de Claude no trae el campo 'grupos'.")
        return grupos

    for attempt in range(2):
        needed = []
        for g in groups:
            missing = g["count"] - len(accepted[g["key"]])
            if missing > 0:
                needed.append((g, missing + (3 if attempt == 0 else 2)))
        need_short = len(short_desc) == 0
        if not needed and not need_short:
            break
        if need_short and not any(g["key"] == "descripciones" for g, _n in needed):
            # La lista de descripciones ya está completa pero ninguna es corta: se piden unas más, con esa condición.
            needed.append((groups[2], 3))
        grupos = ask(needed, need_short)
        for g, _n in needed:
            seen = {t.lower() for t in accepted[g["key"]]}
            for raw_item in grupos.get(g["key"], []) or []:
                raw = raw_item.get("texto") if isinstance(raw_item, dict) else raw_item
                text = " ".join(str(raw or "").split()).strip().strip('"').strip()
                if not text or text.lower() in seen:
                    continue
                measured = _adtext_vars_ok(text, vars_ok, "plantilla")
                if measured is None:
                    continue
                if not _copy_item_ok(measured, g, corpus):
                    continue
                full = len(accepted[g["key"]]) >= g["count"]
                is_short = g["key"] == "descripciones" and len(measured) <= PMXTEXT_SHORT_DESC_MAX
                # Con la lista llena solo entra una descripción corta si todavía no hay ninguna (reemplaza a la última).
                if full:
                    if is_short and not short_desc:
                        accepted[g["key"]][-1] = text
                        short_desc.append(text)
                        seen.add(text.lower())
                    continue
                seen.add(text.lower())
                accepted[g["key"]].append(text)
                if is_short:
                    short_desc.append(text)
    out = {g["key"]: accepted[g["key"]][:g["count"]] for g in groups}
    out["faltan"] = {g["key"]: max(0, g["count"] - len(out[g["key"]])) for g in groups}
    out["sin_descripcion_corta"] = len(short_desc) == 0
    return out


# ---------------------------------------------------------------------------
# Negativización con IA — Claude decide qué negativizar, qué dejar y qué
# revisar; negativos_ia.py valida con código lo que devuelve (choques con
# términos que convierten, marca, palabras genéricas) antes de mostrarlo.
# ---------------------------------------------------------------------------
NEG_MAX_TOKENS = 16000
NEG_TIMEOUT_SECONDS = 240

NEG_SYSTEM_PROMPT = (
    "Eres un estratega senior de Google Ads especializado en hoteles. Revisas los términos de búsqueda de una "
    "cuenta y decides cuáles conviene negativizar, cuáles dejar y cuáles revisar a mano.\n\n"
    "Recibes un JSON con: el contexto del hotel (nombre o marca, destino, qué ofrece y qué no), las palabras "
    "negativas que ya existen en la cuenta y una lista de términos con id, clics, impresiones, costo y "
    "conversiones del periodo.\n\n"
    "Criterios:\n"
    "- Negativizar es para búsquedas SIN intención de reservar este hotel o este destino: empleo y trabajo, "
    "gratis, otras ciudades o destinos que el hotel no atiende, información o trámites sin relación, servicios "
    "que el hotel no ofrece. Para las marcas de otros hoteles: negativiza solo si hay gasto sin conversiones; "
    "si no, ponlas en revisar.\n"
    "- Nunca negativices un término que tenga conversiones ni uno que contenga el nombre o la marca del hotel.\n"
    "- Con pocos datos (menos de unos 20 clics, sin conversiones) y una intención que podría ser de reserva, no "
    "negativices: deja o revisa. No negativices solo porque no haya convertido todavía.\n"
    "- Agrupa lo que negativizas por tema (por ejemplo: Empleo, Gratis, Otras ciudades, Competencia, "
    "Información). Por cada tema propón las palabras o frases negativas MÁS CORTAS que cubran las variantes sin "
    "bloquear búsquedas buenas. Usa concordancia FRASE para un tema amplio (una palabra que siempre indica mala "
    "intención) y EXACTA para un término puntual. Las negativas NO cubren variantes cercanas (plurales, "
    "errores de escritura): si hace falta, propón las dos formas.\n"
    "- Nunca propongas como negativa una palabra genérica de hotel (hotel, reserva, precio, cerca, barato, "
    "habitación…), el nombre del hotel ni el destino del hotel.\n"
    "- Todos los términos de la lista deben terminar en exactamente un grupo: dentro de un tema a negativizar, "
    "en mantener, o en revisar. Revisar es para lo dudoso, con la pregunta concreta que debe resolver la "
    "persona.\n"
    "- En mantener va solo lo que claramente conviene dejar: el nombre del hotel solo o con intención de "
    "reservar (reservar, precio, tarifa, habitación, disponibilidad, ofertas, cómo llegar a reservar), búsquedas "
    "del destino con intención de alojamiento y todo lo que tenga conversiones. Agrúpalo por motivo, con una "
    "razón breve.\n"
    "- Las búsquedas de la marca con una palabra genérica o informativa NO van en mantener: van en revisar. "
    "Por ejemplo la marca con spa, pasadía, restaurante, eventos, fotos, teléfono, dirección, ubicación, "
    "opiniones, empleo, sitio web o 'www'. Son marca, pero puede que no sirvan a un anunciante de reservas o que "
    "el hotel no ofrezca ese servicio. Agrúpalas por tipo (servicios del hotel, información de contacto o "
    "ubicación, opiniones y fotos, empleo…) y en cada grupo escribe una pregunta concreta que ayude a decidir, "
    "por ejemplo: ¿el hotel ofrece pasadías y quiere captar esas búsquedas, o conviene sacarlas?\n"
    "- No pongas en revisar lo que claramente se queda: no conviertas todo lo de marca en dudoso, solo lo "
    "genérico o informativo.\n"
    "- Las razones son de una o dos frases, en español, concretas y sin relleno.\n\n"
    "Responde SOLO con un JSON válido, sin texto antes ni después, con esta forma exacta:\n"
    "{\"temas\": [{\"tema\": \"...\", \"razon\": \"...\", \"negativas\": [{\"texto\": \"...\", \"concordancia\": "
    "\"FRASE\" o \"EXACTA\"}], \"terminos\": [ids]}], "
    "\"mantener\": [{\"grupo\": \"...\", \"razon\": \"...\", \"terminos\": [ids]}], "
    "\"revisar\": [{\"pregunta\": \"...\", \"terminos\": [ids]}]}\n"
    "En revisar agrupa los términos que comparten la misma duda y escribe la pregunta una sola vez por grupo."
)

_NEG_INT_LIST = {"type": "array", "items": {"type": "integer"}}
# Salida estructurada: garantiza JSON válido con esta forma. Sin ella, la respuesta sin razonamiento
# extendido llegó una vez con un corchete mal cerrado.
NEG_SCHEMA = {
    "type": "object",
    "properties": {
        "temas": {"type": "array", "items": {"type": "object", "properties": {
            "tema": {"type": "string"}, "razon": {"type": "string"},
            "negativas": {"type": "array", "items": {"type": "object", "properties": {
                "texto": {"type": "string"}, "concordancia": {"type": "string", "enum": ["FRASE", "EXACTA"]}},
                "required": ["texto", "concordancia"], "additionalProperties": False}},
            "terminos": _NEG_INT_LIST},
            "required": ["tema", "razon", "negativas", "terminos"], "additionalProperties": False}},
        "mantener": {"type": "array", "items": {"type": "object", "properties": {
            "grupo": {"type": "string"}, "razon": {"type": "string"}, "terminos": _NEG_INT_LIST},
            "required": ["grupo", "razon", "terminos"], "additionalProperties": False}},
        "revisar": {"type": "array", "items": {"type": "object", "properties": {
            "pregunta": {"type": "string"}, "terminos": _NEG_INT_LIST},
            "required": ["pregunta", "terminos"], "additionalProperties": False}},
    },
    "required": ["temas", "mantener", "revisar"], "additionalProperties": False,
}


def _neg_http(user_content, lang="es"):
    body = {
        "model": MODEL,
        "max_tokens": NEG_MAX_TOKENS,
        # Sin razonamiento extendido: con él la respuesta tardaba ~2 min y se cortaba por tamaño; las
        # decisiones de riesgo no dependen del modelo, las valida negativos_ia.py con código.
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": NEG_SCHEMA}},
        "system": _con_idioma(NEG_SYSTEM_PROMPT, lang),
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=NEG_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            _note_usage(payload)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Claude: {e.reason}") from e
    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("Claude no generó una respuesta para estos términos (refusal).")
    if payload.get("stop_reason") == "max_tokens":
        raise RuntimeError("La respuesta de Claude se cortó por tamaño; prueba con un periodo más corto.")
    text = "\n".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text").strip()
    if not text:
        raise RuntimeError("Claude no devolvió texto en la respuesta.")
    return text


def analizar_negativos(user_content, lang="es"):
    """user_content: el JSON armado por negativos_ia.build_user_content.
    Devuelve el dict que respondió Claude (sin validar: eso lo hace negativos_ia)."""
    text = _neg_http(user_content, lang)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("La respuesta de Claude no trae un JSON válido.")
    try:
        data = json.loads(text[start:end + 1])
    except ValueError as e:
        raise RuntimeError("La respuesta de Claude no es un JSON válido.") from e
    if not isinstance(data, dict):
        raise RuntimeError("La respuesta de Claude no trae el formato esperado.")
    return data


# ---------------------------------------------------------------------------
# Hoteles con IA — Claude lee el rendimiento por tramo y el precio frente a la
# competencia de una campaña de hotel y propone modificadores; hoteles_ia.py
# valida con código lo que devuelve (datos mínimos, rangos, saltos, alzas con
# el precio por encima de la competencia) antes de mostrarlo.
# ---------------------------------------------------------------------------
HOTEL_MAX_TOKENS = 4000
HOTEL_TIMEOUT_SECONDS = 120

HOTEL_SYSTEM_PROMPT = (
    "Eres un estratega senior de Google Ads especializado en campañas de Hotel Ads. Analizas una campaña y "
    "propones ajustes a sus modificadores de oferta. Escribes para un equipo de medios pagados, en español claro "
    "y sin relleno.\n\n"
    "Recibes un JSON con: el periodo, la campaña (clics, costo, conversiones, CPA promedio), el precio frente a la "
    "competencia (diferencia de precio promedio con el anunciante más barato en puntos porcentuales: positivo = el "
    "hotel sale más caro; cómo quedó cada impresión; la tendencia reciente) y los tramos de modificadores con su "
    "valor actual y su rendimiento. Un modificador es un multiplicador de la puja base: 1 = sin ajuste, 0,8 = "
    "pujar 20 % menos, 1,3 = 30 % más.\n\n"
    "Criterios:\n"
    "- Empieza por el precio. Si el hotel sale más de 5 % más caro, el problema principal es la tarifa que se "
    "envía a Google Hotel Ads, no la puja: dilo con claridad y NO propongas subir modificadores. Si va a la par o "
    "más barato, el precio no es el obstáculo y los modificadores sí importan.\n"
    "- Propón subir un tramo solo si su evidencia es \"suficiente\" y su CPA es al menos 15 % mejor que el de la "
    "campaña. Propón bajar un tramo si su CPA es al menos 25 % peor, o si gasta sin convertir (evidencia "
    "\"suficiente\" o \"solo_bajar\"). Los tramos con evidencia \"poca\" o \"sin_datos\", y los \"variado_entre_grupos\", "
    "no se tocan: menciónalo en el diagnóstico si es relevante.\n"
    "- Cambios moderados: como máximo 30 % sobre el valor actual por paso, y valores con dos decimales. Nunca "
    "propongas 0 (no servir).\n"
    "- Máximo 6 propuestas, las de más impacto primero. Si nada justifica un cambio, no propongas ninguno y "
    "explícalo en \"sin_cambios\". No inventes cambios para llenar la lista.\n"
    "- Usa SOLO cifras que estén en el JSON; no estimes reservas, ingresos ni mejoras futuras.\n"
    "- El diagnóstico son de 2 a 4 párrafos cortos: primero el precio, luego lo que muestran los tramos, luego "
    "lo que no se puede concluir por falta de datos. Cada razón de una propuesta es una o dos frases con las "
    "cifras del tramo.\n\n"
    "Responde SOLO con un JSON válido con esta forma exacta:\n"
    "{\"diagnostico\": [\"párrafo\"], \"propuestas\": [{\"id\": id del tramo, \"valor\": nuevo modificador, "
    "\"razon\": \"...\"}], \"sin_cambios\": \"texto o cadena vacía\"}"
)

HOTEL_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnostico": {"type": "array", "items": {"type": "string"}},
        "propuestas": {"type": "array", "items": {"type": "object", "properties": {
            "id": {"type": "integer"}, "valor": {"type": "number"}, "razon": {"type": "string"}},
            "required": ["id", "valor", "razon"], "additionalProperties": False}},
        "sin_cambios": {"type": "string"},
    },
    "required": ["diagnostico", "propuestas", "sin_cambios"], "additionalProperties": False,
}


def _hotel_json_call(system, schema, user_content, max_tokens=HOTEL_MAX_TOKENS):
    """Una llamada a Claude con salida estructurada para las funciones de Hoteles. Devuelve el dict (sin validar)."""
    body = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=HOTEL_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            _note_usage(payload)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Claude: {e.reason}") from e
    if payload.get("stop_reason") == "refusal":
        raise RuntimeError("Claude no generó una respuesta para esta campaña (refusal).")
    if payload.get("stop_reason") == "max_tokens":
        raise RuntimeError("La respuesta de Claude se cortó por tamaño.")
    text = "\n".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("La respuesta de Claude no trae un JSON válido.")
    try:
        data = json.loads(text[start:end + 1])
    except ValueError as e:
        raise RuntimeError("La respuesta de Claude no es un JSON válido.") from e
    if not isinstance(data, dict):
        raise RuntimeError("La respuesta de Claude no trae el formato esperado.")
    return data


def analizar_hotel(user_content, lang="es"):
    """user_content: el JSON armado por hoteles_ia.build_input. Devuelve el dict de Claude (sin validar)."""
    return _hotel_json_call(_con_idioma(HOTEL_SYSTEM_PROMPT, lang), HOTEL_SCHEMA, user_content)
