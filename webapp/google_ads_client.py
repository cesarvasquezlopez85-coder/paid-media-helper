"""
Cliente para la API de Google Ads — trae datos de campaña directo desde
Google Ads en vez de depender de un CSV exportado a mano (ver propuesta en
OUTPUTS/plataforma-google-ads/Propuesta_Integracion_API_Google_Ads.md).

Usa solo `urllib` (stdlib) contra la API REST de Google Ads, sin la librería
oficial `google-ads` (que trae gRPC y varias dependencias) — mismo criterio
que ya sigue server.py con `_handle_fetch` para el Generador de copys, y
mantiene el servidor sin requirements.txt.

Credenciales, todas por variable de entorno (nunca hardcodeadas ni
expuestas al navegador):
  GOOGLE_ADS_CLIENT_ID
  GOOGLE_ADS_CLIENT_SECRET
  GOOGLE_ADS_REFRESH_TOKEN
  GOOGLE_ADS_DEVELOPER_TOKEN
  GOOGLE_ADS_LOGIN_CUSTOMER_ID   (ID del MCC, solo dígitos, sin guiones)

Mientras no estén configuradas (developer token pendiente de aprobación de
Google), is_configured() devuelve False y server.py sirve las cuentas y
campañas simuladas de más abajo, para poder construir y probar el flujo
completo (selector de cuenta, rango de fechas, tabla) sin esperar a Google.

Nota sobre unidades: no se pudo verificar en vivo contra la referencia de
campos de la API en esta sesión (developers.google.com/google-ads/api/fields
es una SPA que no se pudo leer). Los campos de costo (cost_micros,
average_cpc, cost_per_conversion, campaign_budget.amount_micros) se asumen
en micros por ser la convención estable de la API desde hace varias
versiones; los de tasa/share (ctr, conversions_from_interactions_rate,
search_*_impression_share) se asumen como fracción 0-1. Antes de usar esto
con una cuenta real, correr una consulta de prueba y confirmar contra
https://developers.google.com/google-ads/api/fields/latest/metrics.
"""

import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_VERSION = "v25"
BASE_URL = f"https://googleads.googleapis.com/{API_VERSION}"
TOKEN_URL = "https://oauth2.googleapis.com/token"
TIMEOUT_SECONDS = 20
MICROS = 1_000_000

REQUIRED_ENV_VARS = [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
]

_token_cache = {"access_token": None, "expires_at": 0}


def is_configured():
    return all(os.environ.get(name) for name in REQUIRED_ENV_VARS)


def _get_access_token():
    now = time.time()
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["access_token"]

    data = urllib.parse.urlencode({
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"No se pudo renovar el token de Google ({e.code}): {detail}") from e

    _token_cache["access_token"] = payload["access_token"]
    _token_cache["expires_at"] = now + payload.get("expires_in", 3600)
    return _token_cache["access_token"]


def _search(customer_id, query):
    """Ejecuta una consulta GAQL contra `customer_id` y junta todas las
    páginas de resultados de googleAds:search."""
    url = f"{BASE_URL}/customers/{customer_id}/googleAds:search"
    headers = _auth_headers()
    results = []
    page_token = None
    while True:
        # googleAds:search no acepta pageSize (a diferencia de otras APIs de
        # Google) — siempre devuelve hasta 10 000 filas por página y se pagina
        # solo con pageToken. Mandar pageSize da 400 INVALID_ARGUMENT /
        # PAGE_SIZE_NOT_SUPPORTED, como se vio en la primera prueba real.
        body = {"query": query}
        if page_token:
            body["pageToken"] = page_token
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e
        results.extend(payload.get("results", []))
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return results


def _auth_headers():
    return {
        "Authorization": f"Bearer {_get_access_token()}",
        "developer-token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "login-customer-id": os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
        "Content-Type": "application/json",
    }


def list_client_accounts():
    """Cuentas de cliente (no sub-MCC) accesibles bajo el MCC configurado, en
    cualquier nivel de la jerarquía — algunas agencias organizan sus cuentas
    en sub-MCCs (una por marca, por ejemplo), así que limitar a nivel <= 1
    dejaba fuera cuentas reales que cuelgan de esos sub-MCCs."""
    mcc_id = os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]
    query = """
        SELECT customer_client.id, customer_client.descriptive_name,
               customer_client.status, customer_client.manager
        FROM customer_client
        WHERE customer_client.status = 'ENABLED'
    """
    rows = _search(mcc_id, query)
    accounts = []
    for r in rows:
        cc = r.get("customerClient", {})
        if cc.get("manager"):
            continue
        accounts.append({
            "id": str(cc.get("id")),
            "name": cc.get("descriptiveName") or f"Cuenta {cc.get('id')}",
        })
    return accounts


