"""Análisis con IA de una campaña de hotel: arma los datos que ve Claude y valida con código lo que propone.

Claude lee el rendimiento por tramo y el precio frente a la competencia, y propone nuevos modificadores de
oferta con su razón. Nada de lo que devuelve llega a la pantalla sin pasar por build_result: el código descarta
tramos con pocos datos, valores fuera de rango, alzas cuando el problema es de precio y saltos demasiado
grandes. La IA solo propone; aplicar sigue siendo el editor de tramos (vista previa de Google y confirmar).
"""

import datetime
import json
import re

import google_ads_client

MAX_PROPOSALS = 6
MIN_CONVERSIONS = 5          # evidencia suficiente de un tramo: 5+ conversiones...
MIN_CLICKS_NO_CONV = 150     # ...o 150+ clics sin ninguna (basta para bajar la puja, no para subirla)
MAX_STEP_UP = 1.30           # un cambio no puede subir ni bajar más de 30 % sobre el valor vigente
MAX_STEP_DOWN = 0.70
MIN_CHANGE = 0.05            # cambios menores a 0,05 no valen la pena
PRICE_GAP_NO_RAISE = 0.05    # con el hotel más de 5 % más caro que el competidor, no se aceptan alzas
TREND_DAYS = 7
EDITABLE = google_ads_client.HOTEL_EDITABLE_TYPES


def _evidence(perf):
    """'suficiente' | 'solo_bajar' | 'poca' | 'sin_datos' para un tramo."""
    if not perf:
        return "sin_datos"
    if perf["conversions"] >= MIN_CONVERSIONS:
        return "suficiente"
    if perf["conversions"] == 0 and perf["clicks"] >= MIN_CLICKS_NO_CONV:
        return "solo_bajar"
    return "poca"


def _round(x, digits=2):
    return None if x is None else round(x, digits) + 0.0  # + 0.0: evita el -0.0


def _price_block(price):
    """Resumen del precio para la IA, en puntos porcentuales; None si no hay dato."""
    if not price or not price.get("summary"):
        return None
    sm = price["summary"]
    block = {
        "diferencia_precio_pct": _round(sm["price_diff"] * 100) if sm.get("price_diff") is not None else None,
        "impresiones": sm["impressions"],
        "impresiones_elegibles": sm["eligible"],
        "se_mostro_pct": _round(sm["impressions"] / sm["eligible"] * 100, 1) if sm.get("eligible") else None,
    }
    if price.get("buckets"):
        total = sum(b["impressions"] for b in price["buckets"]) or 1
        block["posiciones"] = [{
            "posicion": b["label"], "pct_impresiones": _round(b["impressions"] / total * 100, 1),
            "diferencia_precio_pct": _round(b["price_diff"] * 100) if b["price_diff"] is not None else None,
        } for b in price["buckets"]]
    days = [d["price_diff"] * 100 for d in (price.get("daily") or []) if d.get("price_diff") is not None]
    if len(days) >= TREND_DAYS + 3:
        last, before = days[-TREND_DAYS:], days[:-TREND_DAYS]
        block["tendencia"] = {
            f"ultimos_{TREND_DAYS}_dias_pct": _round(sum(last) / len(last)),
            "dias_anteriores_pct": _round(sum(before) / len(before)),
        }
    return block


def build_input(modifiers, price, moneda, date_from, date_to):
    """Devuelve (user_content, tramos_by_id). user_content es el JSON (str) que recibe Claude."""
    totals = modifiers["totals"]
    avg_cpa = totals["cost"] / totals["conversions"] if totals["conversions"] else None
    tramos, by_id = [], {}
    for t in modifiers["tramos"]:
        if t["type"] not in EDITABLE:
            continue
        tid = len(by_id) + 1
        perf = t.get("perf")
        cpa = perf["cost"] / perf["conversions"] if perf and perf["conversions"] else None
        item = {
            "id": tid,
            "tipo": google_ads_client.HOTEL_MODIFIER_TYPES[t["type"]]["label"],
            "tramo": t["text"],
            "valor_actual": None if t["mixed"] else t["value"],
            "variado_entre_grupos": bool(t["mixed"]),
            "evidencia": _evidence(perf),
        }
        if perf:
            item.update({
                "clics": perf["clicks"], "costo": _round(perf["cost"]), "conversiones": _round(perf["conversions"], 1),
                "cpa": _round(cpa),
                "cpa_vs_campana_pct": _round((cpa / avg_cpa - 1) * 100, 0) if cpa and avg_cpa else None,
            })
        tramos.append(item)
        by_id[tid] = t
    content = {
        "periodo": f"{date_from} a {date_to}",
        "moneda": moneda or "",
        "campana": {
            "nombre": modifiers["campaign_name"], "estrategia_de_puja": modifiers.get("bidding_strategy_type") or "",
            "grupos_de_anuncios": modifiers["ad_groups"], "clics": totals["clicks"], "costo": _round(totals["cost"]),
            "conversiones": _round(totals["conversions"], 1), "cpa_promedio": _round(avg_cpa),
        },
        "precio_frente_a_la_competencia": _price_block(price),
        "tramos": tramos,
    }
    return json.dumps(content, ensure_ascii=False), by_id


