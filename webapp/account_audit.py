"""Motor de reglas de la sección "Auditoría de cuenta" — solo librería estándar.

Recibe los datos crudos que arma google_ads_client.fetch_audit_data() (o la
versión simulada) más el contexto del cuestionario, y devuelve los hallazgos
ya calculados, el puntaje y las revisiones que no se pudieron verificar.
Las reglas y umbrales vienen de OUTPUTS/plataforma-google-ads/
auditoria_reglas_propuesta.md — si cambias una allá, cámbiala acá (THRESHOLDS
y la función de la regla).

Nada acá habla con Google Ads: es lógica pura, para poder probarla con datos
inventados. Una revisión cuyos datos no se pudieron leer NO genera hallazgo:
queda en "no_verificables" para no inventar un Crítico con un campo dudoso.
"""

import re

SEVERITIES = ("critico", "advertencia", "info")
SEVERITY_POINTS = {"critico": 5, "advertencia": 2, "info": 0}

THRESHOLDS = {
    "partner_spend_share": 0.10,       # B2: socios > 10% del gasto de Search
    "partner_cpa_ratio": 1.3,          # B2: y CPA > 1,3x el de Google Search
    "brand_leak_share": 0.10,          # C2: marca en genéricas > 10% de su gasto
    "smart_bidding_min_conv_30d": 15,  # C4
    "lost_is_budget": 0.15,            # C5
    "wide_ad_group_keywords": 20,      # C7 (solo info)
    "broad_spend_share": 0.30,         # D1
    "waste_spend_share": 0.15,         # D3: gasto sin conversión / gasto Search
    "negative_theme_share": 0.03,      # D4
    "low_quality_score": 4,            # D5
    "low_quality_min_spend": 30,       # D5
    "min_lookback_days": 30,           # A10
    "min_sitelinks": 4,                # E3
    "pmax_min_conv_30d": 30,           # P2
    "pmax_min_images": 2,              # P6: por formato (horizontal, cuadrada, vertical)
    "pmax_min_headlines": 5,           # P6
    "pmax_min_descriptions": 4,        # P6
    "pmax_lost_is_budget": 0.15,       # P12
    "pmax_brand_share": 0.15,          # P9: impresiones de categorías con la marca
    "pmax_changes_14d": 3,             # P11: más de N cambios en 14 días
    "roas_goal_tolerance": 0.90,       # G1
    "cpa_goal_tolerance": 1.10,        # G1 (meta de CPA)
}

# Mismos óptimos de CPA % que usa Rendimiento (engine.js).
OPTIMAL_CPA_PCT = {"search_marca": 0.11, "pmax": 0.20, "demand_gen": 0.30, "display": 0.30, "search_generica": 0.30}

SMART_BIDDING = {"TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"}
VALUE_BIDDING = {"TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"}
GA_IMPORT_TYPES = {
    "GOOGLE_ANALYTICS_4_CUSTOM", "GOOGLE_ANALYTICS_4_PURCHASE",
    "UNIVERSAL_ANALYTICS_GOAL", "UNIVERSAL_ANALYTICS_TRANSACTION",
}
MICRO_CATEGORIES = {"PHONE_CALL_LEAD", "ENGAGEMENT", "PAGE_VIEW", "CONTACT", "GET_DIRECTIONS", "OUTBOUND_CLICK", "BEGIN_CHECKOUT", "ADD_TO_CART"}
MICRO_NAME_RE = re.compile(r"whatsapp|llamad|call|tel[eé]f|disponibilidad|availability|click|clic|ver |view|contact", re.I)
MICRO_TYPES = {"WEBSITE_CALL", "CLICK_TO_CALL", "AD_CALL"}
RISKY_AUTO_APPLY = {
    "CAMPAIGN_BUDGET", "KEYWORD", "USE_BROAD_MATCH_KEYWORD", "TARGET_CPA_OPT_IN", "TARGET_ROAS_OPT_IN",
    "MAXIMIZE_CONVERSIONS_OPT_IN", "MAXIMIZE_CLICKS_OPT_IN", "ENHANCED_CPC_OPT_IN", "SEARCH_PARTNERS_OPT_IN",
    "KEYWORD_MATCH_TYPE", "MOVE_UNUSED_BUDGET", "SITELINK_ASSET", "CALLOUT_ASSET",
    "RAISE_TARGET_CPA", "LOWER_TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE_OPT_IN",
}
# Nombres legibles para el informe (el tipo crudo de Google no le dice nada a un cliente).
AUTO_APPLY_LABELS = {
    "CAMPAIGN_BUDGET": "Ajustar presupuestos de campaña",
    "KEYWORD": "Agregar palabras clave",
    "USE_BROAD_MATCH_KEYWORD": "Usar concordancia amplia",
    "KEYWORD_MATCH_TYPE": "Cambiar concordancia de palabras clave",
    "TARGET_CPA_OPT_IN": "Pasar a CPA objetivo",
    "TARGET_ROAS_OPT_IN": "Pasar a ROAS objetivo",
    "MAXIMIZE_CONVERSIONS_OPT_IN": "Cambiar la puja a Maximizar conversiones",
    "MAXIMIZE_CONVERSION_VALUE_OPT_IN": "Cambiar la puja a Maximizar valor de conversión",
    "MAXIMIZE_CLICKS_OPT_IN": "Cambiar la puja a Maximizar clics",
    "ENHANCED_CPC_OPT_IN": "Activar CPC mejorado",
    "SEARCH_PARTNERS_OPT_IN": "Activar la red de socios de búsqueda",
    "MOVE_UNUSED_BUDGET": "Mover presupuesto sin usar",
    "RAISE_TARGET_CPA": "Subir el CPA objetivo",
    "LOWER_TARGET_ROAS": "Bajar el ROAS objetivo",
    "SITELINK_ASSET": "Crear enlaces de sitio",
    "CALLOUT_ASSET": "Crear textos destacados",
}

# Temas de negativos típicos de hotel — lista inicial editable (ver D4 en el
# archivo de reglas). Cada tema: nombre → regex sobre el término de búsqueda.
NEGATIVE_THEMES = {
    "Empleo": r"\b(empleos?|trabajos?|vacantes?|hoja de vida|convocatorias?|jobs?|careers?|hiring)\b",
    "Gratis": r"\b(gratis|gratuito|free|sin costo)\b",
    "Alquiler o vivienda largo plazo": r"\b(arriendo|arrendar|alquiler de (casa|apartamento)|apartamento en venta|casa en venta)\b",
}