_CHANNEL_TYPE_ALIASES = {
    "SEARCH": "search",
    "DISPLAY": "display",
    "PERFORMANCE_MAX": "performance max",
    "DEMAND_GEN": "demand gen",
    "DISCOVERY": "demand gen",
    "SHOPPING": "shopping",
    "VIDEO": "video",
    "HOTEL": "search",
    "LOCAL": "search",
    "SMART": "search",
    "MULTI_CHANNEL": "search",
    "APP": "search",
}


def _channel_type_alias(raw):
    if not raw:
        return None
    return _CHANNEL_TYPE_ALIASES.get(raw, raw.lower().replace("_", " "))


def _int_or_none(v):
    return None if v is None else int(v)


def _float_or_none(v):
    return None if v is None else float(v)


def _micros_to_units(v):
    return None if v is None else v / MICROS


def fetch_campaign_rows(customer_id, date_from, date_to, only_active=False):
    """Reporte de campañas del rango de fechas, ya en el mismo formato de
    fila que consume engine.js → loadCampaignReportFromApi (ver ahí para el
    detalle de cada campo). only_active=True trae solo campañas ENABLED —
    por defecto trae también las pausadas (todo menos REMOVED), igual que
    un export CSV nativo de Google Ads."""
    status_filter = "campaign.status = 'ENABLED'" if only_active else "campaign.status != 'REMOVED'"

    # Consulta principal: todas las campañas, cualquier tipo, con sus
    # métricas generales — sin los campos de "Search Impr. Share".
    main_query = f"""
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type,
          campaign_budget.amount_micros,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion,
          metrics.conversions_from_interactions_rate,
          metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND {status_filter}
    """
    main_results = _search(customer_id, main_query)

    # Segunda consulta, solo para el Impression Share de Search — bug real
    # reportado por cesar (2026-07-30): pedir metrics.search_impression_share
    # (y las dos de % perdido) en la MISMA consulta que el resto hace que
    # Google Ads devuelva solo campañas de Search — Performance Max, Demand
    # Gen, Display, etc. desaparecían del reporte por completo, aunque sí
    # tuvieran gasto y conversiones. Separarla en su propia consulta deja
    # que esos campos sigan aplicando solo a Search (donde tienen sentido),
    # sin filtrar el resto de las campañas de la cuenta.
    is_query = f"""
        SELECT
          campaign.id,
          metrics.search_budget_lost_impression_share,
          metrics.search_rank_lost_impression_share,
          metrics.search_impression_share
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND {status_filter}
    """
    is_results = _search(customer_id, is_query)
    is_by_campaign_id = {}
    for r in is_results:
        cid = r.get("campaign", {}).get("id")
        m = r.get("metrics", {})
        is_by_campaign_id[cid] = {
            "lost_is_budget": _float_or_none(m.get("searchBudgetLostImpressionShare")),
            "lost_is_rank": _float_or_none(m.get("searchRankLostImpressionShare")),
            "impr_share": _float_or_none(m.get("searchImpressionShare")),
        }

    rows = []
    for r in main_results:
        campaign = r.get("campaign", {})
        budget = r.get("campaignBudget", {})
        metrics = r.get("metrics", {})
        is_data = is_by_campaign_id.get(campaign.get("id"), {})
        rows.append({
            "campaign": campaign.get("name") or "(sin nombre)",
            "status": campaign.get("status"),
            "channel_type_raw": _channel_type_alias(campaign.get("advertisingChannelType")),
            "bid_strategy": campaign.get("biddingStrategyType"),
            "budget": _micros_to_units(_int_or_none(budget.get("amountMicros"))),
            "impressions": _int_or_none(metrics.get("impressions")),
            "clicks": _int_or_none(metrics.get("clicks")),
            "ctr": _float_or_none(metrics.get("ctr")),
            "avg_cpc": _micros_to_units(_int_or_none(metrics.get("averageCpc"))),
            "cost": _micros_to_units(_int_or_none(metrics.get("costMicros"))),
            "conversions": _float_or_none(metrics.get("conversions")),
            "cost_per_conv": _micros_to_units(_float_or_none(metrics.get("costPerConversion"))),
            "conv_rate": _float_or_none(metrics.get("conversionsFromInteractionsRate")),
            "conv_value": _float_or_none(metrics.get("conversionsValue")),
            "lost_is_budget": is_data.get("lost_is_budget"),
            "lost_is_rank": is_data.get("lost_is_rank"),
            "impr_share": is_data.get("impr_share"),
            "cpa_file_pct": None,  # esa columna solo existe en el CSV nativo, no en la API
        })
    return rows


