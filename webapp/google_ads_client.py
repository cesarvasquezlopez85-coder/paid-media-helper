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


def simulated_push_negative_keywords(items, validate_only=True):
    return {"created": len(items), "failed": [], "validate_only": validate_only, "simulated": True}