def _clean_text(x, limit=700):
    return " ".join(str(x or "").split())[:limit]


def build_result(ai, modifiers, price, by_id, locked):
    """Valida lo que devolvió Claude. Solo salen propuestas que cumplen todas las reglas del código."""
    diag = [_clean_text(p) for p in (ai.get("diagnostico") or []) if _clean_text(p)][:5]
    price_diff = None
    if price and price.get("summary") and price["summary"].get("price_diff") is not None:
        price_diff = price["summary"]["price_diff"]
    totals = modifiers["totals"]
    avg_cpa = totals["cost"] / totals["conversions"] if totals["conversions"] else None

    proposals, dropped, seen = [], [], set()
    if not locked:
        for p in (ai.get("propuestas") or []):
            try:
                tid = int(p.get("id"))
                new = round(float(p.get("valor")), 2)
            except (TypeError, ValueError):
                continue
            t = by_id.get(tid)
            if t is None or tid in seen:
                continue
            seen.add(tid)
            if len(proposals) >= MAX_PROPOSALS:
                dropped.append({"tramo": t["text"], "motivo": f"Solo se muestran las {MAX_PROPOSALS} propuestas principales."})
                continue
            spec = google_ads_client.HOTEL_MODIFIER_TYPES[t["type"]]
            label = f"{spec['label']} · {t['text']}"
            cur = t["value"]
            ev = _evidence(t.get("perf"))
            reason = None
            if t["mixed"] or cur is None:
                reason = "los grupos de anuncios tienen valores distintos en este tramo: conviene igualarlo a mano primero."
            elif new == 0:
                reason = "no se acepta \"no servir\" (0) como propuesta: eso se decide a mano."
            elif ev in ("sin_datos", "poca"):
                reason = "el tramo tiene pocos datos para decidir (menos de 5 conversiones y de 150 clics sin conversión)."
            elif ev == "solo_bajar" and new > cur:
                reason = "sin conversiones no se justifica subir la puja."
            elif price_diff is not None and price_diff > PRICE_GAP_NO_RAISE and new > cur:
                reason = "el hotel sale más de 5 % más caro que el competidor: subir la puja no recupera esas reservas."
            if reason:
                dropped.append({"tramo": label, "motivo": reason})
                continue
            limited = False
            lo, hi = round(cur * MAX_STEP_DOWN, 2), round(cur * MAX_STEP_UP, 2)
            if new > hi:
                new, limited = hi, True
            elif new < lo:
                new, limited = lo, True
            new = round(min(spec["max"], max(spec["min"], new)), 2)
            if abs(new - cur) < MIN_CHANGE:
                dropped.append({"tramo": label, "motivo": "el cambio es demasiado pequeño para valer la pena."})
                continue
            perf = t["perf"]
            cpa = perf["cost"] / perf["conversions"] if perf["conversions"] else None
            proposals.append({
                "type": t["type"], "label": t["label"], "text": t["text"], "tipo_label": spec["label"],
                "actual": cur, "nuevo": new, "limitado": limited,
                "clicks": perf["clicks"], "conversions": _round(perf["conversions"], 1),
                "cpa": _round(cpa), "cpa_vs_campana_pct": _round((cpa / avg_cpa - 1) * 100, 0) if cpa and avg_cpa else None,
                "razon": _clean_text(p.get("razon"), 400),
            })
    return {
        "diagnostico": diag,
        "propuestas": proposals,
        "descartadas": dropped,
        "sin_cambios": _clean_text(ai.get("sin_cambios"), 500),
        "bloqueada": bool(locked),
    }