DEFAULT_BRAND_CAMPAIGN_WORDS = ("marca", "brand", "branded", "brnd")
AREAS = ["Conversiones", "Redes y segmentación", "Estructura y puja", "Palabras clave y términos", "Activos", "Automatización", "Performance Max", "Rendimiento contra la meta"]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _is_brand_name(name, brand_words):
    n = (name or "").lower()
    return any(w and w in n for w in brand_words)


def _campaign_kind(c, brand_words):
    ch = c.get("channel_type") or ""
    if ch == "PERFORMANCE_MAX":
        return "pmax"
    if ch == "DEMAND_GEN":
        return "demand_gen"
    if ch in ("DISPLAY", "VIDEO"):
        return "display"
    if ch == "SEARCH":
        return "search_marca" if _is_brand_name(c.get("name"), brand_words) else "search_generica"
    return None


def _finding(fid, area, severity, title, detail, action, evidence=None):
    return {"id": fid, "area": area, "severity": severity, "title": title, "detail": detail,
            "action": action, "evidence": (evidence or [])[:10]}


def _money(v, cur):
    return f"{cur} {v:,.0f}" if cur else f"{v:,.0f}"


def parse_brand_words(raw):
    return [w.strip().lower() for w in re.split(r"[,\n]", raw or "") if w.strip()]