# ---------------------------------------------------------------------------
# Negativización (Función 2) — leer términos de búsqueda con su campaña, y
# escribir palabras clave negativas de vuelta a la cuenta real. A diferencia
# de todo lo anterior en este archivo, fetch_campaign_rows/list_client_
# accounts, esta última función SÍ escribe en la cuenta del cliente — por
# eso push_negative_keywords soporta validate_only (vista previa sin aplicar
# el cambio) y nunca se llama con validate_only=False sin que antes haya
# pasado una vista previa exitosa desde la interfaz.
# ---------------------------------------------------------------------------

def fetch_search_terms(customer_id, date_from, date_to):
    """Términos de búsqueda del rango de fechas, con la campaña (y grupo de
    anuncios) donde aparecieron — necesario para poder subir el negativo a
    la campaña correcta. Excluye términos que ya están excluidos (ya son
    negativos), para no sugerir subir algo que ya se subió."""
    query = f"""
        SELECT
          search_term_view.search_term,
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          metrics.clicks,
          metrics.impressions,
          metrics.cost_micros,
          metrics.conversions
        FROM search_term_view
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND search_term_view.status != 'EXCLUDED'
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        stv = r.get("searchTermView", {})
        campaign = r.get("campaign", {})
        ad_group = r.get("adGroup", {})
        metrics = r.get("metrics", {})
        rows.append({
            "term": stv.get("searchTerm") or "",
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "ad_group_id": str(ad_group.get("id")) if ad_group.get("id") is not None else None,
            "ad_group_name": ad_group.get("name"),
            "clicks": _int_or_none(metrics.get("clicks")) or 0,
            "impr": _int_or_none(metrics.get("impressions")) or 0,
            "cost": _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0,
            "conversions": _float_or_none(metrics.get("conversions")) or 0,
        })
    return rows


def fetch_pmax_search_term_insights(customer_id, date_from, date_to):
    """Categorías de búsqueda para campañas Performance Max. Confirmado
    contra una cuenta real (2026-07-29): search_term_view devuelve 0 filas
    para PMax vía API aunque la UI de Google Ads sí muestre términos — esos
    datos viven en un recurso distinto, campaign_search_term_insight, que
    agrupa búsquedas parecidas bajo una categoría representativa en vez de
    traer el término literal exacto (para búsquedas comunes suele coincidir
    con el término real; para long-tail, Google las agrupa sin desglosar).
    metrics.cost_micros no es un campo soportado por este recurso (error
    PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE si se pide) — el costo por
    categoría no está disponible, a diferencia del costo por término real
    que sí trae fetch_search_terms(). La categoría con category_label vacío
    es el balde "(otros)" de búsquedas sin categorizar y se descarta, porque
    no corresponde a un texto que se pueda subir como negativo."""
    query = f"""
        SELECT
          campaign_search_term_insight.campaign_id,
          campaign_search_term_insight.category_label,
          campaign.name,
          metrics.clicks,
          metrics.impressions,
          metrics.conversions
        FROM campaign_search_term_insight
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        insight = r.get("campaignSearchTermInsight", {})
        label = insight.get("categoryLabel") or ""
        if not label:
            continue
        campaign = r.get("campaign", {})
        metrics = r.get("metrics", {})
        rows.append({
            "term": label,
            "campaign_id": str(insight.get("campaignId")) if insight.get("campaignId") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "ad_group_id": None,
            "ad_group_name": None,
            "clicks": _int_or_none(metrics.get("clicks")) or 0,
            "impr": _int_or_none(metrics.get("impressions")) or 0,
            "cost": None,
            "conversions": _float_or_none(metrics.get("conversions")) or 0,
            "is_category": True,
        })
    return rows