# ---------------------------------------------------------------------------
# Nota para el revenue manager del hotel. El código arma los datos (todo en porcentajes, sin conteos con
# separador de miles) y revisa que cada cifra del texto salga de ellos; Claude solo redacta.
# ---------------------------------------------------------------------------
NOTE_MIN_GAP = 0.02          # se ofrece la nota si el hotel sale más de 2 % más caro...
NOTE_MIN_NOT_LOWEST = 30.0   # ...o en 30 %+ de las impresiones no es el más barato
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")


def _not_lowest_share(price):
    buckets = price.get("buckets") or []
    total = sum(b["impressions"] for b in buckets)
    if not total:
        return None
    return sum(b["impressions"] for b in buckets if b["bucket"] == "NOT_LOWEST") / total * 100


def build_note_input(price, campaign_name, date_from, date_to):
    """Devuelve (user_content, numeros_permitidos). ValueError con un mensaje para el usuario si no hay nota que mandar."""
    sm = price.get("summary") if price else None
    if not sm or not sm.get("impressions") or sm.get("price_diff") is None:
        raise ValueError("Google no entregó una diferencia de precio para este periodo: no hay nada que comunicar al hotel.")
    gap = sm["price_diff"]
    not_lowest = _not_lowest_share(price)
    if gap <= NOTE_MIN_GAP and (not_lowest is None or not_lowest < NOTE_MIN_NOT_LOWEST):
        raise ValueError("El precio del hotel está competitivo en este periodo: no hay nada que pedirle al revenue manager.")
    d0, d1 = datetime.date.fromisoformat(date_from), datetime.date.fromisoformat(date_to)
    block = _price_block(price)
    data = {
        "periodo": f"{date_from} a {date_to}", "dias": (d1 - d0).days + 1, "campana": str(campaign_name or "")[:120],
        "diferencia_precio_pct": block["diferencia_precio_pct"],
        "pct_impresiones_donde_no_es_el_mas_barato": _round(not_lowest, 1) if not_lowest is not None else None,
        "se_mostro_pct": block.get("se_mostro_pct"),
    }
    for p in block.get("posiciones", []):
        if p["posicion"] == google_ads_client.HOTEL_PRICE_BUCKET_LABELS_ES["NOT_LOWEST"] and p["diferencia_precio_pct"] is not None:
            data["diferencia_en_esas_impresiones_pct"] = p["diferencia_precio_pct"]
    cheap = [b for b in (price.get("buckets") or []) if b["bucket"] in ("LOWEST_UNIQUE", "LOWEST_TIED")]
    total = sum(b["impressions"] for b in price.get("buckets") or [])
    if total:
        data["pct_impresiones_mas_barato_o_empatado"] = _round(sum(b["impressions"] for b in cheap) / total * 100, 1)
    if block.get("tendencia"):
        data["tendencia"] = block["tendencia"]
    allowed = [d0.year, d0.month, d0.day, d1.year, d1.month, d1.day, data["dias"]]

    def collect(v):
        if isinstance(v, dict):
            for x in v.values():
                collect(x)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            allowed.append(abs(v))
    collect({k: v for k, v in data.items() if k not in ("periodo", "dias", "campana")})
    return json.dumps({k: v for k, v in data.items() if v is not None}, ensure_ascii=False), allowed


def check_note_numbers(text, allowed):
    """Cifras del texto que no salen de los datos enviados (tolerancia de redondeo). Lista vacía = todo verificado."""
    unknown = []
    for raw in NUMBER_RE.findall(text or ""):
        n = float(raw.replace(",", "."))
        tol = 0.5 if raw.isdigit() else 0.06
        if not any(abs(n - a) <= tol for a in allowed) and raw not in unknown:
            unknown.append(raw)
    return unknown


def build_note_result(ai, allowed):
    subject = _clean_text(ai.get("asunto"), 160)
    message = "\n".join(line.rstrip() for line in str(ai.get("mensaje") or "").strip().splitlines())[:2500]
    if not message:
        raise ValueError("Claude no devolvió el texto de la nota.")
    return {"asunto": subject, "mensaje": message, "cifras_no_verificadas": check_note_numbers(subject + " " + message, allowed)}