def run_audit(data, ctx, days):
    """data: dict de fetch_audit_data. ctx: dict del cuestionario. Devuelve
    {"findings": [...], "not_verifiable": [...], "score": {...}, "summary": {...}}."""
    T = THRESHOLDS
    cur = data.get("currency") or ""
    # Dos listas distintas: las palabras que marcan una CAMPAÑA como de marca
    # (convención del equipo: "marca", "brand"...; los nombres de campaña
    # suelen traer también el nombre del hotel, así que NO sirve para esto) y
    # los términos de marca que el usuario busca (nombre del hotel).
    brand_words = parse_brand_words(ctx.get("brand_campaign_words")) or list(DEFAULT_BRAND_CAMPAIGN_WORDS)
    brand_terms = parse_brand_words(ctx.get("brand_terms"))
    unavailable = data.get("unavailable") or {}
    findings, not_verifiable = [], []

    def nv(fid, title, reason):
        not_verifiable.append({"id": fid, "title": title, "reason": reason})

    campaigns = data.get("campaigns") or []
    enabled = [c for c in campaigns if c.get("status") == "ENABLED"]
    total_cost = sum(_num(c.get("cost")) for c in campaigns)
    total_conv = sum(_num(c.get("conversions")) for c in campaigns)
    total_value = sum(_num(c.get("conv_value")) for c in campaigns)
    search_campaigns = [c for c in campaigns if c.get("channel_type") == "SEARCH"]
    search_cost = sum(_num(c.get("cost")) for c in search_campaigns)
    by_id = {c["id"]: c for c in campaigns}

    # ---- A. Conversiones -------------------------------------------------
    actions = data.get("conversion_actions")
    action_metrics = data.get("conversion_action_metrics")  # {nombre: {"conversions", "value"}} o None
    if actions is None:
        for fid, t in (("A1", "Conversión de reserva primaria"), ("A3", "Conversión primaria con datos"), ("A4", "Conversiones primarias duplicadas"),
                       ("A5", "Importaciones de GA primarias"), ("A6", "Microconversiones primarias"), ("A7", "Valor de la reserva"), ("A10", "Ventana de conversión")):
            nv(fid, t, "No se pudieron leer las acciones de conversión: " + unavailable.get("conversion_actions", "sin detalle"))
    else:
        active = [a for a in actions if a.get("status") == "ENABLED"]
        primary = [a for a in active if a.get("primary_for_goal")]
        booking_name = (ctx.get("booking_conversion") or "").strip()
        booking = next((a for a in active if a["name"] == booking_name), None) if booking_name else None
        if booking is None:
            cands = [a for a in primary if a.get("category") in ("PURCHASE", "BOOK_APPOINTMENT", "SUBMIT_LEAD_FORM")] or primary
            if cands and action_metrics:
                cands = sorted(cands, key=lambda a: -_num((action_metrics.get(a["name"]) or {}).get("conversions")))
            booking = cands[0] if cands else None

        if not primary:
            findings.append(_finding("A1", "Conversiones", "critico", "No hay ninguna conversión primaria activa",
                "Sin una conversión primaria las campañas no optimizan hacia reservas y los informes de conversiones quedan vacíos.",
                "Crear o marcar como primaria la conversión de reserva confirmada."))
        elif booking_name and booking is None:
            findings.append(_finding("A1", "Conversiones", "critico", f"La conversión de reserva elegida no está activa o no existe: {booking_name}",
                "La acción que indicaste como reserva no aparece entre las acciones activas de la cuenta.",
                "Revisar el nombre en Google Ads > Objetivos > Conversiones o elegir otra en el cuestionario."))

        if total_cost > 0 and total_conv == 0:
            findings.append(_finding("A2", "Conversiones", "critico", "La cuenta gastó y no registró ninguna conversión",
                f"Gasto de {_money(total_cost, cur)} en {days} días con 0 conversiones.",
                "Verificar que la etiqueta de reserva dispare y que la conversión esté activa."))

        if action_metrics is None:
            nv("A3", "Conversión primaria con datos", "No se pudieron leer las conversiones por acción: " + unavailable.get("conversion_action_metrics", "sin detalle"))
        elif total_cost > 0:
            silent = [a["name"] for a in primary if _num((action_metrics.get(a["name"]) or {}).get("conversions")) == 0]
            if silent:
                findings.append(_finding("A3", "Conversiones", "critico", "Conversiones primarias sin ningún dato en el periodo",
                    "Estas acciones primarias están activas pero no registraron conversiones mientras la cuenta gastaba.",
                    "Revisar el estado de la etiqueta de cada una; si ya no se usa, pasarla a secundaria o quitarla.", silent))

        by_cat = {}
        for a in primary:
            by_cat.setdefault(a.get("category"), []).append(a)
        dups = {cat: items for cat, items in by_cat.items() if len(items) > 1 and cat in ("PURCHASE", "BOOK_APPOINTMENT", "SUBMIT_LEAD_FORM")}
        if dups:
            ev = [f"{cat}: " + ", ".join(a["name"] for a in items) for cat, items in dups.items()]
            findings.append(_finding("A4", "Conversiones", "critico", "Hay varias conversiones primarias de la misma categoría",
                "Si cuentan la misma reserva, Google la suma más de una vez: el CPA y el ROAS se ven mejor de lo que son.",
                "Dejar una sola primaria por reserva y pasar las demás a secundarias.", ev))

        ga_primary = [a for a in primary if a.get("type") in GA_IMPORT_TYPES]
        own_primary = [a for a in primary if a.get("type") not in GA_IMPORT_TYPES]
        if ga_primary and own_primary:
            findings.append(_finding("A5", "Conversiones", "critico", "Importaciones de Google Analytics marcadas como primarias",
                "Ya hay conversiones propias de Google Ads como primarias; la importación de GA debería ser secundaria para no duplicar la reserva.",
                "Cambiar estas acciones a secundarias.", [a["name"] for a in ga_primary]))

        micro = []
        for a in primary:
            if booking is not None and a["name"] == booking["name"]:
                continue
            if a.get("type") in MICRO_TYPES or a.get("category") in MICRO_CATEGORIES or MICRO_NAME_RE.search(a["name"] or ""):
                micro.append(a["name"])
        if micro and booking is not None:
            findings.append(_finding("A6", "Conversiones", "critico", "Microconversiones marcadas como primarias junto con la reserva",
                "Llamadas, clics en WhatsApp o 'ver disponibilidad' inflan las conversiones y hacen que el CPA parezca más bajo de lo real.",
                "Pasarlas a secundarias para que la puja optimice solo hacia la reserva.", micro))

        if booking is not None and action_metrics is not None:
            m = action_metrics.get(booking["name"]) or {}
            has_value = _num(m.get("value")) > 0
            if _num(m.get("conversions")) > 0 and not has_value:
                uses_value = [c["name"] for c in enabled if c.get("bidding") in VALUE_BIDDING]
                if uses_value or ctx.get("goal") == "roas":
                    findings.append(_finding("A7", "Conversiones", "critico", "La reserva no trae valor y hay puja o meta por ROAS",
                        "Sin valor de conversión, el ROAS no se puede calcular y las pujas por valor no tienen qué optimizar.",
                        "Pasar el valor de la reserva (precio total) desde la etiqueta o configurar un valor por defecto.", uses_value))
                else:
                    findings.append(_finding("A8", "Conversiones", "advertencia", "La reserva no trae valor",
                        "Las campañas pujan por conversiones, pero sin valor no se puede medir ROAS ni priorizar reservas más caras.",
                        "Pasar el valor de la reserva desde la etiqueta."))
        elif booking is not None:
            nv("A7", "Valor de la reserva", "No se pudieron leer las conversiones por acción.")

        if booking is not None and _num(booking.get("lookback_days")) and _num(booking["lookback_days"]) < T["min_lookback_days"]:
            findings.append(_finding("A10", "Conversiones", "info", "Ventana de conversión corta para una reserva",
                f"La conversión '{booking['name']}' usa {int(booking['lookback_days'])} días; la decisión de reservar suele tardar más.",
                f"Considerar {T['min_lookback_days']} días o más."))

    # Google no devuelve por API si las conversiones mejoradas están activadas
    # (omite el campo cuando están apagadas), así que casi siempre llega None.
    # En ese caso vale lo que declaró el equipo en el cuestionario: "si" / "no";
    # "nose" o vacío = no verificable. Si la API sí responde, manda la API.
    enhanced = data.get("enhanced_conversions")  # True / False / None
    manual = {"si": True, "no": False}.get((ctx.get("enhanced_conversions") or "").strip().lower())
    declared_by_user = enhanced is None and manual is not None
    if enhanced is None:
        enhanced = manual
    if enhanced is False:
        findings.append(_finding("A9", "Conversiones", "critico", "Conversiones mejoradas no activadas",
            "Sin conversiones mejoradas se pierden reservas que Google no puede atribuir por los cambios de privacidad."
            + (" (Dato indicado en el cuestionario: Google no lo entrega por API.)" if declared_by_user else ""),
            "Activarlas en Google Ads > Objetivos > Conversiones > Configuración de conversiones."))
    elif enhanced is None:
        nv("A9", "Conversiones mejoradas", "Google no devuelve por API si están activadas en esta cuenta" + (f" ({unavailable['customer']})" if unavailable.get("customer") else "") + ". Revisarlo en Google Ads > Objetivos > Conversiones > Configuración y responder la pregunta del cuestionario para que cuente en el puntaje.")

    # ---- B. Redes y segmentación -----------------------------------------
    search_enabled = [c for c in search_campaigns if c.get("status") == "ENABLED"]
    interest = [c["name"] for c in search_enabled if c.get("geo_target_type") == "PRESENCE_OR_INTEREST"]
    presence = [c["name"] for c in search_enabled if c.get("geo_target_type") == "PRESENCE"]
    if search_enabled:
        findings.append(_finding("B1", "Redes y segmentación", "info", "Tipo de segmentación geográfica de las campañas Search",
            f"{len(interest)} usan 'presencia o interés' y {len(presence)} solo 'presencia'. En hoteles 'presencia o interés' suele ser lo deseado (personas interesadas en el destino); no resta puntos.",
            "Confirmar que cada campaña usa el tipo que corresponde a su mercado.", interest[:5]))

    net = data.get("network_split")
    partner_campaigns = [c for c in search_enabled if c.get("search_partners")]
    if net is None:
        nv("B2", "Red de socios de búsqueda", "No se pudo leer el gasto por red: " + unavailable.get("network_split", "sin detalle"))
    elif partner_campaigns:
        p_cost = sum(_num(r["cost"]) for r in net if r.get("network") == "SEARCH_PARTNERS")
        p_conv = sum(_num(r["conversions"]) for r in net if r.get("network") == "SEARCH_PARTNERS")
        g_cost = sum(_num(r["cost"]) for r in net if r.get("network") == "SEARCH")
        g_conv = sum(_num(r["conversions"]) for r in net if r.get("network") == "SEARCH")
        tot = p_cost + g_cost
        if tot > 0 and p_cost / tot > T["partner_spend_share"]:
            p_cpa = p_cost / p_conv if p_conv else None
            g_cpa = g_cost / g_conv if g_conv else None
            worse = (p_cpa is None and g_cpa is not None) or (p_cpa is not None and g_cpa is not None and p_cpa > g_cpa * T["partner_cpa_ratio"])
            if worse:
                findings.append(_finding("B2", "Redes y segmentación", "advertencia", "La red de socios de búsqueda gasta más y convierte peor",
                    f"Socios de búsqueda: {p_cost / tot:.0%} del gasto de Search, " + (f"CPA {_money(p_cpa, cur)} contra {_money(g_cpa, cur)} en Google Search." if p_cpa and g_cpa else "sin conversiones frente a Google Search."),
                    "Desactivar la red de socios en las campañas afectadas o acotar el presupuesto.", [c["name"] for c in partner_campaigns][:6]))

    content_net = [c["name"] for c in search_enabled if c.get("display_network")]
    if content_net:
        findings.append(_finding("B3", "Redes y segmentación", "critico", "Campañas Search con la red de display activada",
            "Parte del gasto de Search se va a sitios de la red de display, con intención de compra mucho menor.",
            "Desmarcar 'Incluir la Red de Display de Google' en estas campañas.", content_net))

    langs = data.get("campaign_languages")
    if langs is None:
        nv("B4", "Idioma de las campañas", "No se pudieron leer los idiomas: " + unavailable.get("campaign_languages", "sin detalle"))
    else:
        with_lang = {r["campaign_id"] for r in langs}
        no_lang = [c["name"] for c in enabled if c["id"] not in with_lang]
        if no_lang:
            findings.append(_finding("B4", "Redes y segmentación", "info", "Campañas sin idioma configurado",
                "Sin idioma, Google muestra los anuncios a cualquier idioma del navegador.", "Elegir los idiomas de los mercados objetivo.", no_lang))

    # ---- C. Estructura y puja --------------------------------------------
    brand_campaigns = [c for c in enabled if _is_brand_name(c.get("name"), brand_words)]
    if enabled and not brand_campaigns:
        findings.append(_finding("C1", "Estructura y puja", "critico", "No hay campaña de marca activa",
            "Sin una campaña de marca, las búsquedas del nombre del hotel las captura la competencia o las OTAs, o se mezclan con las genéricas.",
            "Crear una campaña de marca separada del resto.", ["Se busca una campaña activa con alguna de estas palabras en el nombre: " + ", ".join(brand_words)]))
    if not brand_terms:
        nv("C2", "Marca en campañas genéricas", "Falta el nombre del hotel o los términos de marca en el cuestionario.")
    else:
        terms = data.get("search_terms")
        if terms is None:
            nv("C2", "Marca en campañas genéricas", "No se pudieron leer los términos de búsqueda: " + unavailable.get("search_terms", "sin detalle"))
        else:
            generic_ids = {c["id"] for c in search_campaigns if not _is_brand_name(c.get("name"), brand_words)}
            gen_terms = [t for t in terms if t.get("campaign_id") in generic_ids]
            gen_cost = sum(_num(t["cost"]) for t in gen_terms)
            leak = [t for t in gen_terms if any(w in (t["term"] or "").lower() for w in brand_terms)]
            leak_cost = sum(_num(t["cost"]) for t in leak)
            if gen_cost > 0 and leak_cost / gen_cost > T["brand_leak_share"]:
                findings.append(_finding("C2", "Estructura y puja", "advertencia", "Búsquedas de la marca están gastando en campañas genéricas",
                    f"{leak_cost / gen_cost:.0%} del gasto de las genéricas ({_money(leak_cost, cur)}) viene de términos con el nombre de la marca.",
                    "Agregar la marca como negativo en las genéricas y dejar esas búsquedas en la campaña de marca.",
                    [f"{t['term']} ({_money(_num(t['cost']), cur)})" for t in sorted(leak, key=lambda x: -_num(x['cost']))[:6]]))

    maxclicks = [c["name"] for c in enabled if c.get("bidding") == "TARGET_SPEND"]
    if maxclicks:
        findings.append(_finding("C3", "Estructura y puja", "advertencia", "Campañas con la puja 'Maximizar clics'",
            "Para un hotel el objetivo es la reserva; maximizar clics trae tráfico sin importar si convierte.",
            "Pasarlas a una puja por conversiones o por valor de conversión.", maxclicks))

    low_data = [c["name"] for c in enabled if c.get("channel_type") != "PERFORMANCE_MAX" and c.get("bidding") in SMART_BIDDING and _num(c.get("conversions")) * 30.0 / max(days, 1) < T["smart_bidding_min_conv_30d"] and _num(c.get("cost")) > 0]
    if low_data:
        findings.append(_finding("C4", "Estructura y puja", "info", "Puja inteligente con muy pocas conversiones",
            f"Estas campañas tienen menos de {T['smart_bidding_min_conv_30d']} conversiones al mes; la puja inteligente aprende poco con tan pocos datos.",
            "Considerar agrupar campañas parecidas o ampliar el presupuesto.", low_data))

    lost = data.get("lost_is")
    if lost is None:
        nv("C5", "Presupuesto limitando campañas rentables", "No se pudo leer la pérdida de impresiones: " + unavailable.get("lost_is", "sin detalle"))
    else:
        flagged = []
        for r in lost:
            c = by_id.get(r["campaign_id"])
            if not c or _num(r.get("budget_lost")) <= T["lost_is_budget"] or _num(c.get("conversions")) <= 0:
                continue
            roas = _num(c.get("conv_value")) / _num(c["cost"]) if _num(c.get("cost")) else 0
            cpa = _num(c["cost"]) / _num(c["conversions"])
            ok = True
            if ctx.get("goal") == "roas" and _num(ctx.get("target")) > 0:
                ok = roas * 100 >= _num(ctx["target"])
            elif ctx.get("goal") == "cpa" and _num(ctx.get("target")) > 0:
                ok = cpa <= _num(ctx["target"])
            if ok:
                flagged.append(f"{c['name']} (pierde {_num(r['budget_lost']):.0%} por presupuesto)")
        if flagged:
            findings.append(_finding("C5", "Estructura y puja", "advertencia", "Campañas que convierten bien y pierden impresiones por presupuesto",
                "Hay demanda que estas campañas no alcanzan a captar porque el presupuesto diario se agota.",
                "Subir el presupuesto o redistribuirlo desde campañas menos rentables (ver la sección Oportunidad de ingresos).", flagged))

    idle = [c["name"] for c in enabled if _num(c.get("impressions")) == 0]
    if idle:
        findings.append(_finding("C6", "Estructura y puja", "critico", "Campañas activas sin ninguna impresión en el periodo",
            "Están activas pero no se muestran: pueden tener presupuesto en cero, estar sin anuncios aprobados o con una segmentación imposible.",
            "Revisar su estado en Google Ads; si son estacionales, pausarlas.", idle))

    kw_counts = data.get("adgroup_keyword_counts")
    if kw_counts is not None:
        wide = [f"{r['name']} ({r['keywords']} palabras)" for r in kw_counts if r["keywords"] > T["wide_ad_group_keywords"]]
        if wide:
            findings.append(_finding("C7", "Estructura y puja", "info", "Grupos de anuncios con muchas palabras clave",
                f"{len(wide)} grupo(s) con más de {T['wide_ad_group_keywords']} palabras. Con puja inteligente no suele ser un problema; no resta puntos.",
                "Revisar solo si los anuncios no se parecen a las palabras del grupo.", wide))

    # ---- D. Palabras clave y términos ------------------------------------
    keywords = data.get("keywords")
    if keywords is None:
        for fid, t in (("D1", "Concordancia amplia sin puja inteligente"), ("D2", "Gasto en concordancia exacta"), ("D5", "Índice de calidad bajo")):
            nv(fid, t, "No se pudieron leer las palabras clave: " + unavailable.get("keywords", "sin detalle"))
    else:
        kw_cost = sum(_num(k["cost"]) for k in keywords)
        broad_manual = [k for k in keywords if k.get("match_type") == "BROAD" and (by_id.get(k["campaign_id"]) or {}).get("bidding") not in SMART_BIDDING]
        broad_cost = sum(_num(k["cost"]) for k in broad_manual)
        if kw_cost > 0 and broad_cost / kw_cost > T["broad_spend_share"]:
            findings.append(_finding("D1", "Palabras clave y términos", "advertencia", "Concordancia amplia gastando sin puja inteligente",
                f"{broad_cost / kw_cost:.0%} del gasto en palabras clave va a concordancia amplia en campañas sin puja inteligente: Google puede mostrar el anuncio en búsquedas poco relacionadas.",
                "Pasar esas palabras a frase o exacta, o cambiar la campaña a una puja inteligente.",
                [f"{k['text']} ({_money(_num(k['cost']), cur)})" for k in sorted(broad_manual, key=lambda x: -_num(x['cost']))[:6]]))
        exact_cost = sum(_num(k["cost"]) for k in keywords if k.get("match_type") == "EXACT")
        if kw_cost > 0:
            findings.append(_finding("D2", "Palabras clave y términos", "info", "Peso de la concordancia exacta en el gasto",
                f"{exact_cost / kw_cost:.0%} del gasto en palabras clave va a concordancia exacta.", "Solo informativo."))
        poor = [k for k in keywords if k.get("quality_score") and k["quality_score"] <= T["low_quality_score"] and _num(k["cost"]) > T["low_quality_min_spend"]]
        if poor:
            findings.append(_finding("D5", "Palabras clave y términos", "advertencia", "Palabras clave con índice de calidad bajo y gasto",
                f"{len(poor)} palabra(s) con índice de calidad de {T['low_quality_score']} o menos gastan en el periodo; pagan más por clic.",
                "Mejorar la relevancia del anuncio y de la página de destino, o pausarlas.",
                [f"{k['text']} (QS {k['quality_score']}, {_money(_num(k['cost']), cur)})" for k in sorted(poor, key=lambda x: -_num(x['cost']))[:6]]))

    terms = data.get("search_terms")
    if terms is None:
        nv("D3", "Gasto en términos sin conversión", "No se pudieron leer los términos de búsqueda: " + unavailable.get("search_terms", "sin detalle"))
        nv("D4", "Negativos de temas típicos de hotel", "No se pudieron leer los términos de búsqueda.")
    else:
        if search_cost > 0:
            waste = [t for t in terms if _num(t["conversions"]) == 0]
            waste_cost = sum(_num(t["cost"]) for t in waste)
            if waste_cost / search_cost > T["waste_spend_share"]:
                findings.append(_finding("D3", "Palabras clave y términos", "advertencia", "Mucho gasto en términos de búsqueda sin conversiones",
                    f"{waste_cost / search_cost:.0%} del gasto de Search ({_money(waste_cost, cur)}) fue a términos que no convirtieron (sobre los {len(terms)} términos de mayor gasto).",
                    "Revisar los términos en la sección Negativización y excluir los que no tengan sentido.",
                    [f"{t['term']} ({_money(_num(t['cost']), cur)})" for t in sorted(waste, key=lambda x: -_num(x['cost']))[:6]]))
            negatives = data.get("negatives")
            neg_text = " ".join((n.get("text") or "").lower() for n in (negatives or []))
            hits, theme_cost = [], 0.0
            for theme, rx in NEGATIVE_THEMES.items():
                pat = re.compile(rx, re.I)
                matched = [t for t in terms if _num(t["conversions"]) == 0 and pat.search(t["term"] or "")]
                cost = sum(_num(t["cost"]) for t in matched)
                if cost > 0:
                    hits.append(f"{theme}: {_money(cost, cur)} en {len(matched)} término(s), p. ej. '{matched[0]['term']}'")
                    theme_cost += cost
            if theme_cost / search_cost > T["negative_theme_share"]:
                findings.append(_finding("D4", "Palabras clave y términos", "advertencia", "Faltan negativos de temas típicos que no son reservas",
                    f"{theme_cost / search_cost:.0%} del gasto de Search ({_money(theme_cost, cur)}) fue a búsquedas de empleo, gratis o alquiler largo, sin conversiones.",
                    "Agregar esos temas como negativos (lista compartida de la cuenta).", hits))

    # ---- E. Activos -------------------------------------------------------
    assets = data.get("assets")
    if assets is None:
        nv("E3", "Enlaces de sitio, llamadas y ubicación", "No se pudieron leer los activos: " + unavailable.get("assets", "sin detalle"))
    else:
        count = {}
        for a in assets:
            count[a["field_type"]] = count.get(a["field_type"], 0) + 1
        missing = []
        if count.get("SITELINK", 0) < T["min_sitelinks"]:
            missing.append(f"enlaces de sitio ({count.get('SITELINK', 0)} de {T['min_sitelinks']} recomendados)")
        if not count.get("CALL"):
            missing.append("llamada")
        if not (count.get("LOCATION") or count.get("AFFILIATE_LOCATION")):
            missing.append("ubicación (perfil de empresa)")
        if missing:
            findings.append(_finding("E3", "Activos", "advertencia", "Faltan activos que ayudan en hoteles",
                "Sin estos activos los anuncios ocupan menos espacio y no muestran la ubicación del hotel.",
                "Agregar los activos que faltan.", missing))

    # ---- F. Automatización ------------------------------------------------
    subs = data.get("recommendation_subscriptions")
    if subs is None:
        nv("F1", "Recomendaciones que se aplican solas", "No se pudo leer: " + unavailable.get("recommendation_subscriptions", "sin detalle"))
    else:
        risky = sorted({s["type"] for s in subs if s.get("status") == "ENABLED" and s.get("type") in RISKY_AUTO_APPLY})
        if risky:
            findings.append(_finding("F1", "Automatización", "critico", "Hay recomendaciones que Google aplica automáticamente",
                "Algunas pueden subir presupuestos, cambiar pujas o agregar palabras amplias sin que nadie lo apruebe.",
                "Desactivarlas en Google Ads > Recomendaciones > Aplicar automáticamente.", [AUTO_APPLY_LABELS.get(t, t) for t in risky]))

    # ---- P. Performance Max ----------------------------------------------
    # Solo si hay campañas PMax activas. Ver auditoria_pmax_reglas_propuesta.md.
    pmax_camps = [c for c in enabled if c.get("channel_type") == "PERFORMANCE_MAX"]
    pmax_present = bool(pmax_camps)
    if pmax_present:
        AREA_P = "Performance Max"
        creative_sev = "info" if (ctx.get("hotel_feed") or "").strip().lower() == "si" else "advertencia"
        feed_note = " Como indicaste que usas feed de Hotel Center, se muestra solo como informativo." if creative_sev == "info" else ""

        # P1 / P1b — sin valor de conversión (no se repite si A7/A8 ya lo dijeron)
        no_value = [c for c in pmax_camps if _num(c.get("conversions")) > 0 and _num(c.get("conv_value")) == 0]
        if no_value:
            names = [c["name"] for c in no_value]
            prior = next((f for f in findings if f["id"] in ("A7", "A8")), None)
            if prior is not None:
                prior["evidence"] = (prior["evidence"] + ["PMax afectadas: " + ", ".join(names)])[:10]
            else:
                value_bid = [c["name"] for c in no_value if c.get("bidding") in VALUE_BIDDING]
                if value_bid:
                    findings.append(_finding("P1", AREA_P, "critico", "Performance Max puja por valor y la reserva no trae valor",
                        "Sin valor de conversión, la puja por valor no tiene qué optimizar y el ROAS no se puede calcular.",
                        "Pasar el valor de la reserva desde la etiqueta o configurar un valor por defecto.", value_bid))
                else:
                    findings.append(_finding("P1b", AREA_P, "advertencia", "Performance Max puja por conversiones y la reserva no trae valor",
                        "No se puede medir el ROAS ni priorizar las reservas de mayor valor.",
                        "Pasar el valor de la reserva desde la etiqueta.", names))

        # P2 — pocas conversiones para aprender
        low_conv = [f"{c['name']} ({_num(c.get('conversions')) * 30.0 / max(days, 1):.0f} conversiones al mes)"
                    for c in pmax_camps if _num(c.get("cost")) > 0 and _num(c.get("conversions")) * 30.0 / max(days, 1) < T["pmax_min_conv_30d"]]
        if low_conv:
            findings.append(_finding("P2", AREA_P, "advertencia", "Performance Max con muy pocas conversiones para aprender",
                f"Con menos de {T['pmax_min_conv_30d']} conversiones al mes la puja tiene pocos datos y rinde de forma irregular (umbral orientativo: Google no publica un mínimo estricto).",
                "Agrupar campañas parecidas, ampliar el presupuesto o medir una conversión más temprana como secundaria.", low_conv))

        groups = data.get("pmax_asset_groups")
        assets = data.get("pmax_assets")
        signals = data.get("pmax_signals")
        gname = lambda g: f"{(by_id.get(g['campaign_id']) or {}).get('name', 'campaña')} · {g['name']}"

        if groups is None:
            nv("P3", "Calidad de los grupos de recursos", "No se pudieron leer los grupos de recursos: " + unavailable.get("pmax_asset_groups", "sin detalle"))
        else:
            weak = [f"{gname(g)} ({'Pobre' if g['ad_strength'] == 'POOR' else 'Promedio'})" for g in groups if g.get("ad_strength") in ("POOR", "AVERAGE")]
            if weak:
                findings.append(_finding("P3", AREA_P, creative_sev, "Grupos de recursos con calidad baja",
                    "Google califica estos grupos de recursos como Pobre o Promedio: tienen menos combinaciones de anuncios para probar." + feed_note,
                    "Agregar títulos, descripciones, imágenes y video hasta llegar a calidad Buena o Excelente.", weak))

        if groups is None or assets is None:
            nv("P5", "Video propio en los grupos de recursos", "No se pudieron leer los recursos: " + unavailable.get("pmax_assets", unavailable.get("pmax_asset_groups", "sin detalle")))
            nv("P6", "Imágenes y textos en los grupos de recursos", "No se pudieron leer los recursos: " + unavailable.get("pmax_assets", unavailable.get("pmax_asset_groups", "sin detalle")))
        else:
            per = {}
            for a in assets:
                d = per.setdefault(a["asset_group_id"], {})
                d[a["field_type"]] = d.get(a["field_type"], 0) + 1
            no_video, missing = [], []
            for g in groups:
                d = per.get(g["id"], {})
                if not d.get("YOUTUBE_VIDEO"):
                    no_video.append(gname(g))
                gaps = []
                for ft, label in (("MARKETING_IMAGE", "imágenes horizontales"), ("SQUARE_MARKETING_IMAGE", "imágenes cuadradas"), ("PORTRAIT_MARKETING_IMAGE", "imágenes verticales")):
                    if d.get(ft, 0) < T["pmax_min_images"]:
                        gaps.append(f"{label} ({d.get(ft, 0)} de {T['pmax_min_images']})")
                if d.get("HEADLINE", 0) < T["pmax_min_headlines"]:
                    gaps.append(f"títulos ({d.get('HEADLINE', 0)} de {T['pmax_min_headlines']})")
                if d.get("DESCRIPTION", 0) < T["pmax_min_descriptions"]:
                    gaps.append(f"descripciones ({d.get('DESCRIPTION', 0)} de {T['pmax_min_descriptions']})")
                if gaps:
                    missing.append(f"{gname(g)}: faltan " + ", ".join(gaps))
            if no_video:
                findings.append(_finding("P5", AREA_P, creative_sev, "Grupos de recursos sin video propio",
                    "Sin video, Google genera uno automático a partir de tus imágenes, que suele ser de menor calidad." + feed_note,
                    "Subir al menos un video propio, horizontal y vertical si es posible.", no_video))
            if missing:
                findings.append(_finding("P6", AREA_P, creative_sev, "Faltan imágenes o textos en grupos de recursos",
                    "Menos recursos significan menos combinaciones que Google puede probar." + feed_note,
                    "Completar hasta los mínimos recomendados (editables en la auditoría).", missing))

        if groups is None or signals is None:
            nv("P7", "Señales de audiencia y temas de búsqueda", "No se pudieron leer las señales: " + unavailable.get("pmax_signals", unavailable.get("pmax_asset_groups", "sin detalle")))
        else:
            with_sig = {s_["asset_group_id"] for s_ in signals}
            no_sig = [gname(g) for g in groups if g["id"] not in with_sig]
            if no_sig:
                findings.append(_finding("P7", AREA_P, "advertencia", "Grupos de recursos sin señales de audiencia ni temas de búsqueda",
                    "Las señales no limitan la campaña, pero le dan a Google un punto de partida más cercano a quien reserva.",
                    "Agregar audiencias propias (visitantes del sitio, lista de clientes) y temas de búsqueda del destino.", no_sig))

        pm_lost = data.get("pmax_lost_is")
        if pm_lost is None:
            nv("P12", "Presupuesto limitando una PMax rentable", "No se pudo leer la pérdida de impresiones de PMax: " + unavailable.get("pmax_lost_is", "sin detalle"))
        else:
            flagged = []
            for r_ in pm_lost:
                c = by_id.get(r_["campaign_id"])
                if not c or _num(r_.get("budget_lost")) <= T["pmax_lost_is_budget"] or _num(c.get("conversions")) <= 0:
                    continue
                roas = _num(c.get("conv_value")) / _num(c["cost"]) if _num(c.get("cost")) else 0
                cpa = _num(c["cost"]) / _num(c["conversions"])
                ok = True
                if ctx.get("goal") == "roas" and _num(ctx.get("target")) > 0:
                    ok = roas * 100 >= _num(ctx["target"])
                elif ctx.get("goal") == "cpa" and _num(ctx.get("target")) > 0:
                    ok = cpa <= _num(ctx["target"])
                if ok:
                    flagged.append(f"{c['name']} (pierde {_num(r_['budget_lost']):.0%} por presupuesto)")
            if flagged:
                findings.append(_finding("P12", AREA_P, "advertencia", "Performance Max rentable que pierde impresiones por presupuesto",
                    "Hay demanda que estas campañas no alcanzan a captar porque el presupuesto diario se agota.",
                    "Subir el presupuesto o redistribuirlo desde campañas menos rentables.", flagged))

        # P9 — marca dentro de PMax (informativa)
        lists_ = data.get("pmax_brand_lists")
        cats = data.get("pmax_categories")
        if not brand_terms:
            nv("P9", "Marca dentro de Performance Max", "Falta el nombre del hotel o los términos de marca en el cuestionario.")
        elif lists_ is None or cats is None:
            nv("P9", "Marca dentro de Performance Max", "No se pudieron leer las exclusiones de marca o las categorías de búsqueda: "
               + (unavailable.get("pmax_brand_lists") or unavailable.get("pmax_categories") or "sin detalle"))
        else:
            excluded = {r_["campaign_id"] for r_ in lists_ if r_.get("negative")}
            leaks = []
            for c in pmax_camps:
                if c["id"] in excluded:
                    continue
                rows_ = [x for x in cats if x["campaign_id"] == c["id"]]
                total_i = sum(_num(x["impressions"]) for x in rows_)
                brand_i = sum(_num(x["impressions"]) for x in rows_ if any(w in (x["term"] or "").lower() for w in brand_terms))
                if total_i > 0 and brand_i / total_i > T["pmax_brand_share"]:
                    leaks.append(f"{c['name']}: {brand_i / total_i:.0%} de las impresiones de categorías de búsqueda son de la marca")
            if leaks:
                findings.append(_finding("P9", AREA_P, "info", "Performance Max recibe búsquedas de la marca y no la tiene excluida",
                    "Las búsquedas del nombre del hotel suelen captarse más barato con la campaña de marca de Search; PMax puede estar quedándose con parte de ellas. Solo informativo: los datos de PMax no traen costo por categoría.",
                    "Evaluar agregar una exclusión de marca a la campaña PMax.", leaks))

        # P10 — dónde se muestra PMax (informativa; la vista solo trae impresiones)
        plc = data.get("pmax_placements")
        if plc is None:
            nv("P10", "Dónde se muestra Performance Max", "No se pudo leer el reporte de ubicaciones: " + unavailable.get("pmax_placements", "sin detalle"))
        else:
            tot = sum(plc.values())
            if tot > 0:
                names = {"WEBSITE": "sitios web (Display)", "MOBILE_APPLICATION": "apps móviles", "YOUTUBE_VIDEO": "YouTube",
                         "GOOGLE_PRODUCTS": "productos de Google", "UNKNOWN": "otras"}
                lines = [f"{names.get(k, k.lower())}: {v / tot:.0%} de las impresiones" for k, v in sorted(plc.items(), key=lambda kv: -kv[1]) if v / tot >= 0.01]
                findings.append(_finding("P10", AREA_P, "info", "Dónde se muestra Performance Max",
                    "Reparto de las impresiones por tipo de ubicación. Google no entrega costo ni conversiones por ubicación, así que no se puede saber cuál rinde mejor.",
                    "Si una ubicación te parece ajena a un hotel, revisa las exclusiones de ubicaciones en Google Ads.", lines))

        # P11 — cambios frecuentes de presupuesto o de puja
        chg = data.get("pmax_changes")
        if chg is None:
            nv("P11", "Cambios frecuentes de presupuesto o de puja", "No se pudo leer el historial de cambios: " + unavailable.get("pmax_changes", "sin detalle"))
        else:
            bid_re = re.compile(r"target|bidding|maximize|roas|cpa", re.I)
            frequent = []
            for c in pmax_camps:
                budget_n = sum(1 for e in chg if e.get("type") == "CAMPAIGN_BUDGET" and c.get("budget_resource") and e.get("resource") == c["budget_resource"])
                bid_n = sum(1 for e in chg if e.get("type") == "CAMPAIGN" and (e.get("resource") or "").endswith("/campaigns/" + c["id"]) and bid_re.search(e.get("fields") or ""))
                if budget_n + bid_n > T["pmax_changes_14d"]:
                    frequent.append(f"{c['name']}: {budget_n + bid_n} cambios en 14 días (presupuesto {budget_n}, puja {bid_n})")
            if frequent:
                findings.append(_finding("P11", AREA_P, "advertencia", "Cambios frecuentes de presupuesto o de puja en Performance Max",
                    f"Más de {T['pmax_changes_14d']} cambios en 14 días: cada cambio fuerte puede reiniciar parte del aprendizaje y hace difícil saber qué funcionó.",
                    "Agrupar los cambios y esperar una o dos semanas entre ajustes grandes.", frequent))

    # ---- G. Rendimiento contra la meta -----------------------------------
    goal, target = ctx.get("goal"), _num(ctx.get("target"))
    if goal in ("roas", "cpa") and target > 0 and total_cost > 0:
        if goal == "roas":
            roas = total_value / total_cost if total_cost else 0
            if total_value > 0 and roas * 100 < target * T["roas_goal_tolerance"]:
                findings.append(_finding("G1", "Rendimiento contra la meta", "advertencia", "El ROAS está por debajo de la meta",
                    f"ROAS logrado {roas * 100:.0f}% contra una meta de {target:.0f}%.", "Revisar las campañas de peor ROAS en la sección ROAS."))
            elif total_value == 0 and total_conv > 0:
                nv("G1", "ROAS contra la meta", "Las conversiones no traen valor, no se puede calcular el ROAS.")
        elif total_conv > 0 and total_cost / total_conv > target * T["cpa_goal_tolerance"]:
            findings.append(_finding("G1", "Rendimiento contra la meta", "advertencia", "El CPA está por encima de la meta",
                f"CPA logrado {_money(total_cost / total_conv, cur)} contra una meta de {_money(target, cur)}.", "Revisar las campañas de mayor CPA."))
    elif goal in ("roas", "cpa"):
        nv("G1", "Rendimiento contra la meta", "Falta la meta numérica en el cuestionario.")

    over = []
    for c in campaigns:
        kind = _campaign_kind(c, brand_words)
        if not kind or _num(c.get("conv_value")) <= 0 or _num(c.get("cost")) <= 0:
            continue
        pct = _num(c["cost"]) / _num(c["conv_value"])
        if pct > OPTIMAL_CPA_PCT[kind]:
            over.append(f"{c['name']}: CPA % {pct:.0%} (óptimo {OPTIMAL_CPA_PCT[kind]:.0%})")
    if over:
        findings.append(_finding("G2", "Rendimiento contra la meta", "advertencia", "Campañas con CPA % por encima del óptimo de su tipo",
            "Mismos óptimos que usa la sección Rendimiento: Search marca 11%, Performance Max 20%, Demand Gen 30%, Display 30%, Search genérica 30%.",
            "Revisar presupuesto y pujas de estas campañas.", over))

    # ---- Puntaje ----------------------------------------------------------
    def penalty(items):
        return sum(SEVERITY_POINTS[f["severity"]] for f in items)

    total_score = max(0, 100 - penalty(findings))
    by_area = {}
    for area in AREAS:
        if area == "Performance Max" and not pmax_present:
            continue
        items = [f for f in findings if f["area"] == area]
        by_area[area] = {"score": max(0, 100 - penalty(items)), "critical": sum(f["severity"] == "critico" for f in items),
                         "warnings": sum(f["severity"] == "advertencia" for f in items)}
    n_crit = sum(f["severity"] == "critico" for f in findings)
    if total_score >= 85 and n_crit == 0:
        label = "Sana"
    elif total_score >= 60:
        label = "Mejorable"
    else:
        label = "Requiere atención"
    if n_crit > 0 and label == "Sana":
        label = "Mejorable"

    # Gasto por tipo de campaña (para la barra de distribución del informe).
    kind_labels = {"search_marca": "Search marca", "search_generica": "Search genérica", "pmax": "Performance Max",
                   "demand_gen": "Demand Gen", "display": "Display y video", None: "Otras"}
    spend_kind = {}
    for c in campaigns:
        k = _campaign_kind(c, brand_words)
        spend_kind[k] = spend_kind.get(k, 0.0) + _num(c.get("cost"))
    spend_by_type = [{"label": kind_labels[k], "cost": v, "share": (v / total_cost) if total_cost else 0}
                     for k, v in sorted(spend_kind.items(), key=lambda kv: -kv[1]) if v > 0]

    order = {s: i for i, s in enumerate(SEVERITIES)}
    findings.sort(key=lambda f: (order[f["severity"]], f["id"]))
    return {
        "findings": findings,
        "not_verifiable": not_verifiable,
        "score": {"total": total_score, "label": label, "by_area": by_area,
                  "weights": {"critico": SEVERITY_POINTS["critico"], "advertencia": SEVERITY_POINTS["advertencia"]},
                  "critical": n_crit, "warnings": sum(f["severity"] == "advertencia" for f in findings),
                  "info": sum(f["severity"] == "info" for f in findings)},
        "summary": {
            "currency": cur, "days": days, "cost": total_cost, "conversions": total_conv, "conv_value": total_value,
            "roas": (total_value / total_cost) if total_cost and total_value else None,
            "cpa": (total_cost / total_conv) if total_conv else None,
            "campaigns_total": len(campaigns), "campaigns_enabled": len(enabled),
            "spend_by_type": spend_by_type,
        },
        "conversion_actions": [{"name": a["name"], "category": a.get("category"), "primary": bool(a.get("primary_for_goal")), "status": a.get("status")}
                               for a in (actions or [])],
    }