def fetch_account_campaigns(customer_id, only_active=True):
    """Lista liviana de campañas de la cuenta (id + nombre), de TODOS los
    tipos — a diferencia de fetch_search_terms, que solo puede traer
    campañas Search porque search_term_view es un recurso Search-only por
    diseño de Google. Se usa para poblar selectores donde hace falta ver
    todas las campañas activas aunque no tengan términos de búsqueda
    (ej. filtro de campaña en Negativización)."""
    status_filter = "campaign.status = 'ENABLED'" if only_active else "campaign.status != 'REMOVED'"
    query = f"""
        SELECT campaign.id, campaign.name
        FROM campaign
        WHERE {status_filter}
    """
    results = _search(customer_id, query)
    campaigns = []
    for r in results:
        c = r.get("campaign", {})
        campaigns.append({
            "id": str(c.get("id")) if c.get("id") is not None else None,
            "name": c.get("name") or "(sin nombre)",
        })
    return campaigns


def fetch_impression_share_daily(customer_id, date_from, date_to):
    """Evolución día a día de Impression Share, una fila por campaña y día
    (sin agregar) — para el gráfico de tendencia de Oportunidad de ingresos
    (mismo tipo de gráfica de referencia que trajo cesar: Search Lost IS
    budget/rank + Search Impr. Share, una línea por día). Estos campos solo
    existen para campañas Search — igual que en fetch_campaign_rows,
    combinarlos con metrics.impressions restringe el resultado a esas
    campañas, lo cual acá es correcto: la ponderación es por impresiones de
    Search, la única fuente real de oportunidad de Impression Share.

    A propósito NO se agrega por cuenta acá — se devuelve una fila por
    campaña y día, con campaign_name, para que el agregado (ponderado por
    impresiones, mismo criterio que usa Google Ads para el IS de cuenta) se
    calcule en el cliente según el filtro de campaña/hotel/marca que esté
    activo en pantalla (engine.aggregateImpressionShareDaily). Si se
    agregara acá, cambiar de campaña en el filtro no movería el gráfico."""
    query = f"""
        SELECT segments.date, campaign.id, campaign.name,
               metrics.impressions,
               metrics.search_impression_share,
               metrics.search_budget_lost_impression_share,
               metrics.search_rank_lost_impression_share
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        date = r.get("segments", {}).get("date")
        if not date:
            continue
        campaign = r.get("campaign", {})
        metrics = r.get("metrics", {})
        rows.append({
            "date": date,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "impr": _int_or_none(metrics.get("impressions")) or 0,
            "impr_share": _float_or_none(metrics.get("searchImpressionShare")),
            "lost_is_budget": _float_or_none(metrics.get("searchBudgetLostImpressionShare")),
            "lost_is_rank": _float_or_none(metrics.get("searchRankLostImpressionShare")),
        })
    return rows


# Etiquetas en español de las estrategias de puja — solo para mostrar en la
# interfaz, el valor real que llega de la API es el nombre en inglés
# (bidding_strategy_type).
BID_STRATEGY_LABELS = {
    "TARGET_ROAS": "ROAS objetivo",
    "MAXIMIZE_CONVERSION_VALUE": "Maximizar valor de conversión",
    "MAXIMIZE_CONVERSIONS": "Maximizar conversiones",
    "TARGET_CPA": "CPA objetivo",
    "MAXIMIZE_CLICKS": "Maximizar clics",
    "TARGET_SPEND": "Gasto objetivo",
    "MANUAL_CPC": "CPC manual",
    "MANUAL_CPM": "CPM manual",
    "MANUAL_CPV": "CPV manual",
    "TARGET_IMPRESSION_SHARE": "Cuota de impresiones objetivo",
    "PERCENT_CPC": "CPC por porcentaje",
    "COMMISSION": "Comisión",
}

# Solo estas dos estrategias tienen un ROAS objetivo que se pueda leer o
# ajustar — el resto (Maximizar conversiones, CPA objetivo, CPC manual, etc.)
# no tienen ese concepto en absoluto. Importante: confirmado con una prueba
# real (validateOnly) que Google Ads NO rechaza escribir target_roas sobre
# una campaña con una estrategia incompatible (ej. MAXIMIZE_CONVERSIONS) —
# la validación de Google es más permisiva de lo que parece, así que este
# set se usa para bloquear el ajuste del lado de la plataforma ANTES de
# construir la operación, en vez de confiar en que Google la rechace.
ROAS_ADJUSTABLE_STRATEGIES = {"TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"}


def fetch_roas_by_campaign(customer_id, date_from, date_to, only_active=False):
    """Por campaña: el ROAS logrado (valor de conversión ÷ gasto, del
    rango de fechas) junto con la estrategia de puja actual y su ROAS
    objetivo configurado (si la estrategia lo soporta) — para la sección
    ROAS, que compara ambos y permite ajustar el objetivo.

    campaign.bidding_strategy (no confundir con bidding_strategy_type) es
    el resource name de una estrategia de puja COMPARTIDA/portfolio, si la
    campaña usa una en vez de su propia estrategia — en ese caso el ROAS
    objetivo real vive en el recurso bidding_strategy, no en la campaña, y
    ajustarlo afectaría a todas las campañas que comparten esa estrategia
    (se marca is_portfolio=True para que la interfaz lo deje en solo
    lectura, en vez de ofrecer un ajuste que en realidad tocaría más de
    una campaña sin que quede claro)."""
    status_filter = "campaign.status = 'ENABLED'" if only_active else "campaign.status != 'REMOVED'"
    query = f"""
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.bidding_strategy_type,
               campaign.bidding_strategy,
               campaign.target_roas.target_roas,
               campaign.maximize_conversion_value.target_roas,
               metrics.cost_micros, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND {status_filter}
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        campaign = r.get("campaign", {})
        metrics = r.get("metrics", {})
        strategy_type = campaign.get("biddingStrategyType") or "UNSPECIFIED"
        cost = _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0
        conv_value = _float_or_none(metrics.get("conversionsValue")) or 0
        target_roas = campaign.get("targetRoas", {}).get("targetRoas")
        if target_roas is None:
            target_roas = campaign.get("maximizeConversionValue", {}).get("targetRoas")
        rows.append({
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "status": campaign.get("status") or "UNKNOWN",
            "bidding_strategy_type": strategy_type,
            "is_portfolio": bool(campaign.get("biddingStrategy")),
            "cost": cost,
            "conv_value": conv_value if conv_value > 0 else None,
            "roas": (conv_value / cost) if cost > 0 and conv_value > 0 else None,
            "target_roas": target_roas,
            "adjustable": strategy_type in ROAS_ADJUSTABLE_STRATEGIES and not campaign.get("biddingStrategy"),
        })
    return rows


