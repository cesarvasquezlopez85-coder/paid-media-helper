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

import calendar
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


def list_mcc_groups():
    """Todos los sub-MCCs bajo el MCC raíz, en CUALQUIER nivel — no solo los
    de nivel 1 (una "marca" de hotel, ej. "Estelar Hoteles MCC"). Confirmado
    contra cuentas reales: algunas marcas tienen un sub-MCC anidado adentro
    (ej. "GHL Hoteles MCC Nuevo" vive en nivel 2, dentro de otro MCC), y si
    solo mostramos nivel 1 esos quedan invisibles en el buscador aunque
    existan y tengan cuentas propias. No baja a las cuentas hoja acá (eso lo
    hace list_mcc_group_accounts cuando el usuario ya eligió cuál)."""
    mcc_id = os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]
    query = """
        SELECT customer_client.id, customer_client.descriptive_name
        FROM customer_client
        WHERE customer_client.status = 'ENABLED'
          AND customer_client.level > 0
          AND customer_client.manager = TRUE
    """
    rows = _search(mcc_id, query)
    groups = []
    for r in rows:
        cc = r.get("customerClient", {})
        groups.append({
            "id": str(cc.get("id")),
            "name": cc.get("descriptiveName") or f"MCC {cc.get('id')}",
        })
    return groups