def update_campaign_target_roas(customer_id, campaign_id, bidding_strategy_type, target_roas, validate_only=True):
    """Ajusta el ROAS objetivo de una campaña. Solo aplica a campañas con
    estrategia propia (no compartida) TARGET_ROAS o MAXIMIZE_CONVERSION_VALUE
    — se valida ANTES de construir la operación (ver nota en
    ROAS_ADJUSTABLE_STRATEGIES sobre por qué no basta con confiar en
    validateOnly). target_roas es un ratio (3.5 = 350%), no un porcentaje.

    validate_only=True (vista previa): Google valida la operación sin
    aplicarla. Solo con validate_only=False el cambio queda escrito de
    verdad en la cuenta."""
    if bidding_strategy_type not in ROAS_ADJUSTABLE_STRATEGIES:
        label = BID_STRATEGY_LABELS.get(bidding_strategy_type, bidding_strategy_type)
        raise ValueError(
            f"Esta campaña usa la estrategia \"{label}\", que no tiene un ROAS objetivo — "
            "habría que cambiar de estrategia de puja primero, algo que esta plataforma no hace."
        )
    if not target_roas or target_roas <= 0:
        raise ValueError("El ROAS objetivo debe ser un número mayor que cero.")

    if bidding_strategy_type == "TARGET_ROAS":
        mutate_field = {"targetRoas": {"targetRoas": target_roas}}
        update_mask = "target_roas.target_roas"
    else:  # MAXIMIZE_CONVERSION_VALUE
        mutate_field = {"maximizeConversionValue": {"targetRoas": target_roas}}
        update_mask = "maximize_conversion_value.target_roas"

    url = f"{BASE_URL}/customers/{customer_id}/campaigns:mutate"
    body = {
        "operations": [{
            "update": {"resourceName": f"customers/{customer_id}/campaigns/{campaign_id}", **mutate_field},
            "updateMask": update_mask,
        }],
        "validateOnly": validate_only,
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e

    return {"validate_only": validate_only, "applied": not validate_only, "target_roas": target_roas}


def push_negative_keywords(customer_id, items, validate_only=True):
    """Sube palabras clave negativas de concordancia exacta a nivel de
    campaña. items: lista de {"campaign_id": ..., "term": ...}.

    validate_only=True (vista previa): Google valida la operación sin
    aplicarla — nada cambia en la cuenta real. Solo con validate_only=False
    el cambio queda escrito de verdad.

    Usa partialFailure para que un término inválido (ej. ya existe como
    negativo) no tumbe la subida completa de los demás — cada fallo se
    reporta por separado en "failed"."""
    if not items:
        return {"created": 0, "failed": [], "validate_only": validate_only}

    operations = [{
        "create": {
            "campaign": f"customers/{customer_id}/campaigns/{item['campaign_id']}",
            "negative": True,
            "keyword": {"text": item["term"], "matchType": "EXACT"},
        }
    } for item in items]

    url = f"{BASE_URL}/customers/{customer_id}/campaignCriteria:mutate"
    body = {"operations": operations, "partialFailure": True, "validateOnly": validate_only}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e

    failed_indices = set()
    failed_messages = []
    partial_error = payload.get("partialFailureError")
    if partial_error:
        for detail in partial_error.get("details", []):
            for err in detail.get("errors", []):
                message = err.get("message", "Error desconocido.")
                idx = None
                for el in err.get("location", {}).get("fieldPathElements", []):
                    if el.get("fieldName") == "operations" and el.get("index") is not None:
                        idx = el["index"]
                if idx is not None and idx < len(items):
                    failed_indices.add(idx)
                    failed_messages.append(f"\"{items[idx]['term']}\" ({items[idx]['campaign_name']}): {message}" if 'campaign_name' in items[idx] else f"\"{items[idx]['term']}\": {message}")
                else:
                    failed_messages.append(message)

    created = len(items) - len(failed_indices)
    return {"created": created, "failed": failed_messages, "validate_only": validate_only}


# ---------------------------------------------------------------------------
# Datos simulados — mismas cuentas/campañas "de mentira" para poder construir
# y probar todo el flujo (selector de cuenta, rango de fechas, tabla,
# recomendaciones) mientras Google aprueba el developer token real. Se usan
# automáticamente en server.py cuando is_configured() es False.
# ---------------------------------------------------------------------------

SIMULATED_ACCOUNTS = [
    {"id": "1111111111", "name": "Estelar Hoteles (simulada)"},
    {"id": "2222222222", "name": "Click Clack (simulada)"},
]

SIMULATED_CAMPAIGNS = [
    {"campaign": "Estelar Hoteles - CO:es - PMAX Corpo", "status": "ENABLED", "channel_type_raw": "performance max", "bid_strategy": "MAXIMIZE_CONVERSION_VALUE", "budget": 8500, "impressions": 412000, "clicks": 9800, "ctr": 0.0238, "avg_cpc": 1.9, "cost": 18620, "conversions": 214, "cost_per_conv": 87.0, "conv_rate": 0.0218, "conv_value": 118200, "lost_is_budget": 0.22, "lost_is_rank": 0.04, "impr_share": 0.74},
    {"campaign": "Estelar Hoteles - CO:es - Search Marca", "status": "ENABLED", "channel_type_raw": "search", "bid_strategy": "TARGET_ROAS", "budget": 3000, "impressions": 96000, "clicks": 14200, "ctr": 0.1479, "avg_cpc": 0.6, "cost": 8520, "conversions": 305, "cost_per_conv": 27.9, "conv_rate": 0.0215, "conv_value": 156400, "lost_is_budget": 0.03, "lost_is_rank": 0.01, "impr_share": 0.96},
    {"campaign": "Estelar Hoteles - CO:es - Search Genérica", "status": "ENABLED", "channel_type_raw": "search", "bid_strategy": "MAXIMIZE_CONVERSIONS", "budget": 4200, "impressions": 258000, "clicks": 6100, "ctr": 0.0236, "avg_cpc": 2.4, "cost": 14640, "conversions": 98, "cost_per_conv": 149.4, "conv_rate": 0.0161, "conv_value": 41200, "lost_is_budget": 0.31, "lost_is_rank": 0.08, "impr_share": 0.61},
    {"campaign": "Estelar Hoteles - CO:es - Display Remarketing", "status": "ENABLED", "channel_type_raw": "display", "bid_strategy": "MAXIMIZE_CONVERSIONS", "budget": 900, "impressions": 640000, "clicks": 3100, "ctr": 0.0048, "avg_cpc": 0.9, "cost": 2790, "conversions": 21, "cost_per_conv": 132.9, "conv_rate": 0.0068, "conv_value": 6800, "lost_is_budget": None, "lost_is_rank": None, "impr_share": None},
    {"campaign": "Estelar Hoteles - CO:es - Search Temporada Baja (pausada)", "status": "PAUSED", "channel_type_raw": "search", "bid_strategy": "MAXIMIZE_CONVERSIONS", "budget": 1500, "impressions": 41000, "clicks": 780, "ctr": 0.019, "avg_cpc": 1.1, "cost": 858, "conversions": 4, "cost_per_conv": 214.5, "conv_rate": 0.0051, "conv_value": 1900, "lost_is_budget": 0.0, "lost_is_rank": 0.35, "impr_share": 0.42},
]


def simulated_campaign_rows(only_active=False):
    if only_active:
        return [c for c in SIMULATED_CAMPAIGNS if c["status"] == "ENABLED"]
    return SIMULATED_CAMPAIGNS


# IDs consistentes con SIMULATED_ACCOUNT_CAMPAIGNS donde coinciden, más uno
# nuevo para la campaña pausada — para que el flujo de ajuste (que necesita
# un campaign_id real para armar el resourceName) también se pueda probar
# en modo simulado.
_SIMULATED_CAMPAIGN_IDS_BY_NAME = {
    "Estelar Hoteles - CO:es - PMAX Corpo": "1111111103",
    "Estelar Hoteles - CO:es - Search Marca": "1111111102",
    "Estelar Hoteles - CO:es - Search Genérica": "1111111101",
    "Estelar Hoteles - CO:es - Display Remarketing": "1111111104",
    "Estelar Hoteles - CO:es - Search Temporada Baja (pausada)": "1111111105",
}

# target_roas simulado: dos campañas SÍ tienen un objetivo configurado (una
# por cada estrategia ajustable), las demás no — mismo mix que se encontró
# en la cuenta real (algunas campañas en Maximizar valor de conversión sin
# objetivo puesto).
_SIMULATED_TARGET_ROAS_BY_NAME = {
    "Estelar Hoteles - CO:es - PMAX Corpo": 6.0,
    "Estelar Hoteles - CO:es - Search Marca": 15.0,
}


def simulated_roas_by_campaign(only_active=False):
    rows = simulated_campaign_rows(only_active)
    out = []
    for c in rows:
        cost = c["cost"]
        conv_value = c.get("conv_value")
        strategy = c["bid_strategy"]
        out.append({
            "campaign_id": _SIMULATED_CAMPAIGN_IDS_BY_NAME.get(c["campaign"], c["campaign"]),
            "campaign_name": c["campaign"],
            "status": c["status"],
            "bidding_strategy_type": strategy,
            "is_portfolio": False,
            "cost": cost,
            "conv_value": conv_value,
            "roas": (conv_value / cost) if cost and conv_value else None,
            "target_roas": _SIMULATED_TARGET_ROAS_BY_NAME.get(c["campaign"]),
            "adjustable": strategy in ROAS_ADJUSTABLE_STRATEGIES,
        })
    return out


def simulated_update_campaign_target_roas(campaign_id, bidding_strategy_type, target_roas, validate_only=True):
    if bidding_strategy_type not in ROAS_ADJUSTABLE_STRATEGIES:
        label = BID_STRATEGY_LABELS.get(bidding_strategy_type, bidding_strategy_type)
        raise ValueError(
            f"Esta campaña usa la estrategia \"{label}\", que no tiene un ROAS objetivo — "
            "habría que cambiar de estrategia de puja primero, algo que esta plataforma no hace."
        )
    if not target_roas or target_roas <= 0:
        raise ValueError("El ROAS objetivo debe ser un número mayor que cero.")
    return {"validate_only": validate_only, "applied": not validate_only, "target_roas": target_roas, "simulated": True}


# Términos de búsqueda de ejemplo, con su campaña — para probar el flujo de
# Negativización (traer términos → clasificar → vista previa → subir) sin
# esperar a Google. "manzanillo del mar" es a propósito el mismo caso de
# ambigüedad ya validado con datos reales en la Función 2 (ver roadmap.md).
SIMULATED_SEARCH_TERMS = [
    {"term": "hotel estelar playa manzanillo opiniones", "campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_id": "1", "ad_group_name": "Genérico Hoteles Caribe", "clicks": 12, "impr": 340, "cost": 28.5, "conversions": 0},
    {"term": "manzanillo del mar cartagena", "campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_id": "1", "ad_group_name": "Genérico Hoteles Caribe", "clicks": 8, "impr": 210, "cost": 15.2, "conversions": 0},
    {"term": "hotel barato manzanillo", "campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_id": "1", "ad_group_name": "Genérico Hoteles Caribe", "clicks": 5, "impr": 130, "cost": 9.4, "conversions": 0},
    {"term": "estelar hoteles cartagena", "campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "ad_group_id": "2", "ad_group_name": "Marca Estelar", "clicks": 45, "impr": 980, "cost": 33.75, "conversions": 6},
    {"term": "reservar estelar playa manzanillo", "campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "ad_group_id": "2", "ad_group_name": "Marca Estelar", "clicks": 30, "impr": 620, "cost": 21.0, "conversions": 4},
    {"term": "trabajo camarera hotel cartagena", "campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_id": "1", "ad_group_name": "Genérico Hoteles Caribe", "clicks": 6, "impr": 95, "cost": 11.3, "conversions": 0},
    {"term": "hoteles todo incluido cartagena centro", "campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_id": "1", "ad_group_name": "Genérico Hoteles Caribe", "clicks": 9, "impr": 180, "cost": 17.6, "conversions": 0},
]


def simulated_search_terms():
    return SIMULATED_SEARCH_TERMS


# Categorías de búsqueda simuladas para la campaña PMax ("1111111103") —
# mismo formato que fetch_pmax_search_term_insights: sin costo (no
# disponible en ese recurso real) y con is_category=True. Incluye un
# competidor de bajo riesgo para poder probar el flujo de negativización
# igual que se validó contra la cuenta real (2026-07-29).
SIMULATED_PMAX_SEARCH_TERM_INSIGHTS = [
    {"term": "hotel estelar corporativo bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 210, "impr": 5600, "cost": None, "conversions": 18.4, "is_category": True},
    {"term": "hoteles para eventos empresariales bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 95, "impr": 3100, "cost": None, "conversions": 6.1, "is_category": True},
    {"term": "hotel tequendama bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 14, "impr": 240, "cost": None, "conversions": 0, "is_category": True},
]


def simulated_pmax_search_term_insights():
    return SIMULATED_PMAX_SEARCH_TERM_INSIGHTS


# Listado de TODAS las campañas activas de la cuenta simulada (no solo las
# que tienen search terms) — PMAX Corpo y Display Remarketing no generan
# search_term_view por ser no-Search, pero deben poder elegirse en el filtro
# de campaña de Negativización igual que en una cuenta real.
SIMULATED_ACCOUNT_CAMPAIGNS = [
    {"id": "1111111101", "name": "Estelar Hoteles - CO:es - Search Genérica"},
    {"id": "1111111102", "name": "Estelar Hoteles - CO:es - Search Marca"},
    {"id": "1111111103", "name": "Estelar Hoteles - CO:es - PMAX Corpo"},
    {"id": "1111111104", "name": "Estelar Hoteles - CO:es - Display Remarketing"},
]


def simulated_account_campaigns():
    return SIMULATED_ACCOUNT_CAMPAIGNS


def simulated_impression_share_daily(date_from, date_to):
    """Serie diaria simulada de Impression Share, una fila por campaña Search
    y día — con variación determinística por fecha/campaña, para poder
    probar en modo simulado que el gráfico de tendencia sí se recalcula al
    cambiar el filtro de campaña (mismo formato que fetch_impression_share_daily,
    sin agregar por cuenta)."""
    try:
        start = datetime.date.fromisoformat(date_from)
        end = datetime.date.fromisoformat(date_to)
    except ValueError:
        return []
    campaigns = [
        ("Estelar Hoteles - CO:es - Search Marca", 3),
        ("Estelar Hoteles - CO:es - Search Genérica", 5),
        ("Estelar Hoteles - CO:es - Search Temporada Baja (pausada)", 7),
    ]
    rows = []
    day = start
    i = 0
    while day <= end:
        for name, seed in campaigns:
            lost_budget = round(0.10 + ((i * 37 + seed * 11) % 23) / 100.0, 3)
            lost_rank = round(0.08 + ((i * 17 + seed * 13) % 19) / 100.0, 3)
            impr_share = round(max(0.0, min(1.0, 1 - lost_budget - lost_rank)), 3)
            rows.append({
                "date": day.isoformat(),
                "campaign_name": name,
                "impr": 150 + ((i * 13 + seed * 29) % 300),
                "impr_share": impr_share,
                "lost_is_budget": lost_budget,
                "lost_is_rank": lost_rank,
            })
        day += datetime.timedelta(days=1)
        i += 1
    return rows


def simulated_push_negative_keywords(items, validate_only=True):
    return {"created": len(items), "failed": [], "validate_only": validate_only, "simulated": True}