def list_mcc_group_accounts(group_customer_id):
    """Todas las cuentas de cliente (hoja, no sub-MCC) debajo de un sub-MCC
    — confirmado contra cuentas reales que algunas marcas tienen sub-MCCs
    anidados adentro (ej. una agrupación regional), así que no basta con
    mirar un solo nivel: se recorre recursivamente, consultando
    customer_client con level<=1 desde CADA sub-MCC encontrado (nivel 0 =
    el propio nodo consultado, se descarta) hasta agotar la rama."""
    accounts = []
    to_visit = [group_customer_id]
    visited = set()
    query = """
        SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager
        FROM customer_client
        WHERE customer_client.status = 'ENABLED' AND customer_client.level <= 1
    """
    while to_visit:
        current = to_visit.pop()
        if current in visited:
            continue
        visited.add(current)
        rows = _search(current, query)
        for r in rows:
            cc = r.get("customerClient", {})
            cid = str(cc.get("id"))
            if cid == current:
                continue  # nivel 0: el propio nodo consultado
            if cc.get("manager"):
                to_visit.append(cid)
            else:
                accounts.append({
                    "id": cid,
                    "name": cc.get("descriptiveName") or f"Cuenta {cid}",
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


def fetch_account_pacing(customer_id):
    """Ritmo de consumo del mes en curso para una cuenta: el objetivo
    mensual sale de Billing > Presupuestos de cuenta (account_budget).

    OJO: "status = APPROVED" NO identifica un único presupuesto vigente —
    confirmado contra cuentas reales, una cuenta con años de historial
    puede tener ~100+ account_budget con status APPROVED, uno por cada
    periodo ya cerrado (acá las agencias arman uno por mes calendario,
    start/end alineados al primero de cada mes). Hay que filtrar también
    por fecha para quedarnos con el que cubre HOY. Si no hay ninguno (pago
    automático sin límite) o su tipo es INFINITE, monthly_target queda en
    None y el frontend lo muestra como "sin objetivo" en vez de semáforo.

    El gasto a la fecha se calcula sumando el mismo campo "cost" que ya usa
    Rendimiento (vía fetch_campaign_rows) para el mes en curso, en vez de
    usar account_budget.amount_served_micros — así el número siempre
    coincide con lo que el resto de la plataforma ya le muestra al usuario,
    y no depende de qué tan al día esté Google con el prorrateo de la
    facturación."""
    today = datetime.date.today()
    month_start = today.replace(day=1)
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    end_of_today = f"{today.isoformat()} 23:59:59"

    campaign_rows = fetch_campaign_rows(customer_id, month_start.isoformat(), today.isoformat())
    spend_mtd = sum((r.get("cost") or 0) for r in campaign_rows)

    budget_query = f"""
        SELECT account_budget.adjusted_spending_limit_micros,
               account_budget.adjusted_spending_limit_type
        FROM account_budget
        WHERE account_budget.status = 'APPROVED'
          AND account_budget.approved_start_date_time <= '{end_of_today}'
          AND account_budget.approved_end_date_time > '{end_of_today}'
    """
    budget_rows = _search(customer_id, budget_query)
    monthly_target = None
    if budget_rows:
        ab = budget_rows[0].get("accountBudget", {})
        if ab.get("adjustedSpendingLimitType") != "INFINITE":
            monthly_target = _micros_to_units(_int_or_none(ab.get("adjustedSpendingLimitMicros")))

    return {
        "spend_mtd": spend_mtd,
        "monthly_target": monthly_target,
        "days_elapsed": today.day,
        "days_in_month": days_in_month,
    }


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


# ---------------------------------------------------------------------------
# IA Max (AI Max for Search) — a diferencia de "Ask Advisor" (investigado y
# descartado, sin API pública — ver RECOMMENDATION_TYPE_LABELS más abajo),
# AI Max sí tiene soporte real en la API desde v25: Campaign.ai_max_setting
# (campaign.proto), verificado contra el .proto real antes de escribir esto.
# Solo campañas Search — el campo también existe para Shopping, pero "AI Max
# for Search" es el producto que pidió cesar; Shopping queda fuera de v1.
# ---------------------------------------------------------------------------

def fetch_ai_max_status(customer_id, only_active=False):
    """Estado de AI Max por campaña Search — activo/inactivo y si requiere
    "bundling" (campo de solo lectura de Google, informativo). No depende de
    rango de fechas: es configuración de la campaña, no una métrica de un
    periodo."""
    status_filter = "campaign.status = 'ENABLED'" if only_active else "campaign.status != 'REMOVED'"
    query = f"""
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.ai_max_setting.enable_ai_max,
               campaign.ai_max_setting.bundling_required
        FROM campaign
        WHERE campaign.advertising_channel_type = 'SEARCH'
          AND {status_filter}
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        campaign = r.get("campaign", {})
        ai_max = campaign.get("aiMaxSetting", {})
        rows.append({
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "status": campaign.get("status") or "UNKNOWN",
            "enabled": bool(ai_max.get("enableAiMax", False)),
            "bundling_required": ai_max.get("bundlingRequired") or "UNSPECIFIED",
        })
    return rows


def update_campaign_ai_max(customer_id, campaign_id, enable, validate_only=True):
    """Prende/apaga AI Max en una campaña Search. Campo booleano simple —
    a diferencia de ROAS, no hay chequeo de compatibilidad de estrategia que
    hacer antes: cualquier campaña Search puede tener AI Max prendido o
    apagado.

    validate_only=True (vista previa): Google valida la operación sin
    aplicarla. Solo con validate_only=False el cambio queda escrito de
    verdad en la cuenta."""
    url = f"{BASE_URL}/customers/{customer_id}/campaigns:mutate"
    body = {
        "operations": [{
            "update": {
                "resourceName": f"customers/{customer_id}/campaigns/{campaign_id}",
                "aiMaxSetting": {"enableAiMax": bool(enable)},
            },
            "updateMask": "ai_max_setting.enable_ai_max",
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

    return {"validate_only": validate_only, "applied": not validate_only, "enabled": bool(enable)}


AI_MAX_SEARCH_TERM_MATCH_SOURCES = ("AI_MAX_KEYWORDLESS", "AI_MAX_BROAD_MATCH")


def fetch_ai_max_served_combinations(customer_id, campaign_id=None, date_from=None, date_to=None):
    """Qué términos de búsqueda sirvió AI Max de verdad, con métricas
    reales — search_term_view filtrado por segments.search_term_match_source
    (AI_MAX_KEYWORDLESS / AI_MAX_BROAD_MATCH), el patrón que documenta
    Google para este reporte.

    La primera versión de esta función usaba
    ai_max_search_term_ad_combination_view en vez de esto — confirmado
    contra una cuenta real con AI Max ya activo (Estelar Yopal, 2026-08-18)
    que esa vista devuelve 0 filas: no tiene métricas propias (ver commit
    anterior) y, sin `segments.date`, tampoco parece traer datos aunque
    haya tráfico real. search_term_view sí trae impresiones/clics/costo/
    conversiones, y es el mismo recurso que ya usa Negativización — más
    confiable que una vista nueva sin ejemplos de uso documentados.

    Rango de fechas fijo de últimos 30 días (igual que el ejemplo oficial
    de Google) para no agregar otro selector de fechas a la pantalla."""
    date_from = date_from or (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    date_to = date_to or datetime.date.today().isoformat()
    match_sources = ", ".join(f"'{s}'" for s in AI_MAX_SEARCH_TERM_MATCH_SOURCES)
    campaign_filter = f"AND campaign.id = {int(campaign_id)}" if campaign_id else ""
    query = f"""
        SELECT
          search_term_view.search_term,
          segments.search_term_match_source,
          campaign.id, campaign.name,
          ad_group.id, ad_group.name,
          metrics.impressions, metrics.clicks,
          metrics.cost_micros, metrics.conversions
        FROM search_term_view
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND segments.search_term_match_source IN ({match_sources})
          {campaign_filter}
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        stv = r.get("searchTermView", {})
        campaign = r.get("campaign", {})
        ad_group = r.get("adGroup", {})
        segments = r.get("segments", {})
        metrics = r.get("metrics", {})
        search_term = stv.get("searchTerm")
        if not search_term:
            continue
        rows.append({
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "ad_group_name": ad_group.get("name") or "(sin nombre)",
            "search_term": search_term,
            "match_source": segments.get("searchTermMatchSource") or "UNKNOWN",
            "impressions": _int_or_none(metrics.get("impressions")) or 0,
            "clicks": _int_or_none(metrics.get("clicks")) or 0,
            "cost": _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0,
            "conversions": _float_or_none(metrics.get("conversions")) or 0,
        })
    return rows


def fetch_account_negative_keywords(customer_id):
    """Negativos de concordancia exacta que YA están escritos de verdad en
    la cuenta (campaign_criterion con negative=true) — distinto de la
    clasificación núcleo/excepción de Negativización, que es efímera (se
    escribe en pantalla cada vez, no se guarda). Esto se usa para cruzar
    contra lo que AI Max está sirviendo — ver el helper de cruce en
    engine.js."""
    query = """
        SELECT campaign.id, campaign.name,
               campaign_criterion.keyword.text,
               campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.negative = true
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        campaign = r.get("campaign", {})
        criterion = r.get("campaignCriterion", {})
        keyword = criterion.get("keyword", {})
        text = keyword.get("text")
        if not text:
            continue
        rows.append({
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "text": text,
            "match_type": keyword.get("matchType") or "UNKNOWN",
        })
    return rows


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
# Exclusiones de contenido a nivel de cuenta (CustomerNegativeCriterion) —
# categorías de contenido "no apto" y de apps que se excluyen de TODA la
# cuenta de una sola vez, a diferencia de los negativos de Negativización
# (por campaña, CampaignCriterion). Solo tiene efecto real en campañas que
# sirven sobre contenido/apps/ubicaciones — Performance Max, Demand Gen,
# Display, Video — no en Search puro (ahí no hay "contenido" del cual
# excluirse, salvo que la campaña use la red de Search Partners). Para
# Performance Max en particular, las exclusiones de contenido/ubicación
# SOLO se pueden tocar a nivel de cuenta — no existe equivalente por
# campaña — así que este es el único lugar desde el que se puede ajustar
# esto para esas campañas. A pedido explícito de cesar (2026-09-23): que
# esto pese más para PMax/Demand Gen/Display/Video, no tanto para Search.
#
# Nombres de campo y forma de los mensajes verificados contra los .proto
# reales de la API v25 (CustomerNegativeCriterion, ContentLabelInfo,
# MobileAppCategoryInfo, MobileAppCategoryConstant) antes de escribir esto
# — mismo criterio que el resto de la integración.
# ---------------------------------------------------------------------------

# Las 26 categorías reales de ContentLabelTypeEnum (v25), sin UNSPECIFIED/
# UNKNOWN — confirmadas contra el .proto completo, no adivinadas.
CONTENT_LABEL_TYPES = (
    "SEXUALLY_SUGGESTIVE", "BELOW_THE_FOLD", "PARKED_DOMAIN", "JUVENILE",
    "PROFANITY", "TRAGEDY", "VIDEO", "VIDEO_RATING_DV_G", "VIDEO_RATING_DV_PG",
    "VIDEO_RATING_DV_T", "VIDEO_RATING_DV_MA", "VIDEO_NOT_YET_RATED",
    "EMBEDDED_VIDEO", "LIVE_STREAMING_VIDEO", "SOCIAL_ISSUES",
    "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES", "BRAND_SUITABILITY_GAMES_FIGHTING",
    "BRAND_SUITABILITY_GAMES_MATURE", "BRAND_SUITABILITY_HEALTH_SENSITIVE",
    "BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED", "BRAND_SUITABILITY_NEWS_RECENT",
    "BRAND_SUITABILITY_NEWS_SENSITIVE", "BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED",
    "BRAND_SUITABILITY_POLITICS", "BRAND_SUITABILITY_RELIGION",
)

CONTENT_LABEL_LABELS = {
    "SEXUALLY_SUGGESTIVE": "Contenido sexualmente sugestivo",
    "BELOW_THE_FOLD": "Ubicación \"bajo el pliegue\" (below the fold)",
    "PARKED_DOMAIN": "Dominio estacionado (parked domain)",
    "JUVENILE": "Contenido juvenil, grotesco o bizarro",
    "PROFANITY": "Lenguaje profano o vulgar",
    "TRAGEDY": "Muerte y tragedia",
    "VIDEO": "Contenido de video (en general)",
    "VIDEO_RATING_DV_G": "Video — clasificación G",
    "VIDEO_RATING_DV_PG": "Video — clasificación PG",
    "VIDEO_RATING_DV_T": "Video — clasificación T",
    "VIDEO_RATING_DV_MA": "Video — clasificación MA",
    "VIDEO_NOT_YET_RATED": "Video sin clasificar todavía",
    "EMBEDDED_VIDEO": "Video incrustado",
    "LIVE_STREAMING_VIDEO": "Video en vivo (streaming)",
    "SOCIAL_ISSUES": "Temas sociales sensibles",
    "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES": "Contenido apto para familias (incl. \"Hecho para niños\" de YouTube)",
    "BRAND_SUITABILITY_GAMES_FIGHTING": "Videojuegos de combate o pelea",
    "BRAND_SUITABILITY_GAMES_MATURE": "Videojuegos con contenido maduro",
    "BRAND_SUITABILITY_HEALTH_SENSITIVE": "Contenido de salud sensible",
    "BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED": "Salud, de fuentes poco verificadas",
    "BRAND_SUITABILITY_NEWS_RECENT": "Noticias recién anunciadas",
    "BRAND_SUITABILITY_NEWS_SENSITIVE": "Noticias sensibles (crímenes, accidentes, controversia)",
    "BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED": "Noticias de fuentes no destacadas por Google/YouTube",
    "BRAND_SUITABILITY_POLITICS": "Política, elecciones y eventos políticos",
    "BRAND_SUITABILITY_RELIGION": "Temas religiosos",
}


def content_label_type_label(raw_type):
    return CONTENT_LABEL_LABELS.get(raw_type, raw_type)


def fetch_content_exclusions(customer_id):
    """Categorías de contenido y de apps que YA están excluidas de toda la
    cuenta (CustomerNegativeCriterion). No incluye placements/YouTube/IP —
    fuera del alcance de v1, se puede agregar después si hace falta."""
    query = """
        SELECT customer_negative_criterion.resource_name,
               customer_negative_criterion.type,
               customer_negative_criterion.content_label.type,
               customer_negative_criterion.mobile_app_category.mobile_app_category_constant
        FROM customer_negative_criterion
        WHERE customer_negative_criterion.type IN ('CONTENT_LABEL', 'MOBILE_APP_CATEGORY')
    """
    results = _search(customer_id, query)
    content_labels = []
    app_categories = []
    for r in results:
        criterion = r.get("customerNegativeCriterion", {})
        resource_name = criterion.get("resourceName")
        criterion_type = criterion.get("type")
        if criterion_type == "CONTENT_LABEL":
            label_type = criterion.get("contentLabel", {}).get("type")
            if not label_type:
                continue
            content_labels.append({
                "resource_name": resource_name,
                "type": label_type,
                "label": content_label_type_label(label_type),
            })
        elif criterion_type == "MOBILE_APP_CATEGORY":
            constant = criterion.get("mobileAppCategory", {}).get("mobileAppCategoryConstant")
            if not constant:
                continue
            app_categories.append({"resource_name": resource_name, "category_constant": constant})
    return {"content_labels": content_labels, "app_categories": app_categories}


def fetch_mobile_app_categories(customer_id):
    """Catálogo completo de categorías de apps que reconoce Google Ads
    (MobileAppCategoryConstant) — recurso "constante": el mismo para
    cualquier cuenta, pero la API igual exige pegarle a una cuenta real
    para autenticar la consulta."""
    query = """
        SELECT mobile_app_category_constant.id,
               mobile_app_category_constant.resource_name,
               mobile_app_category_constant.name
        FROM mobile_app_category_constant
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        constant = r.get("mobileAppCategoryConstant", {})
        name = constant.get("name")
        resource_name = constant.get("resourceName")
        if not name or not resource_name:
            continue
        rows.append({"resource_name": resource_name, "name": name})
    rows.sort(key=lambda x: x["name"])
    return rows


def _mutate_customer_negative_criteria(customer_id, operations, validate_only):
    url = f"{BASE_URL}/customers/{customer_id}/customerNegativeCriteria:mutate"
    body = {"operations": operations, "partialFailure": True, "validateOnly": validate_only}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e


def add_content_label_exclusions(customer_id, content_label_types, validate_only=True):
    """Excluye una o más categorías de contenido de TODA la cuenta.
    validate_only=True (vista previa): Google valida sin aplicar. Usa
    partialFailure para que una categoría ya excluida (Google la rechaza
    como duplicada) no tumbe la subida de las demás."""
    if not content_label_types:
        return {"created": 0, "failed": [], "validate_only": validate_only}
    operations = [{"create": {"contentLabel": {"type": t}}} for t in content_label_types]
    payload = _mutate_customer_negative_criteria(customer_id, operations, validate_only)
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
                if idx is not None and idx < len(content_label_types):
                    failed_indices.add(idx)
                    failed_messages.append(f"\"{content_label_type_label(content_label_types[idx])}\": {message}")
                else:
                    failed_messages.append(message)
    created = len(content_label_types) - len(failed_indices)
    return {"created": created, "failed": failed_messages, "validate_only": validate_only}


def add_app_category_exclusions(customer_id, category_resource_names, validate_only=True):
    """Excluye una o más categorías de apps de TODA la cuenta de una vez —
    cada elemento de category_resource_names es el resource_name completo
    de MobileAppCategoryConstant, ej. "mobileAppCategoryConstants/70000".
    Mismo patrón que add_content_label_exclusions (partialFailure para que
    una ya excluida no tumbe las demás)."""
    if not category_resource_names:
        return {"created": 0, "failed": [], "validate_only": validate_only}
    operations = [{"create": {"mobileAppCategory": {"mobileAppCategoryConstant": r}}} for r in category_resource_names]
    payload = _mutate_customer_negative_criteria(customer_id, operations, validate_only)
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
                if idx is not None and idx < len(category_resource_names):
                    failed_indices.add(idx)
                    failed_messages.append(f"{category_resource_names[idx]}: {message}")
                else:
                    failed_messages.append(message)
    created = len(category_resource_names) - len(failed_indices)
    return {"created": created, "failed": failed_messages, "validate_only": validate_only}


def remove_customer_negative_criterion(customer_id, resource_name, validate_only=True):
    """Quita una exclusión existente (categoría de contenido o de apps) —
    mismo endpoint, operación "remove" con el resource_name completo del
    CustomerNegativeCriterion."""
    operations = [{"remove": resource_name}]
    _mutate_customer_negative_criteria(customer_id, operations, validate_only)
    return {"validate_only": validate_only, "applied": not validate_only}


# ---------------------------------------------------------------------------
# Recomendaciones de Google (Función 9) — el motor de recomendaciones propio
# de Google Ads (el mismo que alimenta el "puntaje de optimización" y la
# pestaña "Recomendaciones" de la interfaz), NO el nuevo "Ask Advisor"
# conversacional (ese no tiene API pública — confirmado en la investigación
# del 2026-08-11, ver Resumen_Proyecto.md). Es de solo lectura por ahora: no
# hay botón para aplicar/descartar, solo mostrar qué encontró Google.
#
# Nombres de campo verificados contra el .proto real de la API v25
# (googleapis/googleapis en GitHub, no la documentación en developers.google.com
# — esa es una SPA que no se puede leer sin ejecutar JS) y luego confirmados
# contra una cuenta real (2026-08-11, Spiwak Chipichape): pedir un campo
# anidado de recommendation.impact por separado (ej.
# recommendation.impact.base_metrics.cost_micros) da 400 UNRECOGNIZED_FIELD
# — hay que pedir recommendation.impact completo (ver fetch_recommendations).
# Por precaución, esta primera versión solo pide los campos genéricos (tipo,
# campaña, impacto) — sin el detalle específico de cada tipo (ej. el monto
# de presupuesto sugerido, que vive en recommendation.campaign_budget_recommendation
# y otros ~55 campos oneof por tipo) — para no repetir el mismo problema que
# ya se vio con el Impression Share de Search en fetch_campaign_rows, donde
# combinar campos de más de un "grupo" en la misma consulta restringía el
# resultado en silencio. Ese riesgo específico no se probó todavía contra
# una cuenta real para los campos por tipo — queda pendiente si hace falta
# el detalle (ej. mostrar el monto de presupuesto sugerido).
RECOMMENDATION_TYPE_LABELS = {
    "CAMPAIGN_BUDGET": "Ajustar presupuesto",
    "MOVE_UNUSED_BUDGET": "Mover presupuesto sin usar",
    "FORECASTING_CAMPAIGN_BUDGET": "Presupuesto proyectado (temporada)",
    "MARGINAL_ROI_CAMPAIGN_BUDGET": "Presupuesto por ROI marginal",
    "KEYWORD": "Agregar palabra clave",
    "KEYWORD_MATCH_TYPE": "Ampliar concordancia de palabra clave",
    "USE_BROAD_MATCH_KEYWORD": "Usar concordancia amplia",
    "TEXT_AD": "Agregar anuncio de texto",
    "RESPONSIVE_SEARCH_AD": "Agregar anuncio de búsqueda responsivo",
    "RESPONSIVE_SEARCH_AD_ASSET": "Agregar recursos al anuncio responsivo",
    "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH": "Mejorar fuerza del anuncio responsivo",
    "TARGET_CPA_OPT_IN": "Cambiar a estrategia CPA objetivo",
    "TARGET_ROAS_OPT_IN": "Cambiar a estrategia ROAS objetivo",
    "MAXIMIZE_CONVERSIONS_OPT_IN": "Cambiar a Maximizar conversiones",
    "MAXIMIZE_CONVERSION_VALUE_OPT_IN": "Cambiar a Maximizar valor de conversión",
    "MAXIMIZE_CLICKS_OPT_IN": "Cambiar a Maximizar clics",
    "ENHANCED_CPC_OPT_IN": "Activar CPC mejorado",
    "RAISE_TARGET_CPA": "Subir el CPA objetivo",
    "RAISE_TARGET_CPA_BID_TOO_LOW": "CPA objetivo demasiado bajo",
    "LOWER_TARGET_ROAS": "Bajar el ROAS objetivo",
    "SET_TARGET_CPA": "Definir un CPA objetivo",
    "SET_TARGET_ROAS": "Definir un ROAS objetivo",
    "SEARCH_PARTNERS_OPT_IN": "Mostrar anuncios en Search Partners",
    "OPTIMIZE_AD_ROTATION": "Optimizar rotación de anuncios",
    "DISPLAY_EXPANSION_OPT_IN": "Activar expansión a Display",
    "PERFORMANCE_MAX_OPT_IN": "Migrar a Performance Max",
    "PERFORMANCE_MAX_FINAL_URL_OPT_IN": "Activar expansión de URL final en PMax",
    "IMPROVE_PERFORMANCE_MAX_AD_STRENGTH": "Mejorar fuerza de Performance Max",
    "UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX": "Migrar Smart Shopping a Performance Max",
    "UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX": "Migrar campaña Local a Performance Max",
    "MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX": "Migrar Dynamic Search Ads a Performance Max",
    "IMPROVE_DEMAND_GEN_AD_STRENGTH": "Mejorar fuerza de anuncios Demand Gen",
    "CALLOUT_ASSET": "Agregar frases destacadas",
    "SITELINK_ASSET": "Agregar enlaces de sitio",
    "CALL_ASSET": "Agregar extensión de llamada",
    "LEAD_FORM_ASSET": "Agregar formulario de clientes potenciales",
    "DYNAMIC_IMAGE_EXTENSION_OPT_IN": "Activar imágenes dinámicas",
    "CUSTOM_AUDIENCE_OPT_IN": "Crear audiencia personalizada",
    "REFRESH_CUSTOMER_MATCH_LIST": "Actualizar lista de Customer Match",
    "IMPROVE_GOOGLE_TAG_COVERAGE": "Mejorar cobertura del Google Tag",
}


def _recommendation_type_label(raw_type):
    if not raw_type:
        return "Recomendación"
    return RECOMMENDATION_TYPE_LABELS.get(raw_type, raw_type.replace("_", " ").capitalize())


def fetch_optimization_score(customer_id):
    """Puntaje de optimización de la cuenta (0-1, se muestra como %) — el
    mismo número que aparece en la pestaña "Recomendaciones" de la interfaz
    de Google Ads. optimization_score_weight es la ponderación total usada
    para calcularlo; se devuelve por si hace falta más adelante, pero hoy
    solo se muestra el score."""
    query = "SELECT customer.optimization_score, customer.optimization_score_weight FROM customer"
    results = _search(customer_id, query)
    if not results:
        return {"score": None, "score_weight": None}
    customer = results[0].get("customer", {})
    return {
        "score": _float_or_none(customer.get("optimizationScore")),
        "score_weight": _float_or_none(customer.get("optimizationScoreWeight")),
    }


def fetch_recommendations(customer_id):
    """Recomendaciones activas (no descartadas) de Google Ads para la
    cuenta — el motor de reglas/ML propio de Google, no un modelo de
    lenguaje. Solo campos genéricos (ver nota arriba del archivo sobre por
    qué no se piden campos específicos de cada tipo todavía).

    Confirmado contra una cuenta real (2026-08-11): GAQL rechaza pedir los
    campos anidados de recommendation.impact por separado (ej.
    recommendation.impact.base_metrics.cost_micros) con 400
    UNRECOGNIZED_FIELD — hay que pedir recommendation.impact completo, y
    Google devuelve el objeto entero (base_metrics/potential_metrics, cada
    uno con solo los campos que aplican a ese tipo de recomendación). No
    todas las recomendaciones traen impact (ej. USE_BROAD_MATCH_KEYWORD no
    trajo ninguno en la prueba real) — impact queda ausente en esos casos."""
    query = """
        SELECT
          recommendation.resource_name,
          recommendation.type,
          recommendation.campaign,
          recommendation.dismissed,
          recommendation.impact,
          campaign.name
        FROM recommendation
        WHERE recommendation.dismissed = FALSE
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        rec = r.get("recommendation", {})
        campaign = r.get("campaign", {})
        impact = rec.get("impact", {})
        base = impact.get("baseMetrics", {})
        potential = impact.get("potentialMetrics", {})
        raw_type = rec.get("type")
        rows.append({
            "resource_name": rec.get("resourceName"),
            "type": raw_type,
            "type_label": _recommendation_type_label(raw_type),
            "campaign_name": campaign.get("name"),
            "base_cost": _micros_to_units(_int_or_none(base.get("costMicros"))),
            "base_conversions": _float_or_none(base.get("conversions")),
            "potential_cost": _micros_to_units(_int_or_none(potential.get("costMicros"))),
            "potential_conversions": _float_or_none(potential.get("conversions")),
            "potential_impressions": _float_or_none(potential.get("impressions")),
            "potential_clicks": _float_or_none(potential.get("clicks")),
        })
    return rows


# apply/dismiss — a diferencia de campaigns:mutate y campaignCriteria:mutate
# (los otros dos endpoints de escritura de esta plataforma), confirmado
# contra el .proto real: ApplyRecommendationRequest y
# DismissRecommendationRequest NO tienen un campo validate_only. No hay
# forma de pedirle a Google que valide sin aplicar — cada llamada real
# ejecuta el cambio de inmediato. Por eso acá la confirmación corre del
# lado del cliente (una advertencia clara antes del clic), no de una vista
# previa server-side como en push_negative_keywords/update_campaign_target_roas.
#
# apply_recommendation() solo manda el resource_name, sin apply_parameters
# — funciona para recomendaciones tipo "interruptor" (activar Search
# Partners, expansión a Display, etc.) que no piden ningún valor adicional.
# Para las que sí necesitan un parámetro específico (presupuesto sugerido,
# palabra clave, texto de anuncio — ver RECOMMENDATION_TYPE_LABELS y la nota
# de arriba del archivo), Google rechaza la operación pidiendo ese
# parámetro; ese error se muestra tal cual en vez de intentar adivinar un
# valor — construir esas pantallas específicas queda para más adelante.
def apply_recommendation(customer_id, resource_name):
    url = f"{BASE_URL}/customers/{customer_id}/recommendations:apply"
    body = {"operations": [{"resourceName": resource_name}]}
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
    return {"applied": True}


def dismiss_recommendation(customer_id, resource_name):
    """Descarta una recomendación — no cambia nada de la cuenta real, solo
    le dice a Google que esta sugerencia en particular no interesa. Bajo
    riesgo comparado con aplicar, aunque tampoco tiene vista previa."""
    url = f"{BASE_URL}/customers/{customer_id}/recommendations:dismiss"
    body = {"operations": [{"resourceName": resource_name}]}
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
    return {"dismissed": True}


# ---------------------------------------------------------------------------
# Planificador de palabras clave (Keyword Planner) — Ideas, Histórico, y
# Pronóstico. A diferencia del resto de la integración, estas no son
# consultas GAQL sino tres RPCs de KeywordPlanIdeaService
# (GenerateKeywordIdeas, GenerateKeywordHistoricalMetrics,
# GenerateKeywordForecastMetrics) más
# GeoTargetConstantService.SuggestGeoTargetConstants para buscar geos por
# nombre — todas de solo lectura, no escriben nada en la cuenta. A pedido
# explícito de cesar (2026-09-29), después de confirmar contra el .proto
# real que Performance Planner (la curva de presupuesto vs. conversiones de
# campañas ya activas) NO tiene API pública — esto es lo más cercano que sí
# existe: un pronóstico puntual para una campaña hipotética, no una
# optimización automática. Nombres de campo verificados contra los .proto
# reales de la API v25 antes de escribir esto.
# ---------------------------------------------------------------------------

def _units_to_micros(v):
    return None if v in (None, "") else int(round(float(v) * MICROS))


def _post_json(url, body):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e


def fetch_geo_target_suggestions(query_text):
    """Busca geo-targets (países, ciudades, regiones) por nombre — recurso
    global de Google (no depende de una cuenta en particular), pero igual
    exige autenticarse con un developer token real."""
    url = f"{BASE_URL}/geoTargetConstants:suggest"
    body = {"locationNames": {"names": [query_text]}}
    payload = _post_json(url, body)
    rows = []
    for s in payload.get("geoTargetConstantSuggestions", []):
        g = s.get("geoTargetConstant", {})
        rows.append({
            "resource_name": g.get("resourceName"),
            "name": g.get("name"),
            "country_code": g.get("countryCode"),
            "canonical_name": g.get("canonicalName"),
        })
    return rows


def fetch_targetable_languages(customer_id):
    """Catálogo de idiomas que se pueden targetear — recurso "constante"
    (igual que mobile_app_category_constant en Exclusiones de contenido),
    filtrado a los targeteables."""
    query = """
        SELECT language_constant.code, language_constant.name,
               language_constant.resource_name
        FROM language_constant
        WHERE language_constant.targetable = TRUE
    """
    results = _search(customer_id, query)
    rows = []
    for r in results:
        lc = r.get("languageConstant", {})
        name = lc.get("name")
        resource_name = lc.get("resourceName")
        if not name or not resource_name:
            continue
        rows.append({"resource_name": resource_name, "code": lc.get("code"), "name": name})
    rows.sort(key=lambda x: x["name"])
    return rows


def _keyword_metrics_from(raw):
    m = raw.get("keywordIdeaMetrics") or raw.get("keywordMetrics") or {}
    return {
        "avg_monthly_searches": _int_or_none(m.get("avgMonthlySearches")),
        "competition": m.get("competition"),
        "competition_index": _int_or_none(m.get("competitionIndex")),
        "low_top_of_page_bid_micros": _int_or_none(m.get("lowTopOfPageBidMicros")),
        "high_top_of_page_bid_micros": _int_or_none(m.get("highTopOfPageBidMicros")),
        "monthly_search_volumes": [
            {
                "year": _int_or_none(v.get("year")),
                "month": v.get("month"),
                "monthly_searches": _int_or_none(v.get("monthlySearches")),
            }
            for v in m.get("monthlySearchVolumes", [])
        ],
    }


def fetch_keyword_ideas(customer_id, seed_keywords=None, seed_url=None, geo_resource_names=None,
                         language_resource_name=None, network="GOOGLE_SEARCH_AND_PARTNERS",
                         include_adult=False, page_size=500):
    """Ideas de palabras clave nuevas a partir de keywords semilla, una URL,
    o ambas — la pestaña "Descubre nuevas palabras clave" de Keyword
    Planner. Al menos una de seed_keywords/seed_url debe venir."""
    body = {
        "keywordPlanNetwork": network,
        "includeAdultKeywords": include_adult,
        "pageSize": page_size,
    }
    if geo_resource_names:
        body["geoTargetConstants"] = geo_resource_names
    if language_resource_name:
        body["language"] = language_resource_name
    if seed_keywords and seed_url:
        body["keywordAndUrlSeed"] = {"url": seed_url, "keywords": seed_keywords}
    elif seed_url:
        body["urlSeed"] = {"url": seed_url}
    elif seed_keywords:
        body["keywordSeed"] = {"keywords": seed_keywords}
    else:
        raise ValueError("Se necesita al menos una keyword semilla o una URL.")

    url = f"{BASE_URL}/customers/{customer_id}:generateKeywordIdeas"
    payload = _post_json(url, body)
    results = payload.get("results", [])
    rows = [{"text": r.get("text"), **_keyword_metrics_from(r)} for r in results]
    return {"rows": rows, "total_size": _int_or_none(payload.get("totalSize")) or len(rows)}


def fetch_keyword_historical_metrics(customer_id, keywords, geo_resource_names=None,
                                      language_resource_name=None,
                                      network="GOOGLE_SEARCH_AND_PARTNERS", include_adult=False):
    """Volumen de búsqueda histórico (mes a mes) para una lista de keywords
    que el usuario ya trae — la pestaña "Ver métricas históricas" de
    Keyword Planner."""
    if not keywords:
        return {"rows": []}
    body = {
        "keywords": keywords,
        "keywordPlanNetwork": network,
        "includeAdultKeywords": include_adult,
    }
    if geo_resource_names:
        body["geoTargetConstants"] = geo_resource_names
    if language_resource_name:
        body["language"] = language_resource_name

    url = f"{BASE_URL}/customers/{customer_id}:generateKeywordHistoricalMetrics"
    payload = _post_json(url, body)
    results = payload.get("results", [])
    rows = [{"text": r.get("text"), **_keyword_metrics_from(r)} for r in results]
    return {"rows": rows}


def fetch_keyword_forecast(customer_id, keywords, match_type, geo_resource_names,
                            language_resource_names, bidding_mode, start_date, end_date,
                            daily_budget=None, max_cpc_bid=None, daily_target_spend=None,
                            max_cpc_bid_ceiling=None, currency_code=None):
    """Pronóstico de clics/costo/conversiones para una campaña hipotética
    armada con estas keywords, geo, idioma, y estrategia de puja — la
    pestaña "Pronosticar" de Keyword Planner. No optimiza nada por sí solo:
    el usuario elige el presupuesto y la estrategia, esto solo estima el
    resultado de ESA combinación puntual (no hay curva automática como en
    Performance Planner, que no tiene API pública)."""
    if not keywords:
        raise ValueError("Se necesita al menos una keyword.")
    if bidding_mode == "MANUAL_CPC":
        bidding_strategy = {"manualCpcBiddingStrategy": {"maxCpcBidMicros": _units_to_micros(max_cpc_bid)}}
        if daily_budget:
            bidding_strategy["manualCpcBiddingStrategy"]["dailyBudgetMicros"] = _units_to_micros(daily_budget)
    elif bidding_mode == "MAXIMIZE_CLICKS":
        bidding_strategy = {"maximizeClicksBiddingStrategy": {"dailyTargetSpendMicros": _units_to_micros(daily_target_spend)}}
        if max_cpc_bid_ceiling:
            bidding_strategy["maximizeClicksBiddingStrategy"]["maxCpcBidCeilingMicros"] = _units_to_micros(max_cpc_bid_ceiling)
    elif bidding_mode == "MAXIMIZE_CONVERSIONS":
        bidding_strategy = {"maximizeConversionsBiddingStrategy": {"dailyTargetSpendMicros": _units_to_micros(daily_target_spend)}}
    else:
        raise ValueError(f"Estrategia de puja desconocida: {bidding_mode}")

    body = {
        "forecastPeriod": {"startDate": start_date, "endDate": end_date},
        "campaign": {
            "geoTargetConstants": geo_resource_names or [],
            "languageConstants": language_resource_names or [],
            "biddingStrategy": bidding_strategy,
            "adGroups": [{"keywords": [{"text": k, "matchType": match_type} for k in keywords]}],
        },
    }
    if currency_code:
        body["currencyCode"] = currency_code

    url = f"{BASE_URL}/customers/{customer_id}:generateKeywordForecastMetrics"
    payload = _post_json(url, body)
    m = payload.get("campaignForecastMetrics", {})
    return {
        "clicks": _float_or_none(m.get("clicks")),
        "cost_micros": _int_or_none(m.get("costMicros")),
        "conversions": _float_or_none(m.get("conversions")),
        "average_cpc_micros": _int_or_none(m.get("averageCpcMicros")),
        "average_cpa_micros": _int_or_none(m.get("averageCpaMicros")),
    }


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


# Ritmo de consumo simulado — montos fijos (no se recalculan del gasto real
# simulado de arriba) para poder mostrar, con las mismas 2 cuentas de
# siempre, un caso por arriba del ritmo y uno por debajo. Cualquier otra
# cuenta (no debería ser alcanzable desde el selector en modo simulado)
# cae al caso "sin objetivo definido en Billing".
_SIMULATED_PACING = {
    "1111111111": {"monthly_target": 42000, "spend_mtd_per_day": 1850},   # va por arriba del ritmo
    "2222222222": {"monthly_target": 9000, "spend_mtd_per_day": 220},     # va por debajo del ritmo
}


def simulated_account_pacing(customer_id):
    today = datetime.date.today()
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    preset = _SIMULATED_PACING.get(customer_id)
    if not preset:
        return {
            "spend_mtd": 0, "monthly_target": None,
            "days_elapsed": today.day, "days_in_month": days_in_month,
        }
    return {
        "spend_mtd": round(preset["spend_mtd_per_day"] * today.day, 2),
        "monthly_target": preset["monthly_target"],
        "days_elapsed": today.day,
        "days_in_month": days_in_month,
    }


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


# IA Max simulado — las dos campañas Search del set simulado, una con AI Max
# ya activo y otra sin activar todavía, para poder probar el toggle en
# ambos sentidos sin esperar a Google.
_SIMULATED_AI_MAX_BY_CAMPAIGN_ID = {
    "1111111101": {"campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "enabled": False},
    "1111111102": {"campaign_name": "Estelar Hoteles - CO:es - Search Marca", "enabled": True},
}

SIMULATED_AI_MAX_SERVED = [
    {"campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_name": "Genérico Hoteles Caribe", "search_term": "hotel barato manzanillo cartagena", "match_source": "AI_MAX_BROAD_MATCH", "impressions": 210, "clicks": 14, "cost": 22.4, "conversions": 1},
    {"campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "ad_group_name": "Genérico Hoteles Caribe", "search_term": "manzanillo del mar hospedaje", "match_source": "AI_MAX_KEYWORDLESS", "impressions": 95, "clicks": 6, "cost": 9.1, "conversions": 0},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "ad_group_name": "Marca Estelar", "search_term": "estelar hoteles reservas oficiales", "match_source": "AI_MAX_BROAD_MATCH", "impressions": 340, "clicks": 28, "cost": 19.6, "conversions": 3},
]

SIMULATED_ACCOUNT_NEGATIVE_KEYWORDS = [
    {"campaign_id": "1111111101", "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "text": "manzanillo del mar", "match_type": "EXACT"},
]


def simulated_ai_max_status(only_active=False):
    rows = simulated_campaign_rows(only_active)
    out = []
    for c in rows:
        campaign_id = _SIMULATED_CAMPAIGN_IDS_BY_NAME.get(c["campaign"])
        entry = _SIMULATED_AI_MAX_BY_CAMPAIGN_ID.get(campaign_id)
        if not entry:
            continue  # no es campaña Search en el set simulado
        out.append({
            "campaign_id": campaign_id,
            "campaign_name": c["campaign"],
            "status": c["status"],
            "enabled": entry["enabled"],
            "bundling_required": "NOT_REQUIRED",
        })
    return out


def simulated_update_campaign_ai_max(campaign_id, enable, validate_only=True):
    return {"validate_only": validate_only, "applied": not validate_only, "enabled": bool(enable), "simulated": True}


def simulated_ai_max_served(campaign_id=None):
    if campaign_id:
        return [r for r in SIMULATED_AI_MAX_SERVED if r["campaign_id"] == str(campaign_id)]
    return list(SIMULATED_AI_MAX_SERVED)


def simulated_account_negative_keywords():
    return list(SIMULATED_ACCOUNT_NEGATIVE_KEYWORDS)


# Exclusiones de contenido simuladas — dos categorías de contenido y una de
# apps ya excluidas, para poder probar el flujo de quitar sin esperar a
# Google; y un catálogo chico de categorías de apps para probar el flujo de
# agregar.
_SIMULATED_CONTENT_LABELS_EXCLUDED = ["SEXUALLY_SUGGESTIVE", "PROFANITY"]

SIMULATED_MOBILE_APP_CATEGORIES = [
    {"resource_name": "mobileAppCategoryConstants/70001", "name": "Juegos"},
    {"resource_name": "mobileAppCategoryConstants/70002", "name": "Citas y relaciones"},
    {"resource_name": "mobileAppCategoryConstants/70003", "name": "Redes sociales"},
    {"resource_name": "mobileAppCategoryConstants/70004", "name": "Entretenimiento para adultos"},
    {"resource_name": "mobileAppCategoryConstants/70005", "name": "Finanzas"},
    {"resource_name": "mobileAppCategoryConstants/70006", "name": "Viajes y hoteles"},
]

_SIMULATED_APP_CATEGORIES_EXCLUDED = {"mobileAppCategoryConstants/70004"}


def _simulated_label_resource_name(content_label_type):
    return f"customers/0000000000/customerNegativeCriteria/label-{content_label_type}"


def _simulated_app_resource_name(category_constant):
    return f"customers/0000000000/customerNegativeCriteria/app-{category_constant.rsplit('/', 1)[-1]}"


def simulated_content_exclusions():
    content_labels = [
        {"resource_name": _simulated_label_resource_name(t), "type": t, "label": content_label_type_label(t)}
        for t in _SIMULATED_CONTENT_LABELS_EXCLUDED
    ]
    app_categories = [
        {"resource_name": _simulated_app_resource_name(c["resource_name"]), "category_constant": c["resource_name"], "name": c["name"]}
        for c in SIMULATED_MOBILE_APP_CATEGORIES if c["resource_name"] in _SIMULATED_APP_CATEGORIES_EXCLUDED
    ]
    return {"content_labels": content_labels, "app_categories": app_categories}


def simulated_mobile_app_categories():
    return list(SIMULATED_MOBILE_APP_CATEGORIES)


# Igual que el resto del modo simulado (ver simulated_toggle_ai_max): las
# escrituras (validate_only=False) sí mutan el estado simulado en memoria,
# para que la vista previa/confirmar de acá se sienta igual que contra la
# API real al volver a traer la lista — si no, "confirmar" no cambiaría nada
# visible y parecería que no funcionó.
def simulated_add_content_label_exclusions(content_label_types, validate_only=True):
    types = content_label_types or []
    if not validate_only:
        for t in types:
            if t not in _SIMULATED_CONTENT_LABELS_EXCLUDED:
                _SIMULATED_CONTENT_LABELS_EXCLUDED.append(t)
    return {"created": len(types), "failed": [], "validate_only": validate_only, "simulated": True}


def simulated_add_app_category_exclusions(category_resource_names, validate_only=True):
    names = category_resource_names or []
    if not validate_only:
        for r in names:
            _SIMULATED_APP_CATEGORIES_EXCLUDED.add(r)
    return {"created": len(names), "failed": [], "validate_only": validate_only, "simulated": True}


def simulated_remove_customer_negative_criterion(resource_name, validate_only=True):
    if not validate_only:
        suffix = resource_name.rsplit('/', 1)[-1]
        if suffix.startswith("label-"):
            label_type = suffix[len("label-"):]
            if label_type in _SIMULATED_CONTENT_LABELS_EXCLUDED:
                _SIMULATED_CONTENT_LABELS_EXCLUDED.remove(label_type)
        elif suffix.startswith("app-"):
            app_id = suffix[len("app-"):]
            _SIMULATED_APP_CATEGORIES_EXCLUDED.discard(f"mobileAppCategoryConstants/{app_id}")
    return {"validate_only": validate_only, "applied": not validate_only, "simulated": True}


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


def simulated_optimization_score():
    return {"score": 0.68, "score_weight": 412.5}


SIMULATED_RECOMMENDATIONS = [
    {"resource_name": "sim-rec-1", "type": "CAMPAIGN_BUDGET", "type_label": _recommendation_type_label("CAMPAIGN_BUDGET"), "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "base_cost": 14640.0, "base_conversions": 98.0, "potential_cost": 18900.0, "potential_conversions": 132.0, "potential_impressions": None, "potential_clicks": None},
    {"resource_name": "sim-rec-2", "type": "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH", "type_label": _recommendation_type_label("RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH"), "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "base_cost": None, "base_conversions": None, "potential_cost": None, "potential_conversions": None, "potential_impressions": None, "potential_clicks": None},
    {"resource_name": "sim-rec-3", "type": "KEYWORD", "type_label": _recommendation_type_label("KEYWORD"), "campaign_name": "Estelar Hoteles - CO:es - Search Genérica", "base_cost": None, "base_conversions": None, "potential_cost": 1200.0, "potential_conversions": 9.0, "potential_impressions": 8400.0, "potential_clicks": 310.0},
    {"resource_name": "sim-rec-4", "type": "MOVE_UNUSED_BUDGET", "type_label": _recommendation_type_label("MOVE_UNUSED_BUDGET"), "campaign_name": None, "base_cost": None, "base_conversions": None, "potential_cost": None, "potential_conversions": 5.0, "potential_impressions": None, "potential_clicks": None},
    {"resource_name": "sim-rec-5", "type": "CALLOUT_ASSET", "type_label": _recommendation_type_label("CALLOUT_ASSET"), "campaign_name": None, "base_cost": None, "base_conversions": None, "potential_cost": None, "potential_conversions": None, "potential_impressions": None, "potential_clicks": None},
    {"resource_name": "sim-rec-6", "type": "SEARCH_PARTNERS_OPT_IN", "type_label": _recommendation_type_label("SEARCH_PARTNERS_OPT_IN"), "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "base_cost": 8520.0, "base_conversions": 305.0, "potential_cost": 8520.0, "potential_conversions": 305.0, "potential_impressions": 6200.0, "potential_clicks": 890.0},
]


def simulated_recommendations():
    return SIMULATED_RECOMMENDATIONS


def simulated_apply_recommendation(resource_name):
    return {"applied": True, "simulated": True}


def simulated_dismiss_recommendation(resource_name):
    return {"dismissed": True, "simulated": True}


# Planificador de palabras clave simulado — geos y keywords típicas de la
# industria de hoteles/viajes de las cuentas simuladas de arriba.
SIMULATED_GEO_TARGETS = [
    {"resource_name": "geoTargetConstants/2170", "name": "Colombia", "country_code": "CO", "canonical_name": "Colombia"},
    {"resource_name": "geoTargetConstants/1005224", "name": "Bogotá", "country_code": "CO", "canonical_name": "Bogotá,Bogota,Colombia"},
    {"resource_name": "geoTargetConstants/1005265", "name": "Medellín", "country_code": "CO", "canonical_name": "Medellín,Antioquia,Colombia"},
    {"resource_name": "geoTargetConstants/2484", "name": "México", "country_code": "MX", "canonical_name": "Mexico"},
    {"resource_name": "geoTargetConstants/2724", "name": "España", "country_code": "ES", "canonical_name": "Spain"},
]

SIMULATED_LANGUAGES = [
    {"resource_name": "languageConstants/1003", "code": "es", "name": "Spanish"},
    {"resource_name": "languageConstants/1000", "code": "en", "name": "English"},
    {"resource_name": "languageConstants/1014", "code": "pt", "name": "Portuguese"},
]

_SIMULATED_KEYWORD_CATALOG = [
    {"text": "hotel en cartagena", "avg_monthly_searches": 40500, "competition": "HIGH", "competition_index": 82, "low_top_of_page_bid_micros": 850_000, "high_top_of_page_bid_micros": 2_400_000},
    {"text": "hoteles todo incluido cartagena", "avg_monthly_searches": 8100, "competition": "HIGH", "competition_index": 76, "low_top_of_page_bid_micros": 900_000, "high_top_of_page_bid_micros": 2_600_000},
    {"text": "hotel boutique bogota", "avg_monthly_searches": 2900, "competition": "MEDIUM", "competition_index": 54, "low_top_of_page_bid_micros": 600_000, "high_top_of_page_bid_micros": 1_800_000},
    {"text": "reserva de hotel online", "avg_monthly_searches": 5400, "competition": "MEDIUM", "competition_index": 48, "low_top_of_page_bid_micros": 500_000, "high_top_of_page_bid_micros": 1_500_000},
    {"text": "mejores hoteles playa colombia", "avg_monthly_searches": 1600, "competition": "LOW", "competition_index": 29, "low_top_of_page_bid_micros": 400_000, "high_top_of_page_bid_micros": 1_100_000},
    {"text": "paquetes hotel mas vuelo", "avg_monthly_searches": 3600, "competition": "MEDIUM", "competition_index": 51, "low_top_of_page_bid_micros": 550_000, "high_top_of_page_bid_micros": 1_650_000},
]


def _simulated_monthly_volumes(base):
    months = [("2025", "OCTOBER"), ("2025", "NOVEMBER"), ("2025", "DECEMBER"),
              ("2026", "JANUARY"), ("2026", "FEBRUARY"), ("2026", "MARCH")]
    return [
        {"year": int(y), "month": m, "monthly_searches": int(base * (0.85 + 0.05 * i))}
        for i, (y, m) in enumerate(months)
    ]


def simulated_geo_target_suggestions(query_text):
    q = (query_text or "").strip().lower()
    if not q:
        return []
    return [g for g in SIMULATED_GEO_TARGETS if q in g["name"].lower()]


def simulated_targetable_languages():
    return list(SIMULATED_LANGUAGES)


def simulated_keyword_ideas(seed_keywords=None, seed_url=None):
    rows = [{**k, "monthly_search_volumes": _simulated_monthly_volumes(k["avg_monthly_searches"])} for k in _SIMULATED_KEYWORD_CATALOG]
    return {"rows": rows, "total_size": len(rows)}


def simulated_keyword_historical_metrics(keywords):
    catalog_by_text = {k["text"]: k for k in _SIMULATED_KEYWORD_CATALOG}
    rows = []
    for kw in keywords or []:
        base = catalog_by_text.get(kw.lower())
        if base:
            rows.append({**base, "monthly_search_volumes": _simulated_monthly_volumes(base["avg_monthly_searches"])})
        else:
            fake_base = 200 + (abs(hash(kw)) % 3000)
            rows.append({
                "text": kw, "avg_monthly_searches": fake_base, "competition": "MEDIUM",
                "competition_index": 40, "low_top_of_page_bid_micros": 400_000,
                "high_top_of_page_bid_micros": 1_200_000,
                "monthly_search_volumes": _simulated_monthly_volumes(fake_base),
            })
    return {"rows": rows}


def simulated_keyword_forecast(keywords, bidding_mode, start_date, end_date,
                                daily_budget=None, max_cpc_bid=None, daily_target_spend=None,
                                max_cpc_bid_ceiling=None):
    from datetime import date
    try:
        days = max(1, (date.fromisoformat(end_date) - date.fromisoformat(start_date)).days + 1)
    except (ValueError, TypeError):
        days = 30
    avg_cpc_units = 1.1
    if bidding_mode == "MANUAL_CPC":
        daily_spend = min(float(daily_budget or 0) or float(max_cpc_bid or avg_cpc_units) * 20, float(max_cpc_bid or avg_cpc_units) * 40)
        avg_cpc_units = float(max_cpc_bid or avg_cpc_units) * 0.8
    else:
        daily_spend = float(daily_target_spend or 0)
        if bidding_mode == "MAXIMIZE_CLICKS" and max_cpc_bid_ceiling:
            avg_cpc_units = min(avg_cpc_units, float(max_cpc_bid_ceiling) * 0.8)
    total_cost = daily_spend * days
    clicks = round(total_cost / avg_cpc_units, 1) if avg_cpc_units else 0
    conversions = round(clicks * 0.045, 1)
    # Igual que la API real (confirmado contra una cuenta real): con
    # "Maximizar conversiones" Google no estima clics/CPC, y con CPC manual/
    # maximizar clics no estima conversiones/CPA — nunca trae las 4 a la vez.
    if bidding_mode == "MAXIMIZE_CONVERSIONS":
        return {
            "clicks": None, "cost_micros": int(round(total_cost * MICROS)),
            "conversions": conversions, "average_cpc_micros": None,
            "average_cpa_micros": int(round((total_cost / conversions) * MICROS)) if conversions else None,
        }
    return {
        "clicks": clicks, "cost_micros": int(round(total_cost * MICROS)),
        "conversions": None, "average_cpc_micros": int(round(avg_cpc_units * MICROS)) if clicks else None,
        "average_cpa_micros": None,
    }
