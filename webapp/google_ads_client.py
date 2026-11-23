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
import base64
import json
import struct
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request

API_VERSION = "v26"
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


_CURRENCY_CACHE = {}


def fetch_customer_currency(customer_id):
    """Moneda de la cuenta (código ISO, p. ej. EUR o COP), en caché. Devuelve "" si no se pudo leer: un total
    combinado de varias cuentas solo es válido si comparten moneda."""
    customer_id = str(customer_id)
    if customer_id in _CURRENCY_CACHE:
        return _CURRENCY_CACHE[customer_id]
    try:
        rows = _search(customer_id, "SELECT customer.currency_code FROM customer LIMIT 1")
    except RuntimeError:
        return ""
    currency = (rows[0].get("customer", {}).get("currencyCode") if rows else "") or ""
    _CURRENCY_CACHE[customer_id] = currency
    return currency


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


def fetch_account_pacing(customer_id, month_from=None, month_to=None):
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
    cur = (today.year, today.month)
    if month_from is not None and not (month_from == cur and month_to == cur):
        return _fetch_pacing_range(customer_id, month_from, month_to, today)

    month_start = today.replace(day=1)
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    end_of_today = f"{today.isoformat()} 23:59:59"

    campaign_rows = fetch_campaign_rows(customer_id, month_start.isoformat(), today.isoformat())
    spend_mtd = sum((r.get("cost") or 0) for r in campaign_rows)

    monthly_target = _account_budget_target(_account_budget_rows(customer_id, end_of_today, None), end_of_today)

    return {
        "spend_mtd": spend_mtd,
        "monthly_target": monthly_target,
        "days_elapsed": today.day,
        "days_in_month": days_in_month,
        "is_complete": False,
    }


def _month_iter(first, last):
    y, m = first
    while (y, m) <= last:
        yield (y, m)
        m += 1
        if m == 13:
            y, m = y + 1, 1


def _account_budget_rows(customer_id, ref_end, ref_start):
    """account_budget APPROVED que se solapan con el periodo: empiezan antes
    de ref_end y terminan después de ref_start (si ref_start es None, después
    de ref_end — o sea, el vigente en ese instante). Un presupuesto sin fecha
    de fin (INFINITE) también pasa el filtro de fin."""
    end_floor = ref_start or ref_end
    query = f"""
        SELECT account_budget.adjusted_spending_limit_micros,
               account_budget.adjusted_spending_limit_type,
               account_budget.approved_start_date_time,
               account_budget.approved_end_date_time
        FROM account_budget
        WHERE account_budget.status = 'APPROVED'
          AND account_budget.approved_start_date_time <= '{ref_end}'
          AND account_budget.approved_end_date_time > '{end_floor}'
    """
    return _search(customer_id, query)


def _account_budget_target(budget_rows, ref):
    """Objetivo (en unidades de cuenta) del presupuesto que cubre el instante
    `ref` ("YYYY-MM-DD HH:MM:SS"), o None si no hay uno con límite definido."""
    for r in budget_rows:
        ab = r.get("accountBudget", {})
        start = ab.get("approvedStartDateTime") or ""
        end = ab.get("approvedEndDateTime")
        if start > ref or (end is not None and end <= ref):
            continue
        if ab.get("adjustedSpendingLimitType") == "INFINITE":
            continue
        target = _micros_to_units(_int_or_none(ab.get("adjustedSpendingLimitMicros")))
        if target:
            return target
    return None


def aggregate_pacing_months(months, spend_by_month, target_by_month, today):
    """Suma un periodo de varios meses. Solo los meses CON objetivo entran a
    la comparación (objetivo y gasto), para que el % no se infle por meses de
    pago automático sin límite; el gasto total del periodo se devuelve aparte.
    El mes en curso, si está en el rango, cuenta su objetivo completo pero su
    esperado se prorratea hasta ayer, igual que la tabla de un solo mes."""
    cur = (today.year, today.month)
    total_spend = sum(spend_by_month.get(f"{y}-{m:02d}", 0) for y, m in months)
    target_total = expected_total = spend_cmp = 0
    with_target = 0
    for y, m in months:
        target = target_by_month.get((y, m))
        if not target:
            continue
        dim = calendar.monthrange(y, m)[1]
        with_target += 1
        target_total += target
        spend_cmp += spend_by_month.get(f"{y}-{m:02d}", 0)
        if (y, m) == cur:
            expected_total += target * max(today.day - 1, 0) / dim
        else:
            expected_total += target
    last_y, last_m = months[-1]
    includes_current = months[-1] == cur
    return {
        "spend_mtd": spend_cmp if with_target else total_spend,
        "spend_total": total_spend,
        "monthly_target": target_total if with_target else None,
        "expected_total": expected_total if with_target else None,
        "months_total": len(months),
        "months_with_target": with_target,
        "days_elapsed": today.day if includes_current else calendar.monthrange(last_y, last_m)[1],
        "days_in_month": calendar.monthrange(last_y, last_m)[1],
        "is_complete": not includes_current,
    }


def _fetch_pacing_range(customer_id, month_from, month_to, today):
    months = list(_month_iter(month_from, month_to))
    range_start = datetime.date(month_from[0], month_from[1], 1)
    last_day = datetime.date(month_to[0], month_to[1], calendar.monthrange(*month_to)[1])
    range_end = min(last_day, today)

    # Gasto mes por mes con los mismos criterios que fetch_campaign_rows
    # (campañas no eliminadas), para que un mes dé lo mismo en la vista de
    # un mes y en la de un rango.
    cost_query = f"""
        SELECT segments.month, metrics.cost_micros
        FROM campaign
        WHERE segments.date BETWEEN '{range_start.isoformat()}' AND '{range_end.isoformat()}'
          AND campaign.status != 'REMOVED'
    """
    spend_by_month = {}
    for r in _search(customer_id, cost_query):
        key = (r.get("segments", {}).get("month") or "")[:7]
        cost = _micros_to_units(_int_or_none(r.get("metrics", {}).get("costMicros"))) or 0
        spend_by_month[key] = spend_by_month.get(key, 0) + cost

    budget_rows = _account_budget_rows(
        customer_id, f"{last_day.isoformat()} 23:59:59", f"{range_start.isoformat()} 00:00:00"
    )
    target_by_month = {}
    for y, m in months:
        ref = f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d} 23:59:59"
        target_by_month[(y, m)] = _account_budget_target(budget_rows, ref)
    return aggregate_pacing_months(months, spend_by_month, target_by_month, today)


def _is_ended_experiment(campaign):
    """Campaña de experimento que ya terminó (Google la deja ENABLED pero con serving_status ENDED).
    No es una campaña real de la cuenta: comparte presupuesto con la original y mete ruido en las listas."""
    return campaign.get("experimentType") == "EXPERIMENT" and campaign.get("servingStatus") == "ENDED"


def fetch_account_campaigns_budget(customer_id):
    """Campañas ACTIVAS de la cuenta con sus KPIs principales del mes en
    curso y su presupuesto diario — para poder ajustarlo directo desde
    Ritmo de consumo sin saltar a Rendimiento. A diferencia de
    fetch_campaign_rows (que trae también Impression Share en una segunda
    consulta aparte), acá solo lo necesario para esta vista, más liviano.

    campaign_budget.explicitly_shared: una campaña puede usar un
    presupuesto COMPARTIDO con otras — ajustarlo de acá afectaría a todas
    las que lo comparten sin que quede claro cuáles son, así que esas
    quedan marcadas is_shared=True para que la interfaz las deje en solo
    lectura (mismo criterio que is_portfolio en ROAS).

    OJO: explicitly_shared NO alcanza para detectar todos los casos reales
    — confirmado contra una cuenta real, dos campañas (una de ellas
    claramente una de prueba sin gasto) apuntaban al MISMO
    campaign_budget.resource_name con explicitly_shared=False en ambas
    (un presupuesto se puede reutilizar entre campañas sin pasar por el
    flujo de "presupuesto compartido" de la UI, y ese flag no lo refleja).
    Por eso acá se cuenta cuántas campañas activas usan cada
    resource_name y se marca is_shared=True también cuando aparece más de
    una vez, sin depender solo del flag de Google."""
    today = datetime.date.today()
    month_start = today.replace(day=1)
    base_select = """
        SELECT campaign.id, campaign.name, campaign.bidding_strategy_type,
               campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas,
               campaign_budget.resource_name, campaign_budget.amount_micros,
               campaign_budget.explicitly_shared,
               metrics.impressions, metrics.clicks, metrics.ctr,
               metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion"""
    where = f"""
        FROM campaign
        WHERE campaign.status = 'ENABLED'
          AND segments.date BETWEEN '{month_start.isoformat()}' AND '{today.isoformat()}'
    """
    # Los experimentos que ya terminaron (campaña de tipo EXPERIMENT con serving_status ENDED)
    # no son campañas reales de la cuenta: se dejan fuera. Si Google rechazara esos dos campos,
    # se vuelve a la consulta de siempre para no tumbar la ventana.
    try:
        results = _search(customer_id, base_select + ",\n               campaign.experiment_type, campaign.serving_status" + where)
    except Exception as e:  # noqa: BLE001
        print(f"[pacing-campaigns] sin filtro de experimentos terminados ({customer_id}): {' '.join(str(e).split())[:200]}", flush=True)
        results = _search(customer_id, base_select + where)
    rows = []
    for r in results:
        campaign = r.get("campaign", {})
        if _is_ended_experiment(campaign):
            continue
        budget = r.get("campaignBudget", {})
        metrics = r.get("metrics", {})
        target_roas = campaign.get("targetRoas", {}).get("targetRoas")
        if target_roas is None:
            target_roas = campaign.get("maximizeConversionValue", {}).get("targetRoas")
        rows.append({
            "campaign_id": str(campaign.get("id")),
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "bidding_strategy_type": campaign.get("biddingStrategyType") or "UNSPECIFIED",
            "target_roas": _float_or_none(target_roas),
            "budget_resource_name": budget.get("resourceName"),
            "daily_budget": _micros_to_units(_int_or_none(budget.get("amountMicros"))),
            "is_shared": bool(budget.get("explicitlyShared")),
            "impressions": _int_or_none(metrics.get("impressions")),
            "clicks": _int_or_none(metrics.get("clicks")),
            "ctr": _float_or_none(metrics.get("ctr")),
            "cost": _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0,
            "conversions": _float_or_none(metrics.get("conversions")),
            "conv_value": _float_or_none(metrics.get("conversionsValue")) or 0,
            "cost_per_conv": _micros_to_units(_float_or_none(metrics.get("costPerConversion"))),
        })
    budget_counts = Counter(r["budget_resource_name"] for r in rows)
    for r in rows:
        if budget_counts[r["budget_resource_name"]] > 1:
            r["is_shared"] = True
    rows.sort(key=lambda r: r["cost"], reverse=True)
    return rows


def update_campaign_daily_budget(customer_id, budget_resource_name, new_daily_budget, validate_only=True):
    """Ajusta el presupuesto DIARIO de una campaña (campaign_budget, no
    campaign — son recursos separados en la API). new_daily_budget en
    unidades de cuenta (no micros). Mismo patrón que
    update_campaign_target_roas: validate_only=True es solo vista previa,
    False escribe de verdad."""
    if not new_daily_budget or new_daily_budget <= 0:
        raise ValueError("El presupuesto diario debe ser un número mayor que cero.")
    if not budget_resource_name or f"/customers/{customer_id}/" not in f"/{budget_resource_name}":
        raise ValueError("El presupuesto no corresponde a esta cuenta.")

    url = f"{BASE_URL}/customers/{customer_id}/campaignBudgets:mutate"
    body = {
        "operations": [{
            "update": {
                "resourceName": budget_resource_name,
                "amountMicros": str(_units_to_micros(new_daily_budget)),
            },
            "updateMask": "amount_micros",
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

    return {"validate_only": validate_only, "applied": not validate_only, "new_daily_budget": new_daily_budget}


BUDGET_MAX_CHANGE = 0.30  # el ajuste de presupuesto desde Campañas no mueve más del 30 % por vez


def fetch_campaign_budget(customer_id, campaign_id):
    """Presupuesto diario ACTUAL de una campaña, leído de Google en este momento: recurso, monto y si lo usan otras campañas."""
    if not str(campaign_id).isdigit():
        raise ValueError("campaign_id inválido.")
    query = f"""
        SELECT
          campaign.id,
          campaign.name,
          campaign_budget.resource_name,
          campaign_budget.amount_micros,
          campaign_budget.explicitly_shared,
          campaign_budget.reference_count
        FROM campaign
        WHERE campaign.id = {int(campaign_id)}
    """
    results = _search(customer_id, query)
    if not results:
        raise ValueError("No se encontró la campaña en esta cuenta.")
    r = results[0]
    b = r.get("campaignBudget", {})
    return {
        "campaign_name": r.get("campaign", {}).get("name") or "",
        "budget_resource_name": b.get("resourceName"),
        "amount": _micros_to_units(_int_or_none(b.get("amountMicros"))),
        "shared": bool(b.get("explicitlyShared")) or (_int_or_none(b.get("referenceCount")) or 1) > 1,
    }


def check_budget_change(current, new_budget, expected_current=None, shared=False):
    """Reglas de seguridad del ajuste: presupuesto propio de la campaña, mayor que cero, cambio de hasta ±30 % y sin que haya
    cambiado desde que se calculó la propuesta. Lanza ValueError con el motivo."""
    if shared:
        raise ValueError("Esta campaña usa un presupuesto compartido con otras campañas: cambiarlo afectaría a todas. Ajústalo desde Google Ads.")
    if not current or current <= 0:
        raise ValueError("No se pudo leer el presupuesto actual de la campaña.")
    if not new_budget or new_budget <= 0:
        raise ValueError("El presupuesto diario debe ser un número mayor que cero.")
    if expected_current is not None and abs(current - expected_current) > max(0.01, current * 0.005):
        raise ValueError(f"El presupuesto de la campaña cambió mientras tanto (ahora es {current:.2f}). Vuelve a calcular la propuesta.")
    change = new_budget / current - 1
    if abs(change) > BUDGET_MAX_CHANGE + 1e-9:
        raise ValueError(f"El cambio es de {change * 100:+.0f} %. Desde aquí el máximo es ±{BUDGET_MAX_CHANGE * 100:.0f} % por vez; si hace falta más, hazlo en dos pasos.")
    return change


def adjust_campaign_budget(customer_id, campaign_id, new_budget, validate_only=True, expected_current=None):
    """Cambia el presupuesto diario de UNA campaña desde Campañas > Dónde invertir. Relee el presupuesto en Google, comprueba las
    reglas de seguridad y delega la escritura en update_campaign_daily_budget (que con validate_only=True solo hace la vista previa)."""
    cur = fetch_campaign_budget(customer_id, campaign_id)
    change = check_budget_change(cur["amount"], new_budget, expected_current, cur["shared"])
    result = update_campaign_daily_budget(customer_id, cur["budget_resource_name"], new_budget, validate_only)
    result.update({"old_daily_budget": cur["amount"], "change_pct": round(change * 100, 1), "campaign_name": cur["campaign_name"],
                   "budget_resource_name": cur["budget_resource_name"]})
    return result


def simulated_adjust_campaign_budget(campaign_id, new_budget, validate_only=True, expected_current=None):
    row = next((c for c in simulated_campaigns_overview() if str(c["campaign_id"]) == str(campaign_id)), None)
    if not row:
        raise ValueError("No se encontró la campaña en esta cuenta.")
    change = check_budget_change(row["budget"], new_budget, expected_current, row.get("budget_shared", False))
    return {"validate_only": validate_only, "applied": not validate_only, "new_daily_budget": new_budget, "old_daily_budget": row["budget"],
            "change_pct": round(change * 100, 1), "campaign_name": row["campaign_name"], "simulated": True}


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


def fetch_pmax_search_terms(customer_id, date_from, date_to, limit=15000):
    """Términos de búsqueda REALES de campañas Performance Max, con costo, de
    campaign_search_term_view. Confirmado contra una cuenta real (2026-11-05,
    Estelar Alto Prado: 675 términos en 30 días): esta vista sí trae el texto
    exacto de la búsqueda e impresiones, clics, costo y conversiones — a
    diferencia de campaign_search_term_insight (fetch_pmax_search_term_insights),
    que solo agrupa en categorías y no trae costo. Su campo `status` no existe.
    Se queda con los de más gasto (limit) para no devolver cientos de miles de
    filas en cuentas con muchas campañas."""
    query = f"""
        SELECT
          campaign_search_term_view.search_term,
          campaign.id,
          campaign.name,
          metrics.clicks,
          metrics.impressions,
          metrics.cost_micros,
          metrics.conversions
        FROM campaign_search_term_view
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
        ORDER BY metrics.cost_micros DESC
        LIMIT {int(limit)}
    """
    rows = []
    for r in _search(customer_id, query):
        view = r.get("campaignSearchTermView", {})
        campaign = r.get("campaign", {})
        metrics = r.get("metrics", {})
        term = view.get("searchTerm") or ""
        if not term:
            continue
        rows.append({
            "term": term,
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "ad_group_id": None, "ad_group_name": None,
            "clicks": _int_or_none(metrics.get("clicks")) or 0,
            "impr": _int_or_none(metrics.get("impressions")) or 0,
            "cost": _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0,
            "conversions": _float_or_none(metrics.get("conversions")) or 0,
            "is_category": False, "pmax": True,
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


def fetch_campaigns_overview(customer_id, date_from, date_to):
    """Todas las campañas de la cuenta (activas y pausadas, no las eliminadas) con sus métricas del rango, para
    la sección Campañas. Son dos consultas a propósito: la lista sale de `campaign` sin fechas, para que una
    campaña pausada o sin impresiones en el rango aparezca igual (si no, no se podría volver a activar), y las
    métricas se cruzan por id."""
    list_query = """
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type,
          campaign.target_roas.target_roas,
          campaign.maximize_conversion_value.target_roas,
          campaign.target_cpa.target_cpa_micros,
          campaign.maximize_conversions.target_cpa_micros,
          campaign_budget.amount_micros,
          campaign_budget.resource_name,
          campaign_budget.explicitly_shared
        FROM campaign
        WHERE campaign.status != 'REMOVED'
    """
    # Con los dos campos extra se dejan fuera los experimentos terminados; si Google los rechazara, se
    # vuelve a la consulta de siempre para no tumbar la sección.
    list_query_exp = list_query.replace("campaign_budget.explicitly_shared", "campaign_budget.explicitly_shared,\n          campaign.experiment_type,\n          campaign.serving_status")
    metrics_query = f"""
        SELECT
          campaign.id,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND campaign.status != 'REMOVED'
    """
    # Impression Share va en su propia consulta: pedirlo junto al resto de métricas hace que Google devuelva solo
    # campañas Search (mismo motivo que en fetch_campaign_rows). Solo existe para Search; las demás quedan en None.
    share_query = f"""
        SELECT
          campaign.id,
          metrics.search_impression_share,
          metrics.search_top_impression_share,
          metrics.search_budget_lost_impression_share,
          metrics.search_rank_lost_impression_share
        FROM campaign
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND campaign.status != 'REMOVED'
    """
    share_by_id = {}
    for r in _search(customer_id, share_query):
        m = r.get("metrics", {})
        share_by_id[str(r.get("campaign", {}).get("id"))] = {
            "impr_share": _float_or_none(m.get("searchImpressionShare")),
            "top_impr_share": _float_or_none(m.get("searchTopImpressionShare")),
            "lost_is_budget": _float_or_none(m.get("searchBudgetLostImpressionShare")),
            "lost_is_rank": _float_or_none(m.get("searchRankLostImpressionShare")),
        }
    no_share = {"impr_share": None, "top_impr_share": None, "lost_is_budget": None, "lost_is_rank": None}
    metrics_by_id = {}
    for r in _search(customer_id, metrics_query):
        m = r.get("metrics", {})
        metrics_by_id[str(r.get("campaign", {}).get("id"))] = {
            "impressions": _int_or_none(m.get("impressions")) or 0,
            "clicks": _int_or_none(m.get("clicks")) or 0,
            "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
            "conversions": _float_or_none(m.get("conversions")) or 0.0,
            "conv_value": _float_or_none(m.get("conversionsValue")) or 0.0,
        }
    empty = {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0}
    out = []
    try:
        list_results = _search(customer_id, list_query_exp)
    except Exception as e:  # noqa: BLE001
        print(f"[campanas] sin filtro de experimentos terminados ({customer_id}): {' '.join(str(e).split())[:200]}", flush=True)
        list_results = _search(customer_id, list_query)
    for r in list_results:
        c = r.get("campaign", {})
        if _is_ended_experiment(c):
            continue
        cid = str(c.get("id"))
        target_roas = c.get("targetRoas", {}).get("targetRoas")
        if target_roas is None:
            target_roas = c.get("maximizeConversionValue", {}).get("targetRoas")
        target_cpa = c.get("targetCpa", {}).get("targetCpaMicros")
        if target_cpa is None:
            target_cpa = c.get("maximizeConversions", {}).get("targetCpaMicros")
        row = {
            "campaign_id": cid,
            "campaign_name": c.get("name") or "(sin nombre)",
            "status": c.get("status"),
            "channel_type": c.get("advertisingChannelType") or "",
            "bidding_strategy_type": c.get("biddingStrategyType") or "",
            "target_roas": _float_or_none(target_roas),
            "target_cpa": _micros_to_units(_int_or_none(target_cpa)),
            "budget": _micros_to_units(_int_or_none(r.get("campaignBudget", {}).get("amountMicros"))),
            "budget_resource_name": r.get("campaignBudget", {}).get("resourceName"),
            "budget_shared": bool(r.get("campaignBudget", {}).get("explicitlyShared")),
        }
        row.update(metrics_by_id.get(cid, empty))
        row.update(share_by_id.get(cid, no_share))
        out.append(row)
    # Un presupuesto que usan varias campañas (aunque Google no lo marque como compartido) se trata como compartido.
    counts = Counter(r["budget_resource_name"] for r in out if r["budget_resource_name"])
    for r in out:
        if r["budget_resource_name"] and counts[r["budget_resource_name"]] > 1:
            r["budget_shared"] = True
    return out


def fetch_campaign_daily(customer_id, campaign_id, date_from, date_to):
    """Serie día a día de una campaña, para las gráficas del detalle en Campañas. Dos consultas: las métricas
    normales y las cuotas de impresiones, que van aparte porque pedirlas juntas deja fuera lo que no es Search
    (mismo motivo que en fetch_campaign_rows). Los días sin datos no vienen de Google: el cliente los rellena."""
    campaign_id = int(campaign_id)
    metrics_query = f"""
        SELECT
          segments.date,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = {campaign_id}
          AND segments.date BETWEEN '{date_from}' AND '{date_to}'
        ORDER BY segments.date
    """
    share_query = f"""
        SELECT
          segments.date,
          metrics.search_impression_share,
          metrics.search_top_impression_share,
          metrics.search_budget_lost_impression_share,
          metrics.search_rank_lost_impression_share
        FROM campaign
        WHERE campaign.id = {campaign_id}
          AND segments.date BETWEEN '{date_from}' AND '{date_to}'
        ORDER BY segments.date
    """
    days = {}
    for r in _search(customer_id, metrics_query):
        date = r.get("segments", {}).get("date")
        if not date:
            continue
        m = r.get("metrics", {})
        days[date] = {
            "date": date,
            "impressions": _int_or_none(m.get("impressions")) or 0,
            "clicks": _int_or_none(m.get("clicks")) or 0,
            "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
            "conversions": _float_or_none(m.get("conversions")) or 0.0,
            "conv_value": _float_or_none(m.get("conversionsValue")) or 0.0,
            "budget": _micros_to_units(_int_or_none(r.get("campaignBudget", {}).get("amountMicros"))),
        }
    try:
        share_rows = _search(customer_id, share_query)
    except RuntimeError:
        # Sin cuotas el resto de las gráficas sirve igual: el detalle no debe caerse por esto.
        share_rows = []
    for r in share_rows:
        date = r.get("segments", {}).get("date")
        if not date:
            continue
        m = r.get("metrics", {})
        day = days.setdefault(date, {"date": date, "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0, "budget": None})
        day["impr_share"] = _float_or_none(m.get("searchImpressionShare"))
        day["top_impr_share"] = _float_or_none(m.get("searchTopImpressionShare"))
        day["lost_is_budget"] = _float_or_none(m.get("searchBudgetLostImpressionShare"))
        day["lost_is_rank"] = _float_or_none(m.get("searchRankLostImpressionShare"))
    out = []
    for date in sorted(days):
        d = days[date]
        for k in ("impr_share", "top_impr_share", "lost_is_budget", "lost_is_rank"):
            d.setdefault(k, None)
        out.append(d)
    return out


_PROXIMITY_UNITS_ES = {"KILOMETERS": "km", "MILES": "mi"}


def _in_list(values):
    return ", ".join("'" + str(v).replace("'", "") + "'" for v in values)


def _metrics_block(m):
    return {
        "impressions": _int_or_none(m.get("impressions")) or 0,
        "clicks": _int_or_none(m.get("clicks")) or 0,
        "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
        "conversions": _float_or_none(m.get("conversions")) or 0.0,
        "conv_value": _float_or_none(m.get("conversionsValue")) or 0.0,
    }


_EMPTY_METRICS = {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0}
_METRIC_FIELDS = """
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value"""


def fetch_campaign_groups(customer_id, campaign_id, channel_type, date_from, date_to):
    """Grupos activos de la campaña con sus KPIs del rango: grupos de anuncios, o grupos de recursos si es
    Performance Max (que no tiene grupos de anuncios). La lista sale sin fechas y las métricas se cruzan por id,
    para que un grupo activo sin impresiones en el rango aparezca igual."""
    campaign_id = int(campaign_id)
    if channel_type == "PERFORMANCE_MAX":
        kind, table, prefix = "asset_group", "asset_group", "asset_group"
        list_fields = "asset_group.id, asset_group.name, asset_group.status"
    else:
        kind, table, prefix = "ad_group", "ad_group", "ad_group"
        list_fields = "ad_group.id, ad_group.name, ad_group.status, ad_group.type"
    list_query = f"""
        SELECT {list_fields}
        FROM {table}
        WHERE campaign.id = {campaign_id} AND {prefix}.status = 'ENABLED'
    """
    metrics_query = f"""
        SELECT {prefix}.id,{_METRIC_FIELDS}
        FROM {table}
        WHERE campaign.id = {campaign_id} AND {prefix}.status = 'ENABLED'
          AND segments.date BETWEEN '{date_from}' AND '{date_to}'
    """
    metrics_by_id = {}
    for r in _search(customer_id, metrics_query):
        metrics_by_id[str(r.get(_camel(prefix), {}).get("id"))] = _metrics_block(r.get("metrics", {}))
    groups = []
    for r in _search(customer_id, list_query):
        g = r.get(_camel(prefix), {})
        gid = str(g.get("id"))
        row = {"id": gid, "name": g.get("name") or "(sin nombre)", "type": g.get("type") or ""}
        row.update(metrics_by_id.get(gid, _EMPTY_METRICS))
        groups.append(row)
    groups.sort(key=lambda x: -x["cost"])
    return {"kind": kind, "groups": groups}


def _camel(snake):
    head, *rest = snake.split("_")
    return head + "".join(w.capitalize() for w in rest)


def fetch_campaign_location_metrics(customer_id, campaign_id, date_from, date_to):
    """KPIs del rango por ubicación configurada, con el recurso de la ubicación como llave."""
    out = {}
    for r in _search(customer_id, f"""
        SELECT campaign_criterion.location.geo_target_constant,{_METRIC_FIELDS}
        FROM location_view
        WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
    """):
        res = r.get("campaignCriterion", {}).get("location", {}).get("geoTargetConstant")
        if res:
            out[res] = _metrics_block(r.get("metrics", {}))
    return out


def fetch_campaign_targeting(customer_id, campaign_id, date_from, date_to):
    """A dónde se dirige la campaña: ubicaciones (países, regiones, ciudades…, incluidas o excluidas) con sus
    KPIs del rango, radios alrededor de un punto e idiomas. Los nombres salen de geo_target_constant y
    language_constant; los KPIs de location_view, que solo existe para ubicaciones."""
    campaign_id = int(campaign_id)
    crit_query = f"""
        SELECT
          campaign_criterion.type,
          campaign_criterion.negative,
          campaign_criterion.location.geo_target_constant,
          campaign_criterion.language.language_constant,
          campaign_criterion.proximity.radius,
          campaign_criterion.proximity.radius_units,
          campaign_criterion.proximity.address.city_name,
          campaign_criterion.proximity.address.street_address
        FROM campaign_criterion
        WHERE campaign.id = {campaign_id}
          AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LANGUAGE')
    """
    setting_query = f"""
        SELECT campaign.geo_target_type_setting.positive_geo_target_type
        FROM campaign
        WHERE campaign.id = {campaign_id}
    """
    locations, proximities, language_ids = {}, [], []
    for r in _search(customer_id, crit_query):
        crit = r.get("campaignCriterion", {})
        ctype = crit.get("type")
        if ctype == "LOCATION":
            res = crit.get("location", {}).get("geoTargetConstant")
            if res:
                locations[res] = {"resource": res, "excluded": bool(crit.get("negative"))}
        elif ctype == "LANGUAGE":
            res = crit.get("language", {}).get("languageConstant")
            if res:
                language_ids.append(res)
        elif ctype == "PROXIMITY":
            px = crit.get("proximity", {})
            where = (px.get("address", {}) or {})
            place = where.get("cityName") or where.get("streetAddress") or ""
            units = _PROXIMITY_UNITS_ES.get(px.get("radiusUnits"), px.get("radiusUnits") or "")
            try:
                label = f"Radio de {float(px.get('radius')):g} {units}"
            except (TypeError, ValueError):
                label = "Radio"
            proximities.append({"name": label + (f" alrededor de {place}" if place else ""), "excluded": bool(crit.get("negative"))})

    # Nombres de las ubicaciones, en bloques para no pasarse de largo en la consulta.
    res_list = list(locations)
    for i in range(0, len(res_list), 150):
        chunk = res_list[i:i + 150]
        for r in _search(customer_id, f"""
            SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name,
                   geo_target_constant.target_type, geo_target_constant.country_code
            FROM geo_target_constant
            WHERE geo_target_constant.resource_name IN ({_in_list(chunk)})
        """):
            gc = r.get("geoTargetConstant", {})
            loc = locations.get(gc.get("resourceName"))
            if loc is not None:
                loc.update({"name": gc.get("name") or "", "canonical": gc.get("canonicalName") or "",
                            "target_type": gc.get("targetType") or "", "country_code": gc.get("countryCode") or ""})

    # KPIs por ubicación (solo las que Google devuelve con actividad en el rango).
    try:
        for res, m in fetch_campaign_location_metrics(customer_id, campaign_id, date_from, date_to).items():
            if res in locations:
                locations[res]["metrics"] = m
    except RuntimeError:
        pass  # sin KPIs por ubicación, la lista de a dónde se dirige sigue sirviendo

    languages = []
    for i in range(0, len(language_ids), 150):
        chunk = language_ids[i:i + 150]
        for r in _search(customer_id, f"""
            SELECT language_constant.resource_name, language_constant.name, language_constant.code
            FROM language_constant
            WHERE language_constant.resource_name IN ({_in_list(chunk)})
        """):
            languages.append(r.get("languageConstant", {}).get("name") or "")

    geo_type = None
    try:
        rows = _search(customer_id, setting_query)
        if rows:
            geo_type = rows[0].get("campaign", {}).get("geoTargetTypeSetting", {}).get("positiveGeoTargetType")
    except RuntimeError:
        pass

    out_locations = []
    for loc in locations.values():
        m = loc.get("metrics") or _EMPTY_METRICS
        out_locations.append({
            "resource": loc["resource"], "name": loc.get("name") or loc["resource"], "canonical": loc.get("canonical", ""),
            "target_type": loc.get("target_type", ""), "country_code": loc.get("country_code", ""),
            "excluded": loc["excluded"], **m,
        })
    out_locations.sort(key=lambda x: (x["excluded"], -x["cost"], x["name"]))
    return {"locations": out_locations, "radii": proximities, "languages": sorted(l for l in languages if l), "geo_target_type": geo_type}


# ---- Detalle de campaña: contexto (resumen y comparación), segmentos, palabras clave, posición en la subasta ----

_SHARE_FIELDS = {
    "impr_share": "searchImpressionShare", "top_impr_share": "searchTopImpressionShare",
    "lost_is_budget": "searchBudgetLostImpressionShare", "lost_is_rank": "searchRankLostImpressionShare",
}
_POSITION_FIELDS = {
    **_SHARE_FIELDS,
    "abs_top_impr_share": "searchAbsoluteTopImpressionShare",
    "lost_top_budget": "searchBudgetLostTopImpressionShare", "lost_top_rank": "searchRankLostTopImpressionShare",
    "lost_abs_top_budget": "searchBudgetLostAbsoluteTopImpressionShare", "lost_abs_top_rank": "searchRankLostAbsoluteTopImpressionShare",
    "click_share": "searchClickShare", "exact_impr_share": "searchExactMatchImpressionShare",
}


def _campaign_shares(customer_id, campaign_id, date_from, date_to, fields):
    """Cuotas de impresiones del rango para una campaña (todas None si Google no las da para su tipo)."""
    metric_names = ", ".join("metrics." + re.sub(r"(?<!^)(?=[A-Z])", "_", v).lower() for v in fields.values())
    rows = _search(customer_id, f"""
        SELECT campaign.id, {metric_names}
        FROM campaign
        WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
    """)
    m = rows[0].get("metrics", {}) if rows else {}
    return {k: _float_or_none(m.get(v)) for k, v in fields.items()}


def _campaign_period(customer_id, campaign_id, date_from, date_to):
    rows = _search(customer_id, f"""
        SELECT campaign.id,{_METRIC_FIELDS}
        FROM campaign
        WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
    """)
    out = dict(_metrics_block(rows[0].get("metrics", {}))) if rows else dict(_EMPTY_METRICS)
    try:
        out.update(_campaign_shares(customer_id, campaign_id, date_from, date_to, _SHARE_FIELDS))
    except RuntimeError:
        out.update({k: None for k in _SHARE_FIELDS})
    return out


_CHANGE_FIELD_LABELS = {
    "status": ("Estado", "status"),
    "amountMicros": ("Presupuesto diario", "money_micros"),
    "name": ("Nombre", "text"),
    "biddingStrategyType": ("Estrategia de puja", "bid_strategy"),
    "maximizeConversionValue.targetRoas": ("ROAS objetivo", "roas"),
    "targetRoas.targetRoas": ("ROAS objetivo", "roas"),
    "maximizeConversions.targetCpaMicros": ("CPA objetivo", "money_micros"),
    "targetCpa.targetCpaMicros": ("CPA objetivo", "money_micros"),
    "cpcBidMicros": ("Puja máxima de CPC", "money_micros"),
    "targetCpaMicros": ("CPA objetivo", "money_micros"),
    "bidModifier": ("Modificador de puja", "number"),
    "responsiveSearchAd.headlines": ("Titulares del anuncio", "text"),
    "responsiveSearchAd.descriptions": ("Descripciones del anuncio", "text"),
    "finalUrls": ("URL final", "text"),
    "responsiveSearchAd.path1": ("Ruta 1 de la URL", "text"),
    "responsiveSearchAd.path2": ("Ruta 2 de la URL", "text"),
    "startDate": ("Fecha de inicio", "text"),
    "endDate": ("Fecha de fin", "text"),
}
_CHANGE_RESOURCE_LABELS = {
    "CAMPAIGN": "Campaña", "CAMPAIGN_BUDGET": "Presupuesto", "AD_GROUP": "Grupo de anuncios", "AD_GROUP_AD": "Anuncio",
    "AD": "Anuncio", "AD_GROUP_CRITERION": "Palabra clave o segmentación de grupo", "CAMPAIGN_CRITERION": "Segmentación o negativa de campaña",
    "AD_GROUP_BID_MODIFIER": "Modificador de puja", "CAMPAIGN_ASSET": "Recurso de campaña", "ASSET_GROUP": "Grupo de recursos",
    "ASSET_GROUP_ASSET": "Recurso de grupo", "CAMPAIGN_SHARED_SET": "Lista compartida", "AD_GROUP_ASSET": "Recurso de grupo de anuncios",
    "CUSTOMER_ASSET": "Recurso de cuenta", "ASSET": "Recurso",
}
_CHANGE_OPERATION_LABELS = {"CREATE": "Creó", "UPDATE": "Cambió", "REMOVE": "Eliminó"}


def _dig(resource, path):
    """Valor en `path` (con puntos, camelCase) dentro del recurso de un change_event, que viene envuelto en una
    clave con el tipo del recurso (p. ej. {"campaign": {...}})."""
    if not isinstance(resource, dict) or not resource:
        return None
    node = next(iter(resource.values()))
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _humanize_path(path):
    last = path.split(".")[-1]
    words = re.sub(r"(?<!^)(?=[A-Z])", " ", last).lower()
    return words[:1].upper() + words[1:]


def _describe_change(event):
    """Qué cambió, en datos simples: lista de {label, old, new, kind} más un texto corto para altas y bajas."""
    op = event.get("resourceChangeOperation")
    rtype = event.get("changeResourceType")
    old_r, new_r = event.get("oldResource"), event.get("newResource")
    items = []
    text = None
    if op == "UPDATE":
        for path in [f for f in (event.get("changedFields") or "").split(",") if f]:
            label, kind = _CHANGE_FIELD_LABELS.get(path, (_humanize_path(path), "text"))
            old, new = _dig(old_r, path), _dig(new_r, path)
            if kind == "money_micros":
                old = None if old is None else int(old) / MICROS
                new = None if new is None else int(new) / MICROS
                kind = "money"
            elif kind in ("roas", "number"):
                old = None if old is None else float(old)
                new = None if new is None else float(new)
            elif not isinstance(old, (str, int, float, type(None))) or not isinstance(new, (str, int, float, type(None))):
                old = new = None  # estructuras largas (textos de un anuncio…): se avisa del cambio sin detallarlo
            items.append({"label": label, "old": old, "new": new, "kind": kind})
    else:
        res = new_r if op == "CREATE" else old_r
        kw = _dig(res, "keyword")
        if isinstance(kw, dict) and kw.get("text"):
            neg = _dig(res, "negative")
            text = f"{'Palabra clave negativa' if neg else 'Palabra clave'} «{kw['text']}» ({(kw.get('matchType') or '').lower()})"
        elif rtype == "CAMPAIGN_CRITERION" and isinstance(_dig(res, "location"), dict):
            text = f"Ubicación {'excluida' if _dig(res, 'negative') else 'añadida'}"
        elif rtype == "CAMPAIGN_CRITERION" and isinstance(_dig(res, "language"), dict):
            text = "Idioma"
    return {"items": items, "text": text}


def _change_row(e):
    when = (e.get("changeDateTime") or "")[:19]
    desc = _describe_change(e)
    return {
        "when": when, "date": when[:10], "user": e.get("userEmail") or "",
        "client": e.get("clientType") or "", "resource": e.get("changeResourceType") or "",
        "resource_label": _CHANGE_RESOURCE_LABELS.get(e.get("changeResourceType"), (e.get("changeResourceType") or "").replace("_", " ").lower()),
        "operation": e.get("resourceChangeOperation") or "",
        "operation_label": _CHANGE_OPERATION_LABELS.get(e.get("resourceChangeOperation"), ""),
        "items": desc["items"], "text": desc["text"],
    }


def _search_change_events(customer_id, fields, extra_where, days, limit):
    """change_event de los últimos `days` días (máximo 30). Google rechaza (START_DATE_TOO_OLD) un inicio que caiga
    justo en los 30 días cuando la zona horaria de la cuenta va por detrás de la del servidor; en ese caso se reintenta
    un día más tarde."""
    today = datetime.date.today()
    for back in (days - 1, days - 2):
        start = (today - datetime.timedelta(days=max(back, 0))).isoformat()
        try:
            return _search(customer_id, f"""
                SELECT {fields}
                FROM change_event
                WHERE change_event.change_date_time >= '{start}' AND change_event.change_date_time <= '{today.isoformat()} 23:59:59'
                  {extra_where}
                ORDER BY change_event.change_date_time DESC
                LIMIT {limit}
            """)
        except RuntimeError as e:
            if "START_DATE_TOO_OLD" not in str(e) or back <= 0 or back == days - 2:
                raise
    return []


def fetch_campaign_changes(customer_id, campaign_id, days=30):
    """Cambios de los últimos 30 días en la campaña y lo que cuelga de ella (change_event; Google solo guarda 30)."""
    rows = _search_change_events(
        customer_id,
        """change_event.change_date_time, change_event.user_email, change_event.client_type,
           change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields,
           change_event.old_resource, change_event.new_resource""",
        f"AND change_event.campaign = 'customers/{customer_id}/campaigns/{int(campaign_id)}'", days, 300)
    return [_change_row(r.get("changeEvent", {})) for r in rows]


ACCOUNT_CHANGES_LIMIT = 3000


def _id_from_resource(name):
    """'customers/1/campaigns/22' -> '22' (vacío si no hay recurso)."""
    return (name or "").rsplit("/", 1)[-1] if name else ""


_AUDIENCE_CRITERION_TYPES = ("USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE", "COMBINED_AUDIENCE")


def _audience_ref(crit):
    """Recurso al que apunta un criterio de audiencia (lista, interés, personalizada o combinada)."""
    t = crit.get("type")
    if t == "USER_LIST":
        return crit.get("userList", {}).get("userList")
    if t == "USER_INTEREST":
        return crit.get("userInterest", {}).get("userInterestCategory")
    if t == "CUSTOM_AUDIENCE":
        return crit.get("customAudience", {}).get("customAudience")
    if t == "COMBINED_AUDIENCE":
        return crit.get("combinedAudience", {}).get("combinedAudience")
    return None


def fetch_account_pacing_light(customer_id):
    """Ritmo del mes en curso de una cuenta, con las mismas cifras que Ritmo de consumo (gasto del mes de las campañas no
    eliminadas y objetivo de Billing > Presupuestos de cuenta), pero en dos consultas livianas: sin traer las filas completas
    de campañas. Devuelve la misma forma que fetch_account_pacing para un solo mes."""
    today = datetime.date.today()
    month_start = today.replace(day=1)
    end_of_today = f"{today.isoformat()} 23:59:59"
    spend = 0.0
    for r in _search(customer_id, f"""
        SELECT campaign.id, metrics.cost_micros
        FROM campaign
        WHERE segments.date BETWEEN '{month_start.isoformat()}' AND '{today.isoformat()}'
          AND campaign.status != 'REMOVED'
    """):
        spend += _micros_to_units(_int_or_none(r.get("metrics", {}).get("costMicros"))) or 0
    return {
        "spend_mtd": spend,
        "monthly_target": _account_budget_target(_account_budget_rows(customer_id, end_of_today, None), end_of_today),
        "days_elapsed": today.day,
        "days_in_month": calendar.monthrange(today.year, today.month)[1],
        "is_complete": False,
    }


def fetch_campaign_windows(customer_id, windows=(7, 14, 30)):
    """Para la vista «Dónde invertir» de Campañas: las métricas de todas las campañas de la cuenta en las ventanas de
    7, 14 y 30 días que terminan ayer (días completos). Por ventana son dos consultas, como en fetch_campaigns_overview:
    las métricas y, aparte, la cuota de impresiones (pedirlas juntas deja fuera lo que no es Search). Las ventanas son
    independientes y salen a la vez. Devuelve {"ranges": {"7": {from, to}, ...}, "windows": {"7": {campaign_id: {...}}, ...}}."""
    end = datetime.date.today() - datetime.timedelta(days=1)
    ranges = {str(n): {"from": (end - datetime.timedelta(days=n - 1)).isoformat(), "to": end.isoformat()} for n in windows}

    def one(n):
        d_from, d_to = ranges[str(n)]["from"], ranges[str(n)]["to"]
        rows = {}
        for r in _search(customer_id, f"""
            SELECT campaign.id, metrics.impressions, metrics.cost_micros, metrics.conversions, metrics.conversions_value
            FROM campaign
            WHERE segments.date BETWEEN '{d_from}' AND '{d_to}' AND campaign.status != 'REMOVED'
        """):
            m = r.get("metrics", {})
            rows[str(r.get("campaign", {}).get("id"))] = {
                "impressions": _int_or_none(m.get("impressions")) or 0,
                "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
                "conversions": _float_or_none(m.get("conversions")) or 0.0,
                "conv_value": _float_or_none(m.get("conversionsValue")) or 0.0,
                "lost_is_budget": None, "impr_share": None,
            }
        try:
            for r in _search(customer_id, f"""
                SELECT campaign.id, metrics.search_budget_lost_impression_share, metrics.search_impression_share
                FROM campaign
                WHERE segments.date BETWEEN '{d_from}' AND '{d_to}' AND campaign.status != 'REMOVED'
            """):
                m = r.get("metrics", {})
                row = rows.get(str(r.get("campaign", {}).get("id")))
                if row is not None:
                    row["lost_is_budget"] = _float_or_none(m.get("searchBudgetLostImpressionShare"))
                    row["impr_share"] = _float_or_none(m.get("searchImpressionShare"))
        except RuntimeError:
            pass  # sin cuotas la vista sirve igual: la recomendación de subir presupuesto se apoya entonces en el gasto frente al presupuesto
        return n, rows

    with ThreadPoolExecutor(max_workers=3) as pool:
        out = dict(pool.map(one, windows))
    return {"ranges": ranges, "windows": {str(n): out[n] for n in windows}}


def fetch_account_audiences(customer_id, date_from, date_to):
    """Sección Audiencias (solo lectura): inventario de listas propias, dónde se usa cada audiencia (campaña o grupo
    de anuncios, modo, negativa, modificador de puja) y su rendimiento en el rango. El uso sale de las tablas de
    criterios (traen también las negativas) y las métricas de campaign_audience_view / ad_group_audience_view, cruzadas
    por campaña o grupo + criterio. Cada bloque falla por separado y se informa en `errors`, sin tumbar el resto.
    Performance Max no devuelve rendimiento por audiencia: de ahí solo salen las señales."""
    errors = {}
    pool = ThreadPoolExecutor(max_workers=3)  # las consultas independientes salen a la vez

    def block(name, fn, default):
        for attempt in (1, 2):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001
                msg = " ".join(str(e).split())[:200]
                if attempt == 1 and ("timed out" in msg or "RESOURCE_EXHAUSTED" in msg):
                    time.sleep(2)  # tiempo límite en cuentas con cientos de listas, o cuota por ráfaga: un segundo intento
                    continue
                errors[name] = msg
                print(f"[audiencias] bloque {name} falló ({customer_id}): {msg}", flush=True)
                return default

    types_in = ", ".join(f"'{t}'" for t in _AUDIENCE_CRITERION_TYPES)

    def lists():
        out = []
        for r in _search(customer_id, """
            SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status, user_list.read_only,
                   user_list.size_for_search, user_list.size_for_display, user_list.membership_life_span
            FROM user_list LIMIT 2000
        """):
            u = r.get("userList", {})
            out.append({"key": u.get("resourceName"), "id": str(u.get("id")), "name": u.get("name") or "", "type": u.get("type"),
                        "status": u.get("membershipStatus"), "read_only": bool(u.get("readOnly")),
                        "size_search": _int_or_none(u.get("sizeForSearch")), "size_display": _int_or_none(u.get("sizeForDisplay")),
                        "life_span": _int_or_none(u.get("membershipLifeSpan"))})
        return out
    f_lists = pool.submit(block, "user_lists", lists, [])

    def campaigns():
        return [{"id": str(r.get("campaign", {}).get("id")), "name": r.get("campaign", {}).get("name") or "",
                 "status": r.get("campaign", {}).get("status"), "channel": r.get("campaign", {}).get("advertisingChannelType")}
                for r in _search(customer_id, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'")]
    f_camps = pool.submit(block, "campaigns", campaigns, [])

    def criteria_campaign():
        return _search(customer_id, f"""
            SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                   campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.display_name,
                   campaign_criterion.negative, campaign_criterion.bid_modifier,
                   campaign_criterion.user_list.user_list, campaign_criterion.user_interest.user_interest_category,
                   campaign_criterion.custom_audience.custom_audience, campaign_criterion.combined_audience.combined_audience
            FROM campaign_criterion
            WHERE campaign_criterion.type IN ({types_in}) AND campaign.status != 'REMOVED'
        """)
    f_camp_crit = pool.submit(block, "criterios_campana", criteria_campaign, [])

    def criteria_ad_group():
        return _search(customer_id, f"""
            SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.name,
                   ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.display_name,
                   ad_group_criterion.negative, ad_group_criterion.bid_modifier,
                   ad_group_criterion.user_list.user_list, ad_group_criterion.user_interest.user_interest_category,
                   ad_group_criterion.custom_audience.custom_audience, ad_group_criterion.combined_audience.combined_audience
            FROM ad_group_criterion
            WHERE ad_group_criterion.type IN ({types_in}) AND ad_group_criterion.status != 'REMOVED'
              AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'
        """)
    f_ag_crit = pool.submit(block, "criterios_grupo", criteria_ad_group, [])

    metric_fields = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value"

    def read_metrics(m):
        return {"impressions": _int_or_none(m.get("impressions")) or 0, "clicks": _int_or_none(m.get("clicks")) or 0,
                "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
                "conversions": _float_or_none(m.get("conversions")) or 0.0, "conv_value": _float_or_none(m.get("conversionsValue")) or 0.0}

    def metrics_campaign():
        out = {}
        for r in _search(customer_id, f"""
            SELECT campaign.id, campaign_criterion.criterion_id, {metric_fields}
            FROM campaign_audience_view WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
        """):
            out[(str(r.get("campaign", {}).get("id")), str(r.get("campaignCriterion", {}).get("criterionId")))] = read_metrics(r.get("metrics", {}))
        return out
    f_camp_metrics = pool.submit(block, "rendimiento_campana", metrics_campaign, {})

    def metrics_ad_group():
        out = {}
        for r in _search(customer_id, f"""
            SELECT ad_group.id, ad_group_criterion.criterion_id, {metric_fields}
            FROM ad_group_audience_view WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
        """):
            out[(str(r.get("adGroup", {}).get("id")), str(r.get("adGroupCriterion", {}).get("criterionId")))] = read_metrics(r.get("metrics", {}))
        return out
    f_ag_metrics = pool.submit(block, "rendimiento_grupo", metrics_ad_group, {})

    # Modo: "observación" (bid_only) solo ajusta la puja; "segmentación" limita la campaña a esa audiencia.
    def target_modes(resource, json_key):
        out = {}
        for r in _search(customer_id, f"SELECT {resource}.id, {resource}.targeting_setting.target_restrictions FROM {resource} WHERE {resource}.status != 'REMOVED'"):
            row = r.get(json_key, {})
            for t in row.get("targetingSetting", {}).get("targetRestrictions", []):
                if t.get("targetingDimension") == "AUDIENCE":
                    out[str(row.get("id"))] = "observation" if t.get("bidOnly") else "targeting"
        return out
    f_camp_modes = pool.submit(block, "modo_campana", lambda: target_modes("campaign", "campaign"), {})
    f_ag_modes = pool.submit(block, "modo_grupo", lambda: target_modes("ad_group", "adGroup"), {})
    user_lists, camp_list, camp_crit, ag_crit = f_lists.result(), f_camps.result(), f_camp_crit.result(), f_ag_crit.result()
    camp_metrics, ag_metrics, camp_modes, ag_modes = f_camp_metrics.result(), f_ag_metrics.result(), f_camp_modes.result(), f_ag_modes.result()
    pool.shutdown(wait=True)
    list_by_key = {u["key"]: u for u in user_lists}

    # Nombres: los intereses de Google, las audiencias personalizadas y las combinadas se resuelven aparte.
    refs = {_audience_ref(r.get("campaignCriterion", {})) for r in camp_crit} | {_audience_ref(r.get("adGroupCriterion", {})) for r in ag_crit}
    refs.discard(None)
    interest_ids = sorted({k.rsplit("/", 1)[-1] for k in refs if "/userInterests/" in k and k.rsplit("/", 1)[-1].isdigit()})

    def interests():
        out = {}
        for i in range(0, len(interest_ids), 150):
            chunk = ",".join(interest_ids[i:i + 150])
            for r in _search(customer_id, f"SELECT user_interest.user_interest_id, user_interest.name, user_interest.taxonomy_type FROM user_interest WHERE user_interest.user_interest_id IN ({chunk})"):
                u = r.get("userInterest", {})
                out[u.get("resourceName")] = (u.get("name") or "", u.get("taxonomyType"))
        return out
    interest_by_key = block("intereses", interests, {}) if interest_ids else {}

    def named(resource, field):
        out = {}
        for r in _search(customer_id, f"SELECT {resource}.name FROM {resource}"):
            x = r.get(field, {})
            out[x.get("resourceName")] = x.get("name") or ""
        return out
    custom_by_key = block("personalizadas", lambda: named("custom_audience", "customAudience"), {}) if any("/customAudiences/" in k for k in refs) else {}
    combined_by_key = block("combinadas", lambda: named("combined_audience", "combinedAudience"), {}) if any("/combinedAudiences/" in k for k in refs) else {}

    def describe(crit):
        key = _audience_ref(crit)
        t = crit.get("type")
        if t == "USER_LIST":
            u = list_by_key.get(key) or {}
            return key, u.get("name") or crit.get("displayName") or key, "list", u.get("type")
        if t == "USER_INTEREST":
            name, tax = interest_by_key.get(key, (None, None))
            kind = {"IN_MARKET": "in_market", "AFFINITY": "affinity"}.get(tax, "interest")
            return key, name or crit.get("displayName") or key, kind, tax
        if t == "CUSTOM_AUDIENCE":
            return key, custom_by_key.get(key) or crit.get("displayName") or key, "custom", None
        return key, combined_by_key.get(key) or crit.get("displayName") or key, "combined", None

    usage = []
    for r in camp_crit:
        c = r.get("campaignCriterion", {})
        key, name, kind, sub = describe(c)
        cid = str(r.get("campaign", {}).get("id"))
        m = camp_metrics.get((cid, str(c.get("criterionId"))), {})
        usage.append({"level": "campaign", "campaign_id": cid, "campaign": r.get("campaign", {}).get("name") or "",
                      "campaign_status": r.get("campaign", {}).get("status"), "channel": r.get("campaign", {}).get("advertisingChannelType"),
                      "ad_group_id": None, "ad_group": "", "key": key, "name": name, "kind": kind, "sub": sub,
                      "negative": bool(c.get("negative")), "bid_modifier": _float_or_none(c.get("bidModifier")),
                      "mode": camp_modes.get(cid), "has_metrics": bool(m), **{k: m.get(k, 0) for k in ("impressions", "clicks", "cost", "conversions", "conv_value")}})
    for r in ag_crit:
        c = r.get("adGroupCriterion", {})
        key, name, kind, sub = describe(c)
        cid, gid = str(r.get("campaign", {}).get("id")), str(r.get("adGroup", {}).get("id"))
        m = ag_metrics.get((gid, str(c.get("criterionId"))), {})
        usage.append({"level": "ad_group", "campaign_id": cid, "campaign": r.get("campaign", {}).get("name") or "",
                      "campaign_status": r.get("campaign", {}).get("status"), "channel": r.get("campaign", {}).get("advertisingChannelType"),
                      "ad_group_id": gid, "ad_group": r.get("adGroup", {}).get("name") or "", "key": key, "name": name, "kind": kind, "sub": sub,
                      "negative": bool(c.get("negative")), "bid_modifier": _float_or_none(c.get("bidModifier")),
                      "mode": ag_modes.get(gid), "has_metrics": bool(m), **{k: m.get(k, 0) for k in ("impressions", "clicks", "cost", "conversions", "conv_value")}})

    # Señales de audiencia de Performance Max (solo si hay campañas PMax activas).
    pmax = []
    if any(c["channel"] == "PERFORMANCE_MAX" and c["status"] == "ENABLED" for c in camp_list):
        def pmax_signals():
            names, members = {}, {}
            for r in _search(customer_id, "SELECT audience.resource_name, audience.name, audience.dimensions FROM audience"):
                a_ = r.get("audience", {})
                names[a_.get("resourceName")] = a_.get("name") or ""
                members[a_.get("resourceName")] = [seg.get("userList", {}).get("userList")
                                                   for dim in a_.get("dimensions", [])
                                                   for seg in dim.get("audienceSegments", {}).get("segments", [])
                                                   if seg.get("userList", {}).get("userList")]
            out = []
            for r in _search(customer_id, """
                SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group_signal.audience.audience
                FROM asset_group_signal
                WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
            """):
                aud = r.get("assetGroupSignal", {}).get("audience", {}).get("audience")
                if aud:
                    out.append({"campaign_id": str(r.get("campaign", {}).get("id")), "campaign": r.get("campaign", {}).get("name") or "",
                                "asset_group": r.get("assetGroup", {}).get("name") or "", "key": aud,
                                "name": names.get(aud) or aud.rsplit("/", 1)[-1], "lists": members.get(aud, [])})
            return out
        pmax = block("senales_pmax", pmax_signals, [])

    # Si fallaron a la vez las listas, las campañas y los dos criterios, no hay nada que mostrar: se devuelve el error real.
    if {"user_lists", "campaigns", "criterios_campana", "criterios_grupo"} <= set(errors):
        raise RuntimeError(next(iter(errors.values())))
    return {"lists": user_lists, "campaigns": camp_list, "usage": usage, "pmax_signals": pmax, "errors": errors}


def fetch_account_changes(customer_id, days=30):
    """Historial de cambios de toda la cuenta (change_event): quién, desde dónde, qué y en qué campaña. Google solo
    guarda 30 días y deja traer 10.000 filas como máximo; aquí se piden ACCOUNT_CHANGES_LIMIT y, si se llega al tope,
    se avisa con `truncated` (los más recientes son los que quedan). Los nombres de campaña y de grupo se resuelven
    con consultas aparte; si fallan, se muestra el id."""
    days = max(1, min(int(days), 30))
    rows = _search_change_events(
        customer_id,
        """change_event.change_date_time, change_event.user_email, change_event.client_type,
           change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields,
           change_event.campaign, change_event.ad_group, change_event.old_resource, change_event.new_resource""",
        "", days, ACCOUNT_CHANGES_LIMIT)
    camp_names, group_names, errors = {}, {}, {}
    try:
        for r in _search(customer_id, "SELECT campaign.id, campaign.name FROM campaign"):
            c = r.get("campaign", {})
            camp_names[str(c.get("id"))] = c.get("name") or ""
    except RuntimeError as e:
        errors["campaigns"] = str(e)
    try:
        for r in _search(customer_id, "SELECT ad_group.id, ad_group.name FROM ad_group"):
            g = r.get("adGroup", {})
            group_names[str(g.get("id"))] = g.get("name") or ""
    except RuntimeError as e:
        errors["ad_groups"] = str(e)
    out = []
    for r in rows:
        e = r.get("changeEvent", {})
        row = _change_row(e)
        cid, gid = _id_from_resource(e.get("campaign")), _id_from_resource(e.get("adGroup"))
        row["campaign_id"] = cid
        row["campaign_name"] = camp_names.get(cid) or (f"Campaña {cid}" if cid else "")
        row["ad_group_name"] = group_names.get(gid) or (f"Grupo {gid}" if gid else "")
        out.append(row)
    return {"changes": out, "truncated": len(rows) >= ACCOUNT_CHANGES_LIMIT, "days": days, "errors": errors}


def fetch_campaign_context(customer_id, campaign_id, date_from, date_to, prev_from, prev_to):
    """Resumen de la campaña con la comparación del periodo anterior, su estado en Google (y por qué está limitada)
    y los cambios de los últimos 30 días. El resumen es obligatorio; el estado y los cambios fallan por separado."""
    out = {
        "current": _campaign_period(customer_id, campaign_id, date_from, date_to),
        "previous": _campaign_period(customer_id, campaign_id, prev_from, prev_to) if prev_from and prev_to else None,
        "status": None, "changes": None, "errors": {},
    }
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.primary_status, campaign.primary_status_reasons, campaign.bidding_strategy_system_status,
                   campaign_budget.amount_micros, campaign_budget.explicitly_shared,
                   campaign_budget.has_recommended_budget, campaign_budget.recommended_budget_amount_micros
            FROM campaign
            WHERE campaign.id = {int(campaign_id)}
        """)
        if rows:
            c, b = rows[0].get("campaign", {}), rows[0].get("campaignBudget", {})
            out["status"] = {
                "primary_status": c.get("primaryStatus"), "reasons": c.get("primaryStatusReasons") or [],
                "bidding_system_status": c.get("biddingStrategySystemStatus"),
                "budget": _micros_to_units(_int_or_none(b.get("amountMicros"))), "shared_budget": bool(b.get("explicitlyShared")),
                "recommended_budget": _micros_to_units(_int_or_none(b.get("recommendedBudgetAmountMicros"))) if b.get("hasRecommendedBudget") else None,
            }
    except RuntimeError as e:
        out["errors"]["status"] = " ".join(str(e).split())[:300]
    try:
        out["changes"] = fetch_campaign_changes(customer_id, campaign_id)
    except RuntimeError as e:
        out["errors"]["changes"] = " ".join(str(e).split())[:300]
    return out


def _segment_rows(customer_id, campaign_id, date_from, date_to, segment_field, key):
    rows = _search(customer_id, f"""
        SELECT campaign.id, {segment_field},{_METRIC_FIELDS}
        FROM campaign
        WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
    """)
    out = []
    for r in rows:
        seg = r.get("segments", {})
        row = {"key": seg.get(key) or ""}
        row.update(_metrics_block(r.get("metrics", {})))
        out.append(row)
    return out


def fetch_campaign_segments(customer_id, campaign_id, date_from, date_to):
    """Cortes de la campaña: dispositivo, día de la semana, acción de conversión y países desde los que se ve."""
    out = {"device": None, "weekday": None, "conversions": None, "countries": None, "errors": {}}
    for name, field, key in (("device", "segments.device", "device"), ("weekday", "segments.day_of_week", "dayOfWeek")):
        try:
            out[name] = _segment_rows(customer_id, campaign_id, date_from, date_to, field, key)
        except RuntimeError as e:
            out["errors"][name] = " ".join(str(e).split())[:300]
    # Google no deja pedir las conversiones por acción junto a impresiones, clics o costo: solo sus dos métricas.
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.id, segments.conversion_action_name, segments.conversion_action_category,
                   metrics.conversions, metrics.conversions_value
            FROM campaign
            WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
        """)
        acc = {}
        for r in rows:
            seg, m = r.get("segments", {}), r.get("metrics", {})
            name = seg.get("conversionActionName") or "(sin nombre)"
            a = acc.setdefault(name, {"name": name, "category": seg.get("conversionActionCategory") or "", "conversions": 0.0, "conv_value": 0.0})
            a["conversions"] += _float_or_none(m.get("conversions")) or 0.0
            a["conv_value"] += _float_or_none(m.get("conversionsValue")) or 0.0
        out["conversions"] = sorted(acc.values(), key=lambda x: -x["conversions"])
    except RuntimeError as e:
        out["errors"]["conversions"] = " ".join(str(e).split())[:300]
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.id, geographic_view.country_criterion_id, geographic_view.location_type,{_METRIC_FIELDS}
            FROM geographic_view
            WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
        """)
        countries = {}
        for r in rows:
            gv = r.get("geographicView", {})
            if gv.get("locationType") != "LOCATION_OF_PRESENCE" or not gv.get("countryCriterionId"):
                continue
            countries[gv["countryCriterionId"]] = {"id": gv["countryCriterionId"], **_metrics_block(r.get("metrics", {}))}
        ids = list(countries)
        for i in range(0, len(ids), 150):
            chunk = ids[i:i + 150]
            for r in _search(customer_id, f"""
                SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code
                FROM geo_target_constant
                WHERE geo_target_constant.resource_name IN ({_in_list(['geoTargetConstants/' + c for c in chunk])})
            """):
                gc = r.get("geoTargetConstant", {})
                if str(gc.get("id")) in countries:
                    countries[str(gc["id"])].update({"name": gc.get("name") or "", "country_code": gc.get("countryCode") or ""})
        out["countries"] = sorted(({"name": c.get("name") or f"País {c['id']}", **{k: v for k, v in c.items() if k != "id"}} for c in countries.values()), key=lambda x: -x["cost"])
    except RuntimeError as e:
        out["errors"]["countries"] = " ".join(str(e).split())[:300]
    return out


def fetch_campaign_keywords(customer_id, campaign_id, date_from, date_to, limit=60):
    """Palabras clave de mayor gasto con su Nivel de calidad y los tres componentes (solo campañas Search)."""
    rows = _search(customer_id, f"""
        SELECT ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
               ad_group_criterion.status, ad_group_criterion.quality_info.quality_score,
               ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score,
               ad_group_criterion.quality_info.search_predicted_ctr,{_METRIC_FIELDS}
        FROM keyword_view
        WHERE campaign.id = {int(campaign_id)} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = FALSE
        ORDER BY metrics.cost_micros DESC
        LIMIT {int(limit)}
    """)
    out = []
    for r in rows:
        crit = r.get("adGroupCriterion", {})
        kw, q = crit.get("keyword", {}), crit.get("qualityInfo", {})
        row = {
            "text": kw.get("text") or "", "match_type": kw.get("matchType") or "", "status": crit.get("status") or "",
            "ad_group": r.get("adGroup", {}).get("name") or "",
            "quality_score": q.get("qualityScore"), "ad_relevance": q.get("creativeQualityScore"),
            "landing_page": q.get("postClickQualityScore"), "expected_ctr": q.get("searchPredictedCtr"),
        }
        row.update(_metrics_block(r.get("metrics", {})))
        out.append(row)
    return out


def fetch_campaign_keyword_daily(customer_id, campaign_id, date_from, date_to, limit=10):
    """Evolución día a día de las palabras clave de mayor gasto de una campaña Search (por defecto 10): impresiones,
    clics, gasto y cuota de impresiones de búsqueda de cada una. Dos consultas: primero cuáles son las principales en
    el rango y luego su serie diaria (pedir la serie de todas las palabras clave de una campaña grande no cabe).
    La cuota de impresiones viene vacía los días en que Google no la calcula."""
    campaign_id = int(campaign_id)
    top = _search(customer_id, f"""
        SELECT ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type, metrics.cost_micros, metrics.impressions
        FROM keyword_view
        WHERE campaign.id = {campaign_id} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = FALSE
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC, metrics.impressions DESC
        LIMIT {int(limit)}
    """)
    keywords = {}
    for r in top:
        crit = r.get("adGroupCriterion", {})
        key = f"{r.get('adGroup', {}).get('id')}~{crit.get('criterionId')}"
        if not crit.get("criterionId") or key in keywords:
            continue
        kw = crit.get("keyword", {})
        keywords[key] = {
            "key": key, "text": kw.get("text") or "", "match_type": kw.get("matchType") or "",
            "ad_group": r.get("adGroup", {}).get("name") or "", "days": [],
        }
    if not keywords:
        return {"date_from": date_from, "date_to": date_to, "keywords": []}
    criterion_ids = sorted({k.split("~")[1] for k in keywords})
    rows = _search(customer_id, f"""
        SELECT ad_group.id, ad_group_criterion.criterion_id, segments.date,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.search_impression_share
        FROM keyword_view
        WHERE campaign.id = {campaign_id} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
          AND ad_group_criterion.criterion_id IN ({", ".join(criterion_ids)})
          AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = FALSE
        ORDER BY segments.date
    """)
    for r in rows:
        key = f"{r.get('adGroup', {}).get('id')}~{r.get('adGroupCriterion', {}).get('criterionId')}"
        kw = keywords.get(key)
        date = r.get("segments", {}).get("date")
        if kw is None or not date:
            continue
        m = r.get("metrics", {})
        kw["days"].append({
            "date": date,
            "impressions": _int_or_none(m.get("impressions")) or 0,
            "clicks": _int_or_none(m.get("clicks")) or 0,
            "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0.0,
            "impr_share": _float_or_none(m.get("searchImpressionShare")),
        })
    return {"date_from": date_from, "date_to": date_to, "keywords": list(keywords.values())}


def fetch_campaign_position(customer_id, campaign_id, date_from, date_to, prev_from, prev_to):
    """Posición en la subasta: cuotas de impresiones superior y absoluta, lo perdido por presupuesto y ranking, cuota
    de clics y de coincidencia exacta. Los competidores (información de subastas) Google no los entrega a este
    token de desarrollador, así que no se piden."""
    out = {"current": _campaign_shares(customer_id, campaign_id, date_from, date_to, _POSITION_FIELDS), "previous": None}
    if prev_from and prev_to:
        out["previous"] = _campaign_shares(customer_id, campaign_id, prev_from, prev_to, _POSITION_FIELDS)
    return out


CAMPAIGN_STATUS_VALUES = ("ENABLED", "PAUSED")


def update_campaign_status(customer_id, campaign_id, status, validate_only=True):
    """Pausa o activa una campaña (campaign.status). Solo ENABLED y PAUSED: eliminar no se ofrece desde la
    plataforma. validate_only=True: Google valida sin aplicar; el cambio queda escrito solo con False."""
    if status not in CAMPAIGN_STATUS_VALUES:
        raise ValueError("El estado debe ser ENABLED o PAUSED.")
    url = f"{BASE_URL}/customers/{customer_id}/campaigns:mutate"
    body = {
        "operations": [{
            "update": {
                "resourceName": f"customers/{customer_id}/campaigns/{campaign_id}",
                "status": status,
            },
            "updateMask": "status",
        }],
        "validateOnly": validate_only,
    }
    _post_json(url, body)
    return {"validate_only": validate_only, "applied": not validate_only, "status": status}


# ---------------------------------------------------------------------------
# Anuncios nuevos (anuncio de búsqueda adaptable, RSA) en varias cuentas de un mismo MCC.
# Reglas que no se rompen: el anuncio se crea siempre PAUSADO (se activa a mano después), solo en un grupo de anuncios
# activo de una campaña Search activa que el servidor relee en vivo, y con una URL final cuyo dominio ya usan los
# anuncios de esa misma cuenta (la URL «original» de cada cuenta); si la cuenta no tiene ningún anuncio de
# referencia, la persona debe confirmar la URL a mano.
# ---------------------------------------------------------------------------
RSA_HEADLINE_MAX = 30
RSA_DESCRIPTION_MAX = 90
RSA_PATH_MAX = 15
RSA_HEADLINES_RANGE = (3, 15)
RSA_DESCRIPTIONS_RANGE = (2, 4)
AD_FINAL_URL_MAX = 2000


# Posiciones que se pueden fijar (pin) en un anuncio adaptable: título 1 o 2 y descripción 1 o 2. 0 = sin fijar.
RSA_PIN_FIELDS = {"headlines": {1: "HEADLINE_1", 2: "HEADLINE_2"}, "descriptions": {1: "DESCRIPTION_1", 2: "DESCRIPTION_2"}}


def clean_rsa_texts_with_pins(headlines, descriptions, path1="", path2="", head_pins=None, desc_pins=None):
    """Valida y limpia los textos de un anuncio adaptable y sus posiciones fijadas. `head_pins` y `desc_pins` van alineadas
    con las listas recibidas (0, vacío o None = sin fijar; 1 o 2 = esa posición). Devuelve (títulos, descripciones, ruta1,
    ruta2, pines de títulos, pines de descripciones) o lanza ValueError con un mensaje en español."""
    def _clean(items, pins, kind, one, maxlen, rng, fields):
        if not isinstance(items, list):
            raise ValueError(f"Faltan los {kind}.")
        if pins is not None and (not isinstance(pins, list) or len(pins) > len(items)):
            raise ValueError("Las posiciones fijadas no coinciden con los textos.")
        out, out_pins, seen = [], [], set()
        for idx, raw in enumerate(items):
            text = " ".join(str(raw or "").split())
            if not text:
                continue
            if len(text) > maxlen:
                raise ValueError(f"{one[0]}{one[1]} pasa de {maxlen} caracteres: «{text[:40]}…».")
            if any(ord(ch) < 32 for ch in text):
                raise ValueError(f"{one[0]}{one[1]} trae caracteres no permitidos.")
            key = text.lower()
            if key in seen:
                raise ValueError(f"Hay {one[0].lower()}{one[1]} repetid{one[2]}: «{text[:40]}».")
            seen.add(key)
            pin = pins[idx] if pins is not None and idx < len(pins) else 0
            if pin in (None, "", False):
                pin = 0
            if isinstance(pin, str) and pin.isdigit():
                pin = int(pin)
            if pin != 0 and (isinstance(pin, bool) or pin not in fields):
                raise ValueError(f"La posición fijada de un texto de {kind} debe ser 1 o 2.")
            out.append(text)
            out_pins.append(int(pin))
        if len(out) < rng[0] or len(out) > rng[1]:
            raise ValueError(f"Se necesitan entre {rng[0]} y {rng[1]} {kind} (hay {len(out)}).")
        return out, out_pins

    heads, hpins = _clean(headlines, head_pins, "títulos", ("Un ", "título", "o"), RSA_HEADLINE_MAX, RSA_HEADLINES_RANGE, RSA_PIN_FIELDS["headlines"])
    descs, dpins = _clean(descriptions, desc_pins, "descripciones", ("Una ", "descripción", "a"), RSA_DESCRIPTION_MAX, RSA_DESCRIPTIONS_RANGE, RSA_PIN_FIELDS["descriptions"])
    paths = []
    for raw in (path1, path2):
        text = str(raw or "").strip()
        if len(text) > RSA_PATH_MAX or re.search(r"[^\w\-]", text, re.UNICODE):
            raise ValueError(f"Cada ruta visible admite hasta {RSA_PATH_MAX} caracteres, solo letras, números, guion y guion bajo.")
        paths.append(text)
    if paths[1] and not paths[0]:
        raise ValueError("La segunda ruta visible necesita la primera.")
    return heads, descs, paths[0], paths[1], hpins, dpins


def clean_rsa_texts(headlines, descriptions, path1="", path2=""):
    """Valida y limpia los textos de un anuncio adaptable (sin posiciones fijadas). Devuelve (títulos, descripciones,
    ruta1, ruta2) o lanza ValueError con un mensaje en español."""
    return clean_rsa_texts_with_pins(headlines, descriptions, path1, path2)[:4]


def _rsa_assets(texts, pins, kind):
    """Textos como assets de la API; los fijados llevan pinnedField (HEADLINE_1, DESCRIPTION_2…)."""
    fields = RSA_PIN_FIELDS[kind]
    out = []
    for i, t in enumerate(texts):
        asset = {"text": t}
        pin = pins[i] if pins and i < len(pins) else 0
        if pin in fields:
            asset["pinnedField"] = fields[pin]
        out.append(asset)
    return out


def normalize_final_url(url):
    """URL final válida (http o https, con dominio, sin espacios). Devuelve la URL limpia o lanza ValueError."""
    text = str(url or "").strip()
    if not text or len(text) > AD_FINAL_URL_MAX or re.search(r"\s", text):
        raise ValueError("La URL final falta, es demasiado larga o trae espacios.")
    parts = urllib.parse.urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("La URL final debe empezar con http:// o https:// y traer un dominio.")
    return text


def url_host(url):
    """Dominio de una URL en minúsculas y sin «www.», o '' si no se puede leer."""
    try:
        host = (urllib.parse.urlsplit(str(url or "").strip()).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def google_error_text(exc, limit=260):
    """Mensaje legible de un error de la API de Google Ads (sin ids ni datos de la cuenta): toma los textos de
    los errores del JSON de la respuesta. Para errores propios (ValueError) devuelve el texto tal cual."""
    detail = str(exc)
    if isinstance(exc, ValueError):
        return detail[:limit]
    match = re.search(r"respondió \d{3}: (\{.*\})", detail, re.S)
    messages = []
    if match:
        try:
            body = json.loads(match.group(1)).get("error", {})
            for d in body.get("details", []) or []:
                for e in d.get("errors", []) or []:
                    msg = " ".join(str(e.get("message") or "").split())
                    if msg and msg not in messages:
                        messages.append(msg)
            if not messages and body.get("message"):
                messages.append(" ".join(str(body["message"]).split()))
        except (ValueError, AttributeError):
            pass
    if messages:
        return ("Google Ads rechazó el anuncio: " + " · ".join(messages[:2]))[:limit]
    if "No se pudo conectar" in detail:
        return "No se pudo conectar con Google Ads. Intenta de nuevo."
    return "Google Ads no aceptó la solicitud. Revisa los datos e intenta de nuevo."


def _search_ads_final_urls(customer_id):
    """(URL por grupo de anuncios, URLs de toda la cuenta) de los anuncios activos de campañas Search activas."""
    rows = _search(customer_id, """
        SELECT ad_group.id, ad_group_ad.ad.final_urls
        FROM ad_group_ad
        WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED'
          AND campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
    """)
    by_group, overall = {}, Counter()
    for r in rows:
        urls = (r.get("adGroupAd", {}).get("ad", {}) or {}).get("finalUrls") or []
        if not urls:
            continue
        url = str(urls[0])
        gid = str((r.get("adGroup") or {}).get("id"))
        by_group.setdefault(gid, Counter())[url] += 1
        overall[url] += 1
    return by_group, overall


def fetch_ad_targets(customer_id):
    """Destinos posibles para un anuncio nuevo en una cuenta: campañas Search activas con sus grupos de anuncios
    activos (con el gasto de 30 días para sugerir el principal) y la URL que ya usan sus anuncios."""
    structure = _search(customer_id, """
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name
        FROM ad_group
        WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'
    """)
    cost_rows = _search(customer_id, """
        SELECT ad_group.id, metrics.cost_micros
        FROM ad_group
        WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'
          AND segments.date DURING LAST_30_DAYS
    """)
    cost_by_group = {}
    for r in cost_rows:
        gid = str((r.get("adGroup") or {}).get("id"))
        cost_by_group[gid] = cost_by_group.get(gid, 0) + int((r.get("metrics") or {}).get("costMicros") or 0)
    by_group, overall = _search_ads_final_urls(customer_id)
    return _build_ad_targets(structure, cost_by_group, by_group, overall)


def _build_ad_targets(structure, cost_by_group, url_by_group, url_overall):
    campaigns = {}
    for r in structure:
        c, g = r.get("campaign") or {}, r.get("adGroup") or {}
        cid, gid = str(c.get("id")), str(g.get("id"))
        camp = campaigns.setdefault(cid, {"id": cid, "name": c.get("name") or f"Campaña {cid}", "cost_30d": 0.0, "ad_groups": []})
        cost = cost_by_group.get(gid, 0) / MICROS
        urls = url_by_group.get(gid)
        camp["ad_groups"].append({
            "id": gid, "name": g.get("name") or f"Grupo {gid}", "cost_30d": round(cost, 2),
            "url": urls.most_common(1)[0][0] if urls else "",
        })
        camp["cost_30d"] += cost
    out = sorted(campaigns.values(), key=lambda c: -c["cost_30d"])
    for c in out:
        c["cost_30d"] = round(c["cost_30d"], 2)
        c["ad_groups"].sort(key=lambda g: -g["cost_30d"])
    return {
        "campaigns": out,
        "urls": [{"url": u, "count": n} for u, n in url_overall.most_common(8)],
        "default_url": url_overall.most_common(1)[0][0] if url_overall else "",
    }


def _create_rsa(customer_id, ad_group_id, heads, descs, path1, path2, final_url, validate_only, head_pins=None, desc_pins=None):
    url = f"{BASE_URL}/customers/{customer_id}/adGroupAds:mutate"
    rsa = {"headlines": _rsa_assets(heads, head_pins, "headlines"), "descriptions": _rsa_assets(descs, desc_pins, "descriptions")}
    if path1:
        rsa["path1"] = path1
    if path2:
        rsa["path2"] = path2
    body = {
        "operations": [{"create": {
            "adGroup": f"customers/{customer_id}/adGroups/{ad_group_id}",
            "status": "PAUSED",
            "ad": {"finalUrls": [final_url], "responsiveSearchAd": rsa},
        }}],
        "validateOnly": validate_only,
    }
    payload = _post_json(url, body)
    results = payload.get("results") or []
    resource = (results[0] or {}).get("resourceName", "") if results else ""
    return resource


def _check_bulk_ad_url(url, group_urls, account_urls, custom_url):
    """Regla de la URL en la creación por plantilla. Por defecto debe ser una de las que ya usan los anuncios activos del
    propio grupo. Con `custom_url` (la persona escribió una URL de destino para toda la tanda) basta que sea de un dominio
    que ya usen los anuncios activos de la cuenta; si la cuenta no tiene ninguno no hay referencia y se rechaza."""
    if not custom_url:
        if url not in group_urls:
            raise ValueError("La URL no coincide con la de los anuncios activos de este grupo.")
        return
    known = {url_host(u) for u in account_urls if url_host(u)}
    if not known:
        raise ValueError("La cuenta no tiene anuncios activos de referencia: no se puede usar una URL de destino propia.")
    if url_host(url) not in known:
        raise ValueError("La URL de destino no es de un dominio que ya usen los anuncios de esta cuenta: " + ", ".join(sorted(known)[:3]) + ".")


def _check_ad_url_rule(final_url, reference_urls, url_confirmed):
    """La URL debe caer en un dominio que ya usan los anuncios de la cuenta. Sin anuncios de referencia, la persona
    la confirma a mano. Devuelve True si el dominio es conocido, False si se aceptó por confirmación manual."""
    known = {url_host(u) for u in reference_urls if url_host(u)}
    if known:
        if url_host(final_url) not in known:
            raise ValueError("La URL no es de un dominio que ya usen los anuncios de esta cuenta: " + ", ".join(sorted(known)[:3]) + ".")
        return True
    if not url_confirmed:
        raise ValueError("Esta cuenta no tiene anuncios activos de referencia: confirma la URL a mano para crearla.")
    return False


def create_responsive_search_ad(customer_id, ad_group_id, headlines, descriptions, path1, path2, final_url,
                                url_confirmed=False, validate_only=True, head_pins=None, desc_pins=None):
    """Crea (o solo valida, con validate_only=True) un anuncio de búsqueda adaptable PAUSADO en un grupo de anuncios.
    Relee en vivo el grupo y su campaña y exige que sean Search y estén activos; la URL debe ser del dominio que ya
    usa la cuenta. Los textos ya deben venir limpios (clean_rsa_texts)."""
    if not str(ad_group_id).isdigit():
        raise ValueError("Falta o es inválido el grupo de anuncios.")
    final_url = normalize_final_url(final_url)
    rows = _search(customer_id, f"""
        SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type
        FROM ad_group WHERE ad_group.id = {int(ad_group_id)}
    """)
    if not rows:
        raise ValueError("No se encontró el grupo de anuncios en esta cuenta.")
    g, c = rows[0].get("adGroup") or {}, rows[0].get("campaign") or {}
    if c.get("advertisingChannelType") != "SEARCH":
        raise ValueError("El anuncio solo se crea en campañas Search.")
    if c.get("status") != "ENABLED" or g.get("status") != "ENABLED":
        raise ValueError("La campaña y el grupo de anuncios deben estar activos.")
    _, overall = _search_ads_final_urls(customer_id)
    known = _check_ad_url_rule(final_url, list(overall), url_confirmed)
    resource = _create_rsa(customer_id, ad_group_id, headlines, descriptions, path1, path2, final_url, validate_only, head_pins, desc_pins)
    return {
        "validate_only": validate_only, "applied": not validate_only, "campaign_id": str(c.get("id")),
        "campaign_name": c.get("name") or "", "ad_group_name": g.get("name") or "", "resource_name": resource,
        "ad_id": resource.split("~")[-1] if "~" in resource else "", "url_known": known,
    }


# ---------------------------------------------------------------------------
# Anuncios nuevos «por plantilla»: el mismo anuncio (con textos por idioma y variables por hotel) en TODOS los grupos de
# anuncios activos de campañas Search activas de cada cuenta. Cada anuncio se crea PAUSADO, con la URL que ya usan los
# anuncios activos de ese mismo grupo (sin anuncio de referencia el grupo se omite) y marcado con una etiqueta que
# identifica la tanda e impide crearlo dos veces. Las escrituras de una cuenta se mandan por lotes en una sola llamada.
# ---------------------------------------------------------------------------
AD_LABEL_MAX = 80
AD_BULK_CHUNK = 50
AD_MAX_ENABLED_RSA = 3


def clean_ad_label(label):
    """Nombre de etiqueta válido (letras, números, espacios, guion y guion bajo; hasta 80). Lanza ValueError si no."""
    text = " ".join(str(label or "").split())
    if not text or len(text) > AD_LABEL_MAX or re.search(r"[^\w\- ]", text, re.UNICODE):
        raise ValueError(f"La etiqueta es obligatoria (hasta {AD_LABEL_MAX} caracteres: letras, números, espacios, guion y guion bajo).")
    return text


def _gaql_quote(text):
    return str(text).replace("\\", "\\\\").replace("'", "\\'")


def _labeled_ads_by_group(customer_id, label):
    """{id del grupo: cantidad de anuncios no eliminados con esa etiqueta}."""
    rows = _search(customer_id, f"""
        SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status
        FROM ad_group_ad_label
        WHERE label.name = '{_gaql_quote(label)}' AND ad_group_ad.status != 'REMOVED'
    """)
    out = Counter()
    for r in rows:
        out[str((r.get("adGroup") or {}).get("id"))] += 1
    return out


def _enabled_rsa_by_group(customer_id):
    rows = _search(customer_id, """
        SELECT ad_group.id, ad_group_ad.ad.id
        FROM ad_group_ad
        WHERE ad_group_ad.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
          AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
    """)
    out = Counter()
    for r in rows:
        out[str((r.get("adGroup") or {}).get("id"))] += 1
    return out


def fetch_bulk_ad_groups(customer_id, label=""):
    """Todos los grupos de anuncios activos de campañas Search activas de una cuenta, con lo necesario para decidir si
    se les puede crear el anuncio: nombre de la campaña (de ahí salen el hotel y el idioma), URL de referencia (la más
    usada por los anuncios activos del grupo), cuántos RSA activos tiene y cuántos anuncios ya llevan la etiqueta."""
    structure = _search(customer_id, """
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name
        FROM ad_group
        WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'
    """)
    by_group, overall = _search_ads_final_urls(customer_id)
    rsa = _enabled_rsa_by_group(customer_id)
    labeled = _labeled_ads_by_group(customer_id, clean_ad_label(label)) if label else Counter()
    return _build_bulk_ad_groups(structure, by_group, overall, rsa, labeled)


def _build_bulk_ad_groups(structure, url_by_group, url_overall, rsa_by_group, labeled_by_group):
    campaigns = {}
    for r in structure:
        c, g = r.get("campaign") or {}, r.get("adGroup") or {}
        cid, gid = str(c.get("id")), str(g.get("id"))
        camp = campaigns.setdefault(cid, {"id": cid, "name": c.get("name") or f"Campaña {cid}", "ad_groups": []})
        urls = url_by_group.get(gid)
        camp["ad_groups"].append({
            "id": gid, "name": g.get("name") or f"Grupo {gid}",
            "url": urls.most_common(1)[0][0] if urls else "",
            "rsa_enabled": int(rsa_by_group.get(gid, 0)),
            "labeled": int(labeled_by_group.get(gid, 0)),
        })
    out = sorted(campaigns.values(), key=lambda c: c["name"].lower())
    for c in out:
        c["ad_groups"].sort(key=lambda g: g["name"].lower())
    return {"campaigns": out, "hosts": sorted({url_host(u) for u in url_overall if url_host(u)})}


def _partial_failure_errors(payload):
    """{índice de la operación: mensaje} a partir de partialFailureError de una respuesta de mutate."""
    out = {}
    err = payload.get("partialFailureError") or {}
    for d in err.get("details", []) or []:
        for e in d.get("errors", []) or []:
            msg = " ".join(str(e.get("message") or "").split())
            idx = None
            for el in ((e.get("location") or {}).get("fieldPathElements") or []):
                if el.get("fieldName") == "operations" and el.get("index") is not None:
                    idx = int(el["index"])
                    break
            if idx is None:
                continue
            out[idx] = (out.get(idx, "") + (" · " if idx in out else "") + msg)[:240]
    return out


def _mutate_rsa_batch(customer_id, ads, validate_only):
    """Manda por lotes los anuncios [{ad_group_id, final_url, headlines, descriptions}] (todos PAUSADOS). Devuelve una
    lista alineada con `ads`: {"ok": True, "resource_name": ...} o {"ok": False, "error": ...}."""
    url = f"{BASE_URL}/customers/{customer_id}/adGroupAds:mutate"
    out = []
    for start in range(0, len(ads), AD_BULK_CHUNK):
        chunk = ads[start:start + AD_BULK_CHUNK]
        ops = [{"create": {
            "adGroup": f"customers/{customer_id}/adGroups/{a['ad_group_id']}",
            "status": "PAUSED",
            "ad": {"finalUrls": [a["final_url"]], "responsiveSearchAd": {
                "headlines": _rsa_assets(a["headlines"], a.get("head_pins"), "headlines"),
                "descriptions": _rsa_assets(a["descriptions"], a.get("desc_pins"), "descriptions"),
                **({"path1": a["path1"]} if a.get("path1") else {}),
                **({"path2": a["path2"]} if a.get("path2") else {}),
            }},
        }} for a in chunk]
        try:
            payload = _post_json(url, {"operations": ops, "partialFailure": True, "validateOnly": validate_only})
        except Exception as e:  # noqa: BLE001 — un lote que falla entero se reporta en cada anuncio del lote
            msg = google_error_text(e)
            out.extend({"ok": False, "error": msg} for _ in chunk)
            continue
        errors = _partial_failure_errors(payload)
        results = payload.get("results") or []
        for i in range(len(chunk)):
            if i in errors:
                out.append({"ok": False, "error": "Google Ads rechazó el anuncio: " + errors[i]})
            else:
                rn = (results[i] or {}).get("resourceName", "") if i < len(results) else ""
                out.append({"ok": True, "resource_name": rn})
    return out


def _ensure_label(customer_id, label, description="Anuncios creados desde Paid Media Helper"):
    """Resource name de la etiqueta de la cuenta (la crea si no existe)."""
    rows = _search(customer_id, f"SELECT label.resource_name, label.name FROM label WHERE label.name = '{_gaql_quote(label)}' AND label.status = 'ENABLED'")
    if rows:
        return (rows[0].get("label") or {}).get("resourceName", "")
    payload = _post_json(f"{BASE_URL}/customers/{customer_id}/labels:mutate", {"operations": [{"create": {
        "name": label, "textLabel": {"description": description, "backgroundColor": "#FFB300"},
    }}]})
    return ((payload.get("results") or [{}])[0] or {}).get("resourceName", "")


def _apply_label(customer_id, label_resource, ad_resources, validate_only=False):
    """Etiqueta los anuncios creados. Devuelve {resource_name del anuncio: mensaje de error} (vacío si todo salió bien)."""
    failed = {}
    for start in range(0, len(ad_resources), AD_BULK_CHUNK):
        chunk = ad_resources[start:start + AD_BULK_CHUNK]
        ops = [{"create": {"adGroupAd": rn, "label": label_resource}} for rn in chunk]
        try:
            payload = _post_json(f"{BASE_URL}/customers/{customer_id}/adGroupAdLabels:mutate", {"operations": ops, "partialFailure": True, "validateOnly": validate_only})
        except Exception as e:  # noqa: BLE001
            for rn in chunk:
                failed[rn] = google_error_text(e)
            continue
        for idx, msg in _partial_failure_errors(payload).items():
            if idx < len(chunk):
                failed[chunk[idx]] = msg
    return failed


def create_bulk_responsive_search_ads(customer_id, ads, label, validate_only=True):
    """Crea (o solo valida) anuncios PAUSADOS en varios grupos de una cuenta. `ads` = [{ad_group_id, final_url,
    headlines, descriptions}] con textos ya limpios. Relee en vivo la estructura y exige: grupo y campaña activos y
    Search, la URL entre las de los anuncios activos de ESE grupo (o, con `custom_url`, de un dominio que ya usen los
    anuncios activos de la cuenta), menos de 3 RSA activos y ningún anuncio previo con la
    etiqueta. Devuelve una lista alineada con `ads` con {ok, ...} por grupo."""
    label = clean_ad_label(label)
    live = _search(customer_id, """
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name
        FROM ad_group
        WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'
    """)
    groups = {str((r.get("adGroup") or {}).get("id")): r for r in live}
    url_by_group, overall = _search_ads_final_urls(customer_id)
    rsa = _enabled_rsa_by_group(customer_id)
    labeled = _labeled_ads_by_group(customer_id, label)
    results = [None] * len(ads)
    to_send, to_send_idx, seen = [], [], set()
    for i, a in enumerate(ads):
        gid = str(a["ad_group_id"])
        row = groups.get(gid)
        try:
            if not row:
                raise ValueError("El grupo ya no está activo en una campaña Search activa (o no es de esta cuenta).")
            if gid in seen:
                raise ValueError("El grupo se repite en la misma tanda.")
            seen.add(gid)
            url = normalize_final_url(a["final_url"])
            _check_bulk_ad_url(url, url_by_group.get(gid, {}), overall, bool(a.get("custom_url")))
            if rsa.get(gid, 0) >= AD_MAX_ENABLED_RSA:
                raise ValueError(f"El grupo ya tiene {AD_MAX_ENABLED_RSA} anuncios adaptables activos.")
            if labeled.get(gid, 0):
                raise ValueError("El grupo ya tiene un anuncio con esa etiqueta.")
        except ValueError as e:
            results[i] = {"ok": False, "error": str(e)}
            continue
        c, g = row.get("campaign") or {}, row.get("adGroup") or {}
        results[i] = {"campaign_id": str(c.get("id")), "campaign_name": c.get("name") or "", "ad_group_name": g.get("name") or ""}
        to_send.append({**a, "final_url": url})
        to_send_idx.append(i)
    sent = _mutate_rsa_batch(customer_id, to_send, validate_only) if to_send else []
    created = []
    for i, res in zip(to_send_idx, sent):
        base = results[i]
        if not res["ok"]:
            results[i] = {"ok": False, "error": res["error"]}
            continue
        rn = res.get("resource_name", "")
        results[i] = {**base, "ok": True, "resource_name": rn, "ad_id": rn.split("~")[-1] if "~" in rn else "", "labeled": False}
        if rn:
            created.append(i)
    if not validate_only and created:
        label_error = ""
        failed = {}
        try:
            label_resource = _ensure_label(customer_id, label)
            if not label_resource:
                raise RuntimeError("No se pudo crear la etiqueta.")
            failed = _apply_label(customer_id, label_resource, [results[i]["resource_name"] for i in created])
        except Exception as e:  # noqa: BLE001 — los anuncios ya existen (pausados); se avisa que quedaron sin etiqueta
            label_error = google_error_text(e)
        for i in created:
            rn = results[i]["resource_name"]
            if label_error:
                results[i]["label_error"] = label_error
            elif rn in failed:
                results[i]["label_error"] = failed[rn]
            else:
                results[i]["labeled"] = True
    return results


# ---------------------------------------------------------------------------
# Activar o pausar, a mano y con vista previa, los anuncios adaptables que llevan una etiqueta (los de una tanda creada
# con «Por plantilla»). Solo se toca el estado de anuncios que el servidor vuelve a encontrar con esa etiqueta en ese
# momento; para activar, el grupo y la campaña deben estar activos y ser Search, y el grupo no puede pasar de 3
# anuncios adaptables activos. No se crea ni se elimina nada.
# ---------------------------------------------------------------------------
AD_STATUS_VALUES = ("ENABLED", "PAUSED")


def _labeled_ads_detail(customer_id, label):
    """Anuncios adaptables no eliminados que llevan la etiqueta, con el estado de su grupo y su campaña."""
    rows = _search(customer_id, f"""
        SELECT ad_group.id, ad_group.name, ad_group.status, ad_group_ad.ad.id, ad_group_ad.status,
               campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
        FROM ad_group_ad_label
        WHERE label.name = '{_gaql_quote(label)}' AND ad_group_ad.status != 'REMOVED'
          AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
    """)
    out = []
    for r in rows:
        g, c = r.get("adGroup") or {}, r.get("campaign") or {}
        aga = r.get("adGroupAd") or {}
        out.append({
            "ad_group_id": str(g.get("id")), "ad_group_name": g.get("name") or "", "ad_id": str((aga.get("ad") or {}).get("id")),
            "status": aga.get("status") or "", "campaign_id": str(c.get("id")), "campaign_name": c.get("name") or "",
            "active_context": c.get("status") == "ENABLED" and g.get("status") == "ENABLED" and c.get("advertisingChannelType") == "SEARCH",
        })
    out.sort(key=lambda x: (x["campaign_name"].lower(), x["ad_group_name"].lower(), x["ad_id"]))
    return out


def fetch_label_ads(customer_id, label):
    """Anuncios con la etiqueta en una cuenta y cuántos adaptables activos tiene cada grupo (para el límite de 3)."""
    label = clean_ad_label(label)
    ads = _labeled_ads_detail(customer_id, label)
    return {"ads": ads, "rsa_enabled": dict(_enabled_rsa_by_group(customer_id))}


def fetch_account_timezone(customer_id):
    """Zona horaria de la cuenta (por ejemplo «America/Bogota»), tal como la guarda Google Ads."""
    rows = _search(customer_id, "SELECT customer.time_zone FROM customer")
    tz = ((rows[0].get("customer") or {}).get("timeZone") or "") if rows else ""
    if not tz:
        raise ValueError("No se pudo leer la zona horaria de la cuenta.")
    return tz


def _mutate_ad_status_batch(customer_id, resources, status, validate_only):
    """Cambia el estado de los anuncios (resource names). Devuelve una lista alineada: {"ok": True} o {"ok": False, "error"}."""
    url = f"{BASE_URL}/customers/{customer_id}/adGroupAds:mutate"
    out = []
    for start in range(0, len(resources), AD_BULK_CHUNK):
        chunk = resources[start:start + AD_BULK_CHUNK]
        ops = [{"update": {"resourceName": rn, "status": status}, "updateMask": "status"} for rn in chunk]
        try:
            payload = _post_json(url, {"operations": ops, "partialFailure": True, "validateOnly": validate_only})
        except Exception as e:  # noqa: BLE001 — un lote que falla entero se reporta en cada anuncio del lote
            msg = google_error_text(e)
            out.extend({"ok": False, "error": msg} for _ in chunk)
            continue
        errors = _partial_failure_errors(payload)
        for i in range(len(chunk)):
            out.append({"ok": False, "error": "Google Ads rechazó el cambio: " + errors[i]} if i in errors else {"ok": True})
    return out


def _check_label_ad_change(row, status, enabled_in_group, planned_in_group):
    """Regla de un cambio de estado sobre un anuncio con etiqueta. Lanza ValueError con el motivo si no se puede."""
    if status == "ENABLED":
        if row["status"] != "PAUSED":
            raise ValueError("El anuncio ya está activo.")
        if not row["active_context"]:
            raise ValueError("La campaña o el grupo de anuncios no está activo (o no es Search).")
        if enabled_in_group + planned_in_group >= AD_MAX_ENABLED_RSA:
            raise ValueError(f"El grupo pasaría de {AD_MAX_ENABLED_RSA} anuncios adaptables activos.")
    else:
        if row["status"] != "ENABLED":
            raise ValueError("El anuncio ya está pausado.")


def set_label_ads_status(customer_id, items, label, status, validate_only=True):
    """Activa o pausa (o solo valida) anuncios que llevan la etiqueta. `items` = [{ad_group_id, ad_id}]. Relee en vivo
    qué anuncios llevan la etiqueta y su estado. Devuelve una lista alineada con `items`."""
    if status not in AD_STATUS_VALUES:
        raise ValueError("El estado debe ser ENABLED o PAUSED.")
    label = clean_ad_label(label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in _labeled_ads_detail(customer_id, label)}
    enabled = _enabled_rsa_by_group(customer_id)
    planned = Counter()
    results = [None] * len(items)
    to_send, idx = [], []
    for i, it in enumerate(items):
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            if not row:
                raise ValueError("El anuncio ya no tiene esa etiqueta o fue eliminado.")
            _check_label_ad_change(row, status, enabled.get(key[0], 0), planned[key[0]])
        except ValueError as e:
            results[i] = {"ok": False, "error": str(e), "skipped": True}
            continue
        if status == "ENABLED":
            planned[key[0]] += 1
        results[i] = {"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]}
        to_send.append(f"customers/{customer_id}/adGroupAds/{key[0]}~{key[1]}")
        idx.append(i)
    sent = _mutate_ad_status_batch(customer_id, to_send, status, validate_only) if to_send else []
    for i, res in zip(idx, sent):
        if not res["ok"]:
            results[i] = {"ok": False, "error": res["error"]}
    return results


# ---------------------------------------------------------------------------
# Performance Max: UN grupo de recursos nuevo (textos, imágenes y videos) en una campaña PMax que ya existe y está activa
# en cada cuenta. Reglas que no se rompen: el grupo se crea siempre PAUSADO, la campaña se relee en vivo (activa y PMax),
# la URL final sale de los grupos de recursos que esa campaña ya tiene, y todo (recursos, grupo y vínculos) viaja en UNA
# sola petición atómica `googleAds:mutate`: si Google rechaza algo, no se crea nada en esa cuenta. La vista previa usa
# `validateOnly` sobre esa misma petición.
# ---------------------------------------------------------------------------
PMAX_HEADLINE_MAX, PMAX_HEADLINES_RANGE = 30, (3, 15)
PMAX_LONG_HEADLINE_MAX, PMAX_LONG_HEADLINES_RANGE = 90, (1, 5)
PMAX_DESCRIPTION_MAX, PMAX_DESCRIPTIONS_RANGE, PMAX_SHORT_DESCRIPTION_MAX = 90, (2, 5), 60
PMAX_BUSINESS_NAME_MAX = 25
PMAX_GROUP_NAME_MAX = 128
PMAX_MAX_VIDEOS = 5
PMAX_IMAGE_MAX_BYTES = 5 * 1024 * 1024
PMAX_MAX_MARKETING_IMAGES = 20
PMAX_MAX_LOGOS = 5
PMAX_IMAGE_TOTAL_MAX_BYTES = 24 * 1024 * 1024
PMAX_RATIO_TOLERANCE = 0.02
# tipo -> (campo de la API, proporción ancho/alto, tamaño mínimo (ancho, alto), nombre en español, obligatorio)
PMAX_IMAGE_KINDS = {
    "landscape": ("MARKETING_IMAGE", 1.91, (600, 314), "imagen horizontal 1,91:1", True),
    "square": ("SQUARE_MARKETING_IMAGE", 1.0, (300, 300), "imagen cuadrada 1:1", True),
    "portrait": ("PORTRAIT_MARKETING_IMAGE", 0.8, (480, 600), "imagen vertical 4:5", False),
    "logo": ("LOGO", 1.0, (128, 128), "logo cuadrado 1:1", False),
    "logo_wide": ("LANDSCAPE_LOGO", 4.0, (512, 128), "logo horizontal 4:1", False),
}


def _image_size(raw):
    """(tipo, ancho, alto) de un PNG o JPEG a partir de sus bytes, o None si no es ninguno de los dos."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24:
        return "png", struct.unpack(">I", raw[16:20])[0], struct.unpack(">I", raw[20:24])[0]
    if raw[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seglen = struct.unpack(">H", raw[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return "jpeg", struct.unpack(">H", raw[i + 7:i + 9])[0], struct.unpack(">H", raw[i + 5:i + 7])[0]
            i += 2 + seglen
    return None


def clean_pmax_images(images):
    """Valida las imágenes del grupo de recursos: {tipo: [{name, data (base64)}]}. Devuelve una lista de
    {kind, field, name, data} con los bytes en base64 ya comprobados (PNG o JPEG, tamaño, proporción y mínimos),
    o lanza ValueError con un mensaje en español. Obligatorias: horizontal y cuadrada. El logo cuadrado solo es obligatorio si la campaña no usa Brand Guidelines."""
    if not isinstance(images, dict):
        images = {}
    out, total_bytes = [], 0
    for kind, (field, ratio, minimum, label, required) in PMAX_IMAGE_KINDS.items():
        items = images.get(kind) or []
        if not isinstance(items, list):
            raise ValueError("Las imágenes llegaron en un formato inválido.")
        if required and not items:
            raise ValueError(f"Falta una imagen obligatoria: {label}.")
        for it in items:
            it = it if isinstance(it, dict) else {}
            name = " ".join(str(it.get("name") or "imagen").split())[:60] or "imagen"
            try:
                raw = base64.b64decode(str(it.get("data") or ""), validate=True)
            except (ValueError, TypeError):
                raise ValueError(f"«{name}» no se pudo leer como imagen.")
            if not raw or len(raw) > PMAX_IMAGE_MAX_BYTES:
                raise ValueError(f"«{name}» pesa más de {PMAX_IMAGE_MAX_BYTES // (1024 * 1024)} MB o está vacía.")
            total_bytes += len(raw)
            info = _image_size(raw)
            if not info:
                raise ValueError(f"«{name}» debe ser PNG o JPEG.")
            _fmt, w, h = info
            if w < minimum[0] or h < minimum[1]:
                raise ValueError(f"«{name}» mide {w}×{h}: para «{label}» se necesita al menos {minimum[0]}×{minimum[1]}.")
            if abs((w / h) / ratio - 1) > PMAX_RATIO_TOLERANCE:
                raise ValueError(f"«{name}» mide {w}×{h}: no tiene la proporción de «{label}».")
            out.append({"kind": kind, "field": field, "name": name, "data": base64.b64encode(raw).decode("ascii")})
    marketing = sum(1 for x in out if x["kind"] in ("landscape", "square", "portrait"))
    if marketing > PMAX_MAX_MARKETING_IMAGES:
        raise ValueError(f"Máximo {PMAX_MAX_MARKETING_IMAGES} imágenes (horizontales, cuadradas y verticales juntas).")
    if sum(1 for x in out if x["kind"] == "logo") > PMAX_MAX_LOGOS or sum(1 for x in out if x["kind"] == "logo_wide") > PMAX_MAX_LOGOS:
        raise ValueError(f"Máximo {PMAX_MAX_LOGOS} logos de cada tipo.")
    if total_bytes > PMAX_IMAGE_TOTAL_MAX_BYTES:
        raise ValueError(f"Las imágenes pesan más de {PMAX_IMAGE_TOTAL_MAX_BYTES // (1024 * 1024)} MB en total.")
    return out


def parse_youtube_id(value):
    """ID de 11 caracteres de un video de YouTube a partir de un enlace o del ID suelto; lanza ValueError si no se reconoce."""
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
        return text
    try:
        parts = urllib.parse.urlsplit(text if "//" in text else "https://" + text)
    except ValueError:
        parts = None
    host = (parts.hostname or "").lower() if parts else ""
    vid = ""
    if host in ("youtu.be", "www.youtu.be") and parts:
        vid = parts.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com") and parts:
        segs = [x for x in parts.path.split("/") if x]
        if segs and segs[0] in ("shorts", "embed", "live", "v") and len(segs) > 1:
            vid = segs[1]
        else:
            vid = (urllib.parse.parse_qs(parts.query).get("v") or [""])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
        raise ValueError(f"«{text[:60]}» no es un enlace de YouTube válido.")
    return vid


def clean_pmax_videos(values):
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError("Los videos llegaron en un formato inválido.")
    ids = []
    for v in values:
        if not str(v or "").strip():
            continue
        vid = parse_youtube_id(v)
        if vid not in ids:
            ids.append(vid)
    if len(ids) > PMAX_MAX_VIDEOS:
        raise ValueError(f"Máximo {PMAX_MAX_VIDEOS} videos.")
    return ids


def clean_pmax_texts(name, business_name, headlines, long_headlines, descriptions):
    """Valida los textos ya armados de un grupo de recursos. Devuelve (nombre, nombre del negocio, títulos, títulos
    largos, descripciones) o lanza ValueError con un mensaje en español."""
    def _list(items, kind, maxlen, rng, noun):
        if not isinstance(items, list):
            raise ValueError(f"Faltan los {kind}.")
        out, seen = [], set()
        for raw in items:
            text = " ".join(str(raw or "").split())
            if not text:
                continue
            if len(text) > maxlen:
                raise ValueError(f"{noun} pasa de {maxlen} caracteres: «{text[:40]}…».")
            if any(ord(ch) < 32 for ch in text):
                raise ValueError(f"{noun} trae caracteres no permitidos.")
            if text.lower() in seen:
                raise ValueError(f"Hay textos repetidos en {kind}: «{text[:40]}».")
            seen.add(text.lower())
            out.append(text)
        if len(out) < rng[0] or len(out) > rng[1]:
            raise ValueError(f"Se necesitan entre {rng[0]} y {rng[1]} {kind} (hay {len(out)}).")
        return out
    gname = " ".join(str(name or "").split())
    if not gname or len(gname) > PMAX_GROUP_NAME_MAX:
        raise ValueError(f"El nombre del grupo de recursos es obligatorio y admite hasta {PMAX_GROUP_NAME_MAX} caracteres.")
    biz = " ".join(str(business_name or "").split())
    if len(biz) > PMAX_BUSINESS_NAME_MAX:
        raise ValueError(f"El nombre del negocio admite hasta {PMAX_BUSINESS_NAME_MAX} caracteres.")
    heads = _list(headlines, "títulos", PMAX_HEADLINE_MAX, PMAX_HEADLINES_RANGE, "Un título")
    longs = _list(long_headlines, "títulos largos", PMAX_LONG_HEADLINE_MAX, PMAX_LONG_HEADLINES_RANGE, "Un título largo")
    descs = _list(descriptions, "descripciones", PMAX_DESCRIPTION_MAX, PMAX_DESCRIPTIONS_RANGE, "Una descripción")
    if not any(len(d) <= PMAX_SHORT_DESCRIPTION_MAX for d in descs):
        raise ValueError(f"Al menos una descripción debe tener {PMAX_SHORT_DESCRIPTION_MAX} caracteres o menos.")
    return gname, biz, heads, longs, descs


def fetch_pmax_campaigns(customer_id):
    """Campañas Performance Max ACTIVAS de la cuenta, cada una con la URL de sus grupos de recursos (la más usada entre los
    activos) y los nombres de los grupos que ya tiene (para no repetir el nombre)."""
    camps = _search(customer_id, """
        SELECT campaign.id, campaign.name, campaign.brand_guidelines_enabled
        FROM campaign
        WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND campaign.status = 'ENABLED'
    """)
    groups = _search(customer_id, """
        SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.final_urls
        FROM asset_group
        WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND campaign.status = 'ENABLED' AND asset_group.status != 'REMOVED'
    """)
    return _build_pmax_campaigns(
        [((r.get("campaign") or {}).get("id"), (r.get("campaign") or {}).get("name"), bool((r.get("campaign") or {}).get("brandGuidelinesEnabled"))) for r in camps],
        [(str((r.get("campaign") or {}).get("id")), (r.get("assetGroup") or {}).get("name") or "", (r.get("assetGroup") or {}).get("status") or "",
          list((r.get("assetGroup") or {}).get("finalUrls") or [])) for r in groups])


def _build_pmax_campaigns(camps, groups):
    by = {}
    for cid, name, brand in camps:
        by[str(cid)] = {"id": str(cid), "name": name or f"Campaña {cid}", "brand_guidelines": bool(brand), "asset_group_names": [], "_urls": Counter(), "_urls_enabled": Counter()}
    for cid, gname, gstatus, urls in groups:
        c = by.get(str(cid))
        if not c:
            continue
        c["asset_group_names"].append(gname)
        for u in urls[:1]:
            c["_urls"][u] += 1
            if gstatus == "ENABLED":
                c["_urls_enabled"][u] += 1
    out, hosts = [], Counter()
    for c in by.values():
        pool = c.pop("_urls_enabled") or c["_urls"]
        c.pop("_urls", None)
        c["url"] = pool.most_common(1)[0][0] if pool else ""
        if c["url"] and url_host(c["url"]):
            hosts[url_host(c["url"])] += 1
        out.append(c)
    out.sort(key=lambda c: c["name"].lower())
    return {"campaigns": out, "hosts": sorted(hosts)}


def _check_pmax_target(campaigns, campaign_id, group_name, business_name="", images=()):
    """La campaña elegida y su URL, o ValueError con el motivo."""
    camp = next((c for c in campaigns if c["id"] == str(campaign_id)), None)
    if not camp:
        raise ValueError("La campaña ya no está activa o ya no es de Performance Max.")
    if not camp["url"]:
        raise ValueError("La campaña no tiene grupos de recursos de los que tomar la URL final.")
    if group_name.lower() in {n.lower() for n in camp["asset_group_names"]}:
        raise ValueError("Ya existe un grupo de recursos con ese nombre en la campaña.")
    if not camp.get("brand_guidelines") and (not business_name or not any(i["kind"] == "logo" for i in images)):
        raise ValueError("Esta campaña no usa Brand Guidelines: el grupo necesita el nombre del negocio y un logo cuadrado.")
    return camp


def _pmax_operations(customer_id, campaign_id, name, url, business_name, heads, longs, descs, images, video_ids, brand_guidelines=False):
    """Operaciones de UNA petición `googleAds:mutate`: recursos con ID temporal negativo, el grupo y los vínculos."""
    ops, next_id = [], [0]

    def tmp(kind):
        next_id[0] -= 1
        return f"customers/{customer_id}/{kind}/{next_id[0]}"
    ag = tmp("assetGroups")
    links = []
    text_assets = {}

    def text_asset(text):
        if text not in text_assets:
            rn = tmp("assets")
            text_assets[text] = rn
            ops.append({"assetOperation": {"create": {"resourceName": rn, "textAsset": {"text": text}}}})
        return text_assets[text]
    ops.append({"assetGroupOperation": {"create": {"resourceName": ag, "campaign": f"customers/{customer_id}/campaigns/{campaign_id}",
                                                   "name": name, "finalUrls": [url], "status": "PAUSED"}}})
    # Con Brand Guidelines, el nombre del negocio y los logos viven en la campaña: el grupo no los vincula.
    groups = [("HEADLINE", heads), ("LONG_HEADLINE", longs), ("DESCRIPTION", descs)]
    if not brand_guidelines:
        groups.append(("BUSINESS_NAME", [business_name]))
    for field, texts in groups:
        for t in texts:
            links.append((field, text_asset(t)))
    for n, img in enumerate(images, 1):
        if brand_guidelines and img["field"] in ("LOGO", "LANDSCAPE_LOGO"):
            continue
        rn = tmp("assets")
        ops.append({"assetOperation": {"create": {"resourceName": rn, "name": f"{name} · {img['kind']} {n}"[:120], "imageAsset": {"data": img["data"]}}}})
        links.append((img["field"], rn))
    for vid in video_ids:
        rn = tmp("assets")
        ops.append({"assetOperation": {"create": {"resourceName": rn, "youtubeVideoAsset": {"youtubeVideoId": vid}}}})
        links.append(("YOUTUBE_VIDEO", rn))
    for field, rn in links:
        ops.append({"assetGroupAssetOperation": {"create": {"assetGroup": ag, "asset": rn, "fieldType": field}}})
    return ops


def create_pmax_asset_group(customer_id, campaign_id, name, business_name, heads, longs, descs, images, video_ids, validate_only=True):
    """Crea (o solo valida) un grupo de recursos PAUSADO en una campaña Performance Max activa. Devuelve
    {campaign_id, campaign_name, asset_group_id, url}."""
    camps = fetch_pmax_campaigns(customer_id)["campaigns"]
    camp = _check_pmax_target(camps, campaign_id, name, business_name, images)
    ops = _pmax_operations(customer_id, camp["id"], name, camp["url"], business_name, heads, longs, descs, images, video_ids, camp.get("brand_guidelines", False))
    payload = _post_json(f"{BASE_URL}/customers/{customer_id}/googleAds:mutate", {"mutateOperations": ops, "validateOnly": validate_only}, timeout=120)
    group_id = ""
    for r in payload.get("mutateOperationResponses") or []:
        rn = (r.get("assetGroupResult") or {}).get("resourceName", "")
        if rn:
            group_id = rn.rsplit("/", 1)[-1]
    return {"campaign_id": camp["id"], "campaign_name": camp["name"], "asset_group_id": group_id, "url": camp["url"]}


SIMULATED_PMAX = {
    "1111111111": [("9101", "Estelar Hoteles - CO:es - PMAX", "https://www.estelar-demo.example/reservas", ["Evergreen"]),
                   ("9102", "Estelar Hoteles - Eventos - PMAX", "https://www.estelar-demo.example/eventos", []),
                   ("9103", "Estelar Hoteles - US:en - PMAX", "https://www.estelar-demo.example/en", ["Summer"])],
    "2222222222": [("9201", "Click Clack - ES:es - PMAX", "https://www.clickclack-demo.example/", ["Base"])],
}
_SIMULATED_PMAX_CREATED = {}


def simulated_pmax_campaigns(customer_id):
    spec = SIMULATED_PMAX.get(str(customer_id), [])
    camps = [(cid, name, cid != "9201") for cid, name, _u, _g in spec]
    groups = []
    for cid, _name, url, names in spec:
        for n in names:
            groups.append((cid, n, "ENABLED", [url]))
        for n in _SIMULATED_PMAX_CREATED.get((str(customer_id), cid), []):
            groups.append((cid, n, "PAUSED", [url]))
    out = _build_pmax_campaigns(camps, groups)
    return out


def simulated_create_pmax_asset_group(customer_id, campaign_id, name, business_name, heads, longs, descs, images, video_ids, validate_only=True):
    camps = simulated_pmax_campaigns(customer_id)["campaigns"]
    camp = _check_pmax_target(camps, campaign_id, name, business_name, images)
    if any("rechazar" in t.lower() for t in heads):
        raise RuntimeError("Google Ads API respondió 400: simulado, un título con «rechazar» se rechaza.")
    if not validate_only:
        _SIMULATED_PMAX_CREATED.setdefault((str(customer_id), camp["id"]), []).append(name)
    return {"campaign_id": camp["id"], "campaign_name": camp["name"],
            "asset_group_id": "" if validate_only else f"7{camp['id']}{len(_SIMULATED_PMAX_CREATED[(str(customer_id), camp['id'])]) - 1}", "url": camp["url"]}



# ---------------------------------------------------------------------------
# Performance Max: activar o pausar grupos de recursos que ya existen (los creados con la plataforma y los de siempre).
# Solo grupos de campañas PMax ACTIVAS; el servidor relee en vivo el estado de cada grupo antes de cambiarlo. Los grupos
# de recursos no admiten `partialFailure`, así que cada grupo va en su propia petición (son pocos por cuenta).
# ---------------------------------------------------------------------------
def fetch_pmax_asset_groups(customer_id):
    """Grupos de recursos (no eliminados) de las campañas PMax activas: [{campaign_id, campaign_name, asset_group_id, name, status}]."""
    rows = _search(customer_id, """
        SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.status
        FROM asset_group
        WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND campaign.status = 'ENABLED' AND asset_group.status != 'REMOVED'
        ORDER BY campaign.name, asset_group.name
    """)
    return {"groups": [
        {"campaign_id": str((r.get("campaign") or {}).get("id")), "campaign_name": (r.get("campaign") or {}).get("name") or "",
         "asset_group_id": str((r.get("assetGroup") or {}).get("id")), "name": (r.get("assetGroup") or {}).get("name") or "",
         "status": (r.get("assetGroup") or {}).get("status") or ""} for r in rows]}


def _plan_asset_group_status(live, items, status):
    """Reglas de un cambio de estado de grupos de recursos sobre la lista viva. Devuelve (resultados, índices a enviar).
    `live` = lista de fetch_pmax_asset_groups. Para pausar avisa si la campaña se queda sin grupos activos."""
    if status not in AD_STATUS_VALUES:
        raise ValueError("El estado debe ser ENABLED o PAUSED.")
    by_key = {(g["campaign_id"], g["asset_group_id"]): g for g in live}
    enabled_by_camp = Counter(g["campaign_id"] for g in live if g["status"] == "ENABLED")
    results, idx, seen = [None] * len(items), [], set()
    paused_now = Counter()
    for i, it in enumerate(items):
        key = (str(it["campaign_id"]), str(it["asset_group_id"]))
        row = by_key.get(key)
        if key in seen:
            results[i] = {"ok": False, "error": "El grupo de recursos está repetido.", "skipped": True}
            continue
        seen.add(key)
        if not row:
            results[i] = {"ok": False, "error": "El grupo de recursos ya no existe o su campaña no está activa.", "skipped": True}
            continue
        if row["status"] == status:
            results[i] = {"ok": False, "error": "El grupo de recursos ya está activo." if status == "ENABLED" else "El grupo de recursos ya está pausado.", "skipped": True}
            continue
        res = {"ok": True, "campaign_name": row["campaign_name"], "asset_group_name": row["name"], "old_status": row["status"]}
        if status == "PAUSED":
            paused_now[key[0]] += 1
        results[i] = res
        idx.append(i)
    # Aviso de campaña sin grupos activos: se calcula con lo que se pausa en esta misma tanda.
    for i in idx:
        if status == "PAUSED":
            camp = str(items[i]["campaign_id"])
            if enabled_by_camp[camp] - paused_now[camp] <= 0:
                results[i]["campaign_without_active"] = True
    return results, idx


def _mutate_asset_group_status(customer_id, campaign_id, asset_group_id, status, validate_only):
    url = f"{BASE_URL}/customers/{customer_id}/assetGroups:mutate"
    rn = f"customers/{customer_id}/assetGroups/{asset_group_id}"
    try:
        _post_json(url, {"operations": [{"update": {"resourceName": rn, "status": status}, "updateMask": "status"}], "validateOnly": validate_only})
    except Exception as e:  # noqa: BLE001 — se reporta en ese grupo y no frena a los demás
        return {"ok": False, "error": "Google Ads rechazó el cambio: " + google_error_text(e)}
    return {"ok": True}


def set_asset_groups_status(customer_id, items, status, validate_only=True):
    """Activa o pausa (o solo valida) grupos de recursos. `items` = [{campaign_id, asset_group_id}]. Relee en vivo la lista
    de grupos y su estado. Devuelve una lista alineada con `items`."""
    live = fetch_pmax_asset_groups(customer_id)["groups"]
    results, idx = _plan_asset_group_status(live, items, status)
    for i in idx:
        sent = _mutate_asset_group_status(customer_id, items[i]["campaign_id"], items[i]["asset_group_id"], status, validate_only)
        if not sent["ok"]:
            results[i] = {"ok": False, "error": sent["error"]}
    return results


# Grupos de recursos de ejemplo para el modo simulado (los de siempre, activos, y algunos pausados de temporadas pasadas).
_SIM_AG_BASE = {
    "1111111111": [("9101", "Estelar Hoteles - CO:es - PMAX", "910101", "Evergreen", "ENABLED"), ("9101", "Estelar Hoteles - CO:es - PMAX", "910102", "Alta demanda", "ENABLED"),
                   ("9101", "Estelar Hoteles - CO:es - PMAX", "910103", "Semana Santa", "PAUSED"),
                   ("9102", "Estelar Hoteles - Eventos - PMAX", "910201", "Eventos", "ENABLED")],
    "2222222222": [("9201", "Click Clack - ES:es - PMAX", "920101", "Base", "ENABLED"), ("9201", "Click Clack - ES:es - PMAX", "920102", "Verano", "PAUSED")],
}
_SIM_AG_STATUS = {}


def simulated_pmax_asset_groups(customer_id):
    cid = str(customer_id)
    groups = [{"campaign_id": c, "campaign_name": cn, "asset_group_id": gid, "name": n, "status": _SIM_AG_STATUS.get((cid, gid), st)}
              for c, cn, gid, n, st in _SIM_AG_BASE.get(cid, [])]
    camp_names = {c: cn for c, cn, *_ in _SIM_AG_BASE.get(cid, [])}
    for (ccid, camp), names in _SIMULATED_PMAX_CREATED.items():
        if ccid != cid or camp not in camp_names:
            continue
        for k, n in enumerate(names):
            gid = f"7{camp}{k}"
            groups.append({"campaign_id": camp, "campaign_name": camp_names[camp], "asset_group_id": gid, "name": n, "status": _SIM_AG_STATUS.get((cid, gid), "PAUSED")})
    return {"groups": groups}


def simulated_set_asset_groups_status(customer_id, items, status, validate_only=True):
    live = simulated_pmax_asset_groups(customer_id)["groups"]
    results, idx = _plan_asset_group_status(live, items, status)
    for i in idx:
        name = results[i]["asset_group_name"]
        if "rechazar" in name.lower():
            results[i] = {"ok": False, "error": "Google Ads rechazó el cambio: simulado, un grupo con «rechazar» en el nombre se rechaza."}
        elif not validate_only:
            _SIM_AG_STATUS[(str(customer_id), str(items[i]["asset_group_id"]))] = status
    return results


# ---------------------------------------------------------------------------
# Etiquetar anuncios que ya existen y están activos (para luego pausarlos o activarlos por etiqueta). Solo anuncios
# adaptables ACTIVOS de campañas y grupos activos de búsqueda; no cambia el estado de ningún anuncio.
# ---------------------------------------------------------------------------
def fetch_labelable_ads(customer_id, label):
    """Anuncios adaptables activos de campañas Search activas, con `labeled` = ya llevan la etiqueta."""
    label = clean_ad_label(label)
    rows = _search(customer_id, """
        SELECT ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, campaign.id, campaign.name
        FROM ad_group_ad
        WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status = 'ENABLED'
          AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
    """)
    labeled = {(a["ad_group_id"], a["ad_id"]) for a in _labeled_ads_detail(customer_id, label)}
    ads = []
    for r in rows:
        g, c, aga = r.get("adGroup") or {}, r.get("campaign") or {}, r.get("adGroupAd") or {}
        gid, aid = str(g.get("id")), str((aga.get("ad") or {}).get("id"))
        ads.append({"ad_group_id": gid, "ad_group_name": g.get("name") or "", "ad_id": aid, "status": aga.get("status") or "",
                    "campaign_id": str(c.get("id")), "campaign_name": c.get("name") or "", "active_context": True, "labeled": (gid, aid) in labeled})
    ads.sort(key=lambda x: (x["campaign_name"].lower(), x["ad_group_name"].lower(), x["ad_id"]))
    return {"ads": ads, "rsa_enabled": {}}


def _check_labelable(row):
    if not row:
        raise ValueError("El anuncio ya no está activo o ya no es de una campaña de búsqueda activa.")
    if row["labeled"]:
        raise ValueError("El anuncio ya tiene esa etiqueta.")


LABEL_NEW_NOTE = "La etiqueta todavía no existe en esta cuenta: se creará al aplicar (Google no puede validar ese paso de antemano)."


def add_label_to_ads(customer_id, items, label, validate_only=True):
    """Pone la etiqueta (o solo valida) a anuncios activos que ya existen. `items` = [{ad_group_id, ad_id}]. Relee en vivo.
    Devuelve (lista alineada con `items`, nota de la cuenta)."""
    label = clean_ad_label(label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in fetch_labelable_ads(customer_id, label)["ads"]}
    results = [None] * len(items)
    to_send, idx = [], []
    for i, it in enumerate(items):
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            _check_labelable(row)
        except ValueError as e:
            results[i] = {"ok": False, "error": str(e), "skipped": True}
            continue
        results[i] = {"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]}
        to_send.append(f"customers/{customer_id}/adGroupAds/{key[0]}~{key[1]}")
        idx.append(i)
    note = ""
    if to_send:
        rows = _search(customer_id, f"SELECT label.resource_name FROM label WHERE label.name = '{_gaql_quote(label)}' AND label.status = 'ENABLED'")
        label_rn = ((rows[0].get("label") or {}).get("resourceName", "")) if rows else ""
        if validate_only and not label_rn:
            failed, note = {}, LABEL_NEW_NOTE
        else:
            if not label_rn:
                label_rn = _ensure_label(customer_id, label, "Etiqueta creada desde Paid Media Helper")
            failed = _apply_label(customer_id, label_rn, to_send, validate_only=validate_only)
        for i, rn in zip(idx, to_send):
            if rn in failed:
                results[i] = {"ok": False, "error": "Google Ads rechazó la etiqueta: " + failed[rn]}
    return results, note


# ---------------------------------------------------------------------------
# Eliminar por etiqueta (irreversible). Solo anuncios adaptables PAUSADOS que el servidor vuelve a encontrar con la etiqueta.
# Después, si ya no queda nada con esa etiqueta en la cuenta (ni anuncios, ni campañas, ni grupos, ni palabras clave), se
# elimina también la etiqueta; ante cualquier duda se deja.
# ---------------------------------------------------------------------------
def _check_label_ad_remove(row):
    if row["status"] != "PAUSED":
        raise ValueError("Solo se eliminan anuncios pausados: pausa primero este anuncio.")


def _mutate_ad_remove_batch(customer_id, resources, validate_only):
    """Elimina (o solo valida) anuncios (resource names). Devuelve una lista alineada: {"ok": True} o {"ok": False, "error"}."""
    url = f"{BASE_URL}/customers/{customer_id}/adGroupAds:mutate"
    out = []
    for start in range(0, len(resources), AD_BULK_CHUNK):
        chunk = resources[start:start + AD_BULK_CHUNK]
        ops = [{"remove": rn} for rn in chunk]
        try:
            payload = _post_json(url, {"operations": ops, "partialFailure": True, "validateOnly": validate_only})
        except Exception as e:  # noqa: BLE001 — un lote que falla entero se reporta en cada anuncio del lote
            msg = google_error_text(e)
            out.extend({"ok": False, "error": msg} for _ in chunk)
            continue
        errors = _partial_failure_errors(payload)
        for i in range(len(chunk)):
            out.append({"ok": False, "error": "Google Ads rechazó la eliminación: " + errors[i]} if i in errors else {"ok": True})
    return out


def remove_label_ads(customer_id, items, label, validate_only=True):
    """Elimina (o solo valida) anuncios que llevan la etiqueta. `items` = [{ad_group_id, ad_id}]. Relee en vivo qué anuncios
    llevan la etiqueta y su estado; solo se eliminan los PAUSADOS. Devuelve una lista alineada con `items`."""
    label = clean_ad_label(label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in _labeled_ads_detail(customer_id, label)}
    results = [None] * len(items)
    to_send, idx = [], []
    for i, it in enumerate(items):
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            if not row:
                raise ValueError("El anuncio ya no tiene esa etiqueta o fue eliminado.")
            _check_label_ad_remove(row)
        except ValueError as e:
            results[i] = {"ok": False, "error": str(e), "skipped": True}
            continue
        results[i] = {"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]}
        to_send.append(f"customers/{customer_id}/adGroupAds/{key[0]}~{key[1]}")
        idx.append(i)
    sent = _mutate_ad_remove_batch(customer_id, to_send, validate_only) if to_send else []
    for i, res in zip(idx, sent):
        if not res["ok"]:
            results[i] = {"ok": False, "error": res["error"]}
    return results


def delete_label_if_unused(customer_id, label):
    """Elimina la etiqueta de la cuenta si nada la usa. Devuelve (eliminada, nota): la nota explica por qué se dejó."""
    label = clean_ad_label(label)
    q = _gaql_quote(label)
    try:
        rows = _search(customer_id, f"SELECT label.resource_name FROM label WHERE label.name = '{q}' AND label.status = 'ENABLED'")
        resources = [(r.get("label") or {}).get("resourceName") for r in rows if (r.get("label") or {}).get("resourceName")]
        if not resources:
            return False, "La etiqueta ya no existía."
        in_list = ", ".join("'" + _gaql_quote(rn) + "'" for rn in resources)
        checks = [
            ("anuncios", f"SELECT ad_group_ad.resource_name FROM ad_group_ad_label WHERE label.name = '{q}' AND ad_group_ad.status != 'REMOVED'"),
            ("campañas", f"SELECT campaign.id FROM campaign_label WHERE label.name = '{q}' AND campaign.status != 'REMOVED'"),
            ("grupos de anuncios", f"SELECT ad_group.id FROM ad_group_label WHERE label.name = '{q}' AND ad_group.status != 'REMOVED'"),
            ("palabras clave", f"SELECT ad_group_criterion.resource_name FROM ad_group_criterion_label WHERE label.name = '{q}' AND ad_group_criterion.status != 'REMOVED'"),
            # customer_label no admite filtrar por label.name: se filtra por el recurso de la etiqueta.
            ("la cuenta", f"SELECT customer_label.resource_name FROM customer_label WHERE customer_label.label IN ({in_list})"),
        ]
        for what, gaql in checks:
            if _search(customer_id, gaql):
                return False, f"La etiqueta se dejó: todavía la usan {what}."
        _post_json(f"{BASE_URL}/customers/{customer_id}/labels:mutate", {"operations": [{"remove": rn} for rn in resources]})
        return True, ""
    except Exception as e:  # noqa: BLE001 — los anuncios ya se eliminaron; no poder borrar la etiqueta no debe ocultarlo
        return False, "La etiqueta se dejó: no se pudo comprobar o eliminar (" + google_error_text(e, 120) + ")."


# Estado en memoria del modo simulado: por (cuenta, etiqueta), {id del grupo: {ad_id, status}} de los anuncios creados.
_SIMULATED_LABELED = {}


def simulated_bulk_ad_groups(customer_id, label=""):
    raw = _simulated_ad_targets_raw(customer_id)
    if raw is None:
        return {"campaigns": [], "hosts": []}
    structure, _cost, url_by_group, overall = raw
    rsa = {gid: (SIMULATED_RSA_ENABLED.get(gid, 1 if urls else 0)) for gid, urls in url_by_group.items()}
    labeled = Counter()
    if label:
        for gid in _SIMULATED_LABELED.get((str(customer_id), clean_ad_label(label)), set()):
            labeled[gid] += 1
    return _build_bulk_ad_groups(structure, url_by_group, overall, rsa, labeled)


SIMULATED_RSA_ENABLED = {"5012": 3}


def simulated_create_bulk_responsive_search_ads(customer_id, ads, label, validate_only=True):
    """Misma lógica que create_bulk_responsive_search_ads sin tocar Google (un título con «rechazar» simula un rechazo)."""
    label = clean_ad_label(label)
    raw = _simulated_ad_targets_raw(customer_id)
    structure, url_by_group = (raw[0], raw[2]) if raw else ([], {})
    groups = {r["adGroup"]["id"]: r for r in structure}
    done = _SIMULATED_LABELED.setdefault((str(customer_id), label), {})
    results, seen = [], set()
    for a in ads:
        gid = str(a["ad_group_id"])
        row = groups.get(gid)
        try:
            if not row:
                raise ValueError("El grupo ya no está activo en una campaña Search activa (o no es de esta cuenta).")
            if gid in seen:
                raise ValueError("El grupo se repite en la misma tanda.")
            seen.add(gid)
            url = normalize_final_url(a["final_url"])
            _check_bulk_ad_url(url, url_by_group.get(gid, {}), raw[3] if raw else {}, bool(a.get("custom_url")))
            if SIMULATED_RSA_ENABLED.get(gid, 1 if url_by_group.get(gid) else 0) >= AD_MAX_ENABLED_RSA:
                raise ValueError(f"El grupo ya tiene {AD_MAX_ENABLED_RSA} anuncios adaptables activos.")
            if gid in done:
                raise ValueError("El grupo ya tiene un anuncio con esa etiqueta.")
            if any("rechazar" in t.lower() for t in a["headlines"]):
                raise ValueError("Google Ads rechazó el anuncio: Simulación de rechazo por política.")
        except ValueError as e:
            results.append({"ok": False, "error": str(e)})
            continue
        resource = f"customers/{customer_id}/adGroupAds/{gid}~9{gid[-3:]}0001"
        if not validate_only:
            done[gid] = {"ad_id": resource.split("~")[-1], "status": "PAUSED"}
        results.append({
            "ok": True, "campaign_id": row["campaign"]["id"], "campaign_name": row["campaign"]["name"],
            "ad_group_name": row["adGroup"]["name"], "resource_name": resource if not validate_only else "",
            "ad_id": resource.split("~")[-1] if not validate_only else "", "labeled": not validate_only,
        })
    return results


def _simulated_label_ads_detail(customer_id, label):
    raw = _simulated_ad_targets_raw(customer_id)
    if raw is None:
        return [], {}
    structure, url_by_group = raw[0], raw[2]
    groups = {r["adGroup"]["id"]: r for r in structure}
    out, enabled = [], {}
    for gid, r in groups.items():
        enabled[gid] = SIMULATED_RSA_ENABLED.get(gid, 1 if url_by_group.get(gid) else 0)
    # Los activos de cualquier etiqueta cuentan para el límite del grupo (como en Google Ads).
    for (cid, _lab), by_group in _SIMULATED_LABELED.items():
        if cid != str(customer_id):
            continue
        for gid, info in by_group.items():
            if info["status"] == "ENABLED" and gid in enabled and not info.get("existing"):
                enabled[gid] += 1
    for gid, info in (_SIMULATED_LABELED.get((str(customer_id), label), {}) or {}).items():
        r = groups.get(gid)
        if not r:
            continue
        out.append({"ad_group_id": gid, "ad_group_name": r["adGroup"]["name"], "ad_id": info["ad_id"], "status": info["status"],
                    "campaign_id": r["campaign"]["id"], "campaign_name": r["campaign"]["name"], "active_context": True})
    out.sort(key=lambda x: (x["campaign_name"].lower(), x["ad_group_name"].lower(), x["ad_id"]))
    return out, enabled


SIMULATED_ACCOUNT_TIMEZONES = {"1111111111": "America/Bogota", "2222222222": "Europe/Madrid"}


def simulated_account_timezone(customer_id):
    return SIMULATED_ACCOUNT_TIMEZONES.get(str(customer_id), "America/Bogota")


def simulated_label_ads(customer_id, label):
    ads, enabled = _simulated_label_ads_detail(customer_id, clean_ad_label(label))
    return {"ads": ads, "rsa_enabled": enabled}


def simulated_set_label_ads_status(customer_id, items, label, status, validate_only=True):
    if status not in AD_STATUS_VALUES:
        raise ValueError("El estado debe ser ENABLED o PAUSED.")
    label = clean_ad_label(label)
    ads, enabled = _simulated_label_ads_detail(customer_id, label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in ads}
    planned = Counter()
    results = []
    for it in items:
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            if not row:
                raise ValueError("El anuncio ya no tiene esa etiqueta o fue eliminado.")
            _check_label_ad_change(row, status, enabled.get(key[0], 0), planned[key[0]])
        except ValueError as e:
            results.append({"ok": False, "error": str(e), "skipped": True})
            continue
        if status == "ENABLED":
            planned[key[0]] += 1
        if not validate_only:
            _SIMULATED_LABELED[(str(customer_id), label)][key[0]]["status"] = status
        results.append({"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]})
    return results


def _simulated_labelable_ads(customer_id, label):
    raw = _simulated_ad_targets_raw(customer_id)
    if raw is None:
        return []
    structure, url_by_group = raw[0], raw[2]
    labeled = _SIMULATED_LABELED.get((str(customer_id), label), {}) or {}
    out = []
    for r in structure:
        gid = r["adGroup"]["id"]
        if not url_by_group.get(gid):
            continue
        out.append({"ad_group_id": gid, "ad_group_name": r["adGroup"]["name"], "ad_id": "8" + gid, "status": "ENABLED",
                    "campaign_id": r["campaign"]["id"], "campaign_name": r["campaign"]["name"], "active_context": True, "labeled": gid in labeled})
    out.sort(key=lambda x: (x["campaign_name"].lower(), x["ad_group_name"].lower(), x["ad_id"]))
    return out


def simulated_labelable_ads(customer_id, label):
    return {"ads": _simulated_labelable_ads(customer_id, clean_ad_label(label)), "rsa_enabled": {}}


def simulated_add_label_to_ads(customer_id, items, label, validate_only=True):
    label = clean_ad_label(label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in _simulated_labelable_ads(customer_id, label)}
    results, any_ok = [], False
    for it in items:
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            _check_labelable(row)
        except ValueError as e:
            results.append({"ok": False, "error": str(e), "skipped": True})
            continue
        any_ok = True
        if not validate_only:
            _SIMULATED_LABELED.setdefault((str(customer_id), label), {})[key[0]] = {"ad_id": key[1], "status": "ENABLED", "existing": True}
        results.append({"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]})
    note = LABEL_NEW_NOTE if (validate_only and any_ok and (str(customer_id), label) not in _SIMULATED_LABELED) else ""
    return results, note


def simulated_remove_label_ads(customer_id, items, label, validate_only=True):
    label = clean_ad_label(label)
    ads, _enabled = _simulated_label_ads_detail(customer_id, label)
    live = {(a["ad_group_id"], a["ad_id"]): a for a in ads}
    results = []
    for it in items:
        key = (str(it["ad_group_id"]), str(it["ad_id"]))
        row = live.get(key)
        try:
            if not row:
                raise ValueError("El anuncio ya no tiene esa etiqueta o fue eliminado.")
            _check_label_ad_remove(row)
        except ValueError as e:
            results.append({"ok": False, "error": str(e), "skipped": True})
            continue
        if not validate_only:
            _SIMULATED_LABELED[(str(customer_id), label)].pop(key[0], None)
        results.append({"ok": True, "campaign_name": row["campaign_name"], "ad_group_name": row["ad_group_name"], "ad_id": key[1], "old_status": row["status"]})
    return results


def simulated_delete_label_if_unused(customer_id, label):
    label = clean_ad_label(label)
    if _SIMULATED_LABELED.get((str(customer_id), label)):
        return False, "La etiqueta se dejó: todavía la usan anuncios."
    _SIMULATED_LABELED.pop((str(customer_id), label), None)
    return True, ""


RECOMMENDATION_SUBSCRIPTION_STATUS_VALUES = ("ENABLED", "PAUSED")


def update_recommendation_subscriptions(customer_id, types, status, validate_only=True):
    """Pausa o reactiva recomendaciones automáticas de la cuenta (las «Aplicar automáticamente» de Google Ads).
    Cada tipo es una suscripción (`recommendation_subscription`) y su estado es ENABLED o PAUSED; el tipo no cambia.
    Solo se cambia el estado: no se crean ni se eliminan suscripciones. validate_only=True: Google valida sin aplicar."""
    if status not in RECOMMENDATION_SUBSCRIPTION_STATUS_VALUES:
        raise ValueError("El estado debe ser ENABLED o PAUSED.")
    types = list(dict.fromkeys(types or []))
    if not types:
        raise ValueError("Elige al menos un tipo de recomendación.")
    url = f"{BASE_URL}/customers/{customer_id}/recommendationSubscriptions:mutateRecommendationSubscription"
    body = {
        "operations": [{
            "update": {"resourceName": f"customers/{customer_id}/recommendationSubscriptions/{t}", "status": status},
            "updateMask": "status",
        } for t in types],
        "validateOnly": validate_only,
    }
    _post_json(url, body)
    return {"validate_only": validate_only, "applied": not validate_only, "status": status, "types": types}


def simulated_update_recommendation_subscriptions(types, status, validate_only=True):
    return {"validate_only": validate_only, "applied": not validate_only, "status": status, "types": list(dict.fromkeys(types or [])), "simulated": True}


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
               campaign.ai_max_setting.bundling_required,
               campaign.asset_automation_settings
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
            # Textos automáticos y expansión de URL: Google los deja apagados (OPTED_OUT) en Search
            # salvo que alguien los prenda. None = la API no devolvió el ajuste.
            "text_customization": _asset_automation_status(campaign, "TEXT_ASSET_AUTOMATION"),
            "final_url_expansion": _asset_automation_status(campaign, "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION"),
        })
    return rows


def _asset_automation_status(campaign, automation_type):
    for item in campaign.get("assetAutomationSettings") or []:
        if item.get("assetAutomationType") == automation_type:
            return item.get("assetAutomationStatus") or None
    return None


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


# ---------------------------------------------------------------------------
# Lo que creó IA Max — tres reportes de solo lectura, verificados contra una cuenta real con IA Max
# activo (Estelar Yopal, 2026-10-20): recursos creados automáticamente, combinaciones término + página
# + titular, y páginas a las que mandó el tráfico (expansión de URL).
# ---------------------------------------------------------------------------

def _ai_max_date_range(days):
    days = days if days in (7, 14, 30) else 30
    today = datetime.date.today()
    return (today - datetime.timedelta(days=days)).isoformat(), today.isoformat()


def _clean_landing_url(url):
    """Quita parámetros de seguimiento (gclid, gad_*, utm_*...) y el fragmento para que la misma página no
    salga repetida cien veces: queda esquema + dominio + ruta."""
    if not url:
        return ""
    parts = urllib.parse.urlsplit(url)
    host = (parts.netloc or "").lower()
    path = parts.path or "/"
    return f"{parts.scheme}://{host}{path}" if host else url.split("?")[0]


def fetch_ai_max_created_assets(customer_id, campaign_id=None, days=30):
    """Recursos que Google creó automáticamente en campañas con IA Max (asset.source = AUTOMATICALLY_CREATED),
    con su rendimiento del periodo. Un recurso puede estar en varios anuncios: se suma por campaña + recurso."""
    date_from, date_to = _ai_max_date_range(days)
    campaign_filter = f"AND campaign.id = {int(campaign_id)}" if campaign_id else ""
    query = f"""
        SELECT campaign.id, campaign.name,
               ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label,
               asset.id, asset.type, asset.text_asset.text,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM ad_group_ad_asset_view
        WHERE asset.source = 'AUTOMATICALLY_CREATED'
          AND campaign.ai_max_setting.enable_ai_max = TRUE
          AND segments.date BETWEEN '{date_from}' AND '{date_to}'
          {campaign_filter}
    """
    grouped = {}
    for r in _search(customer_id, query):
        campaign = r.get("campaign", {})
        asset = r.get("asset", {})
        view = r.get("adGroupAdAssetView", {})
        metrics = r.get("metrics", {})
        key = (str(campaign.get("id")), str(asset.get("id")), view.get("fieldType"))
        row = grouped.setdefault(key, {
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "asset_id": str(asset.get("id")) if asset.get("id") is not None else None,
            "asset_type": asset.get("type") or "UNKNOWN",
            "field_type": view.get("fieldType") or "UNKNOWN",
            "text": (asset.get("textAsset") or {}).get("text"),
            "performance_label": view.get("performanceLabel") or "UNSPECIFIED",
            "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0,
        })
        row["impressions"] += _int_or_none(metrics.get("impressions")) or 0
        row["clicks"] += _int_or_none(metrics.get("clicks")) or 0
        row["cost"] += _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0
        row["conversions"] += _float_or_none(metrics.get("conversions")) or 0
    return sorted(grouped.values(), key=lambda x: (x["impressions"], x["clicks"]), reverse=True)


def fetch_ai_max_combinations(customer_id, campaign_id=None, days=30, limit=500):
    """Qué titular dinámico y qué página usó IA Max para cada búsqueda
    (ai_max_search_term_ad_combination_view). OJO: sin `segments.date` esta vista devuelve 0 filas, y es la
    única segmentación que acepta. Se suma por (campaña, término, página, titular)."""
    date_from, date_to = _ai_max_date_range(days)
    campaign_filter = f"AND campaign.id = {int(campaign_id)}" if campaign_id else ""
    query = f"""
        SELECT campaign.id, campaign.name, segments.date,
               ai_max_search_term_ad_combination_view.search_term,
               ai_max_search_term_ad_combination_view.landing_page,
               ai_max_search_term_ad_combination_view.headline,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM ai_max_search_term_ad_combination_view
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
          {campaign_filter}
    """
    grouped = {}
    for r in _search(customer_id, query):
        campaign = r.get("campaign", {})
        view = r.get("aiMaxSearchTermAdCombinationView", {})
        metrics = r.get("metrics", {})
        landing = _clean_landing_url(view.get("landingPage"))
        key = (str(campaign.get("id")), view.get("searchTerm"), landing, view.get("headline"))
        row = grouped.setdefault(key, {
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "search_term": view.get("searchTerm") or "",
            "landing_page": landing,
            "headline": view.get("headline") or "",
            "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0,
        })
        row["impressions"] += _int_or_none(metrics.get("impressions")) or 0
        row["clicks"] += _int_or_none(metrics.get("clicks")) or 0
        row["cost"] += _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0
        row["conversions"] += _float_or_none(metrics.get("conversions")) or 0
    rows = sorted(grouped.values(), key=lambda x: (x["cost"], x["impressions"]), reverse=True)
    return rows[:limit], len(rows)


def fetch_ai_max_landing_pages(customer_id, campaign_id=None, days=30, limit=200, date_from=None, date_to=None):
    """Páginas a las que IA Max mandó el tráfico con la expansión de URL (expanded_landing_page_view).
    Las URL traen parámetros de seguimiento distintos en cada clic: se agrupan por esquema + dominio + ruta.
    date_from/date_to (la auditoría) mandan sobre `days`."""
    if not (date_from and date_to):
        date_from, date_to = _ai_max_date_range(days)
    campaign_filter = f"AND campaign.id = {int(campaign_id)}" if campaign_id else ""
    query = f"""
        SELECT campaign.id, campaign.name, campaign.ai_max_setting.enable_ai_max,
               expanded_landing_page_view.expanded_final_url,
               metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM expanded_landing_page_view
        WHERE campaign.ai_max_setting.enable_ai_max = TRUE
          AND segments.date BETWEEN '{date_from}' AND '{date_to}'
          {campaign_filter}
    """
    grouped = {}
    for r in _search(customer_id, query):
        campaign = r.get("campaign", {})
        metrics = r.get("metrics", {})
        page = _clean_landing_url((r.get("expandedLandingPageView") or {}).get("expandedFinalUrl"))
        key = (str(campaign.get("id")), page)
        row = grouped.setdefault(key, {
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "page": page,
            "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0,
        })
        row["impressions"] += _int_or_none(metrics.get("impressions")) or 0
        row["clicks"] += _int_or_none(metrics.get("clicks")) or 0
        row["cost"] += _micros_to_units(_int_or_none(metrics.get("costMicros"))) or 0
        row["conversions"] += _float_or_none(metrics.get("conversions")) or 0
    rows = sorted(grouped.values(), key=lambda x: (x["cost"], x["impressions"]), reverse=True)
    return rows[:limit], len(rows)


# ---------------------------------------------------------------------------
# Exclusiones de páginas para AI Max (URL exclusions) — criterios WEBPAGE negativos a nivel de campaña.
# Verificado con Google (validateOnly, campaña real con AI Max, 2026-10-22): acepta "URL igual a una
# dirección completa" y "URL contiene un texto"; rechaza una ruta sin dominio. Solo tienen efecto con AI Max,
# textos automáticos y expansión de URL prendidos, y Google no deja excluir la página de destino del anuncio.
# Las condiciones no se editan: para cambiar una exclusión se quita y se vuelve a crear.
# ---------------------------------------------------------------------------

URL_EXCLUSION_MAX_LEN = 500


def normalize_url_exclusion(mode, value):
    """Devuelve (mode, value) limpio o lanza ValueError con un mensaje en español. mode: 'equals' | 'contains'.
    Rechaza reglas tan amplias que sacarían casi todo el sitio ("/", "es", el dominio solo...)."""
    mode = (mode or "").strip().lower()
    if mode not in ("equals", "contains"):
        raise ValueError("El tipo debe ser 'exacta' o 'contiene'.")
    value = (value or "").strip().strip("\"'").strip()
    if "#" in value:
        value = value.split("#", 1)[0]
    if not value:
        raise ValueError("La página está vacía.")
    if any(ch.isspace() for ch in value):
        raise ValueError("La dirección no puede tener espacios.")
    if len(value) > URL_EXCLUSION_MAX_LEN:
        raise ValueError(f"La dirección supera los {URL_EXCLUSION_MAX_LEN} caracteres.")
    if mode == "equals":
        parts = urllib.parse.urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.netloc or "." not in parts.netloc:
            raise ValueError("Para una página exacta usa la dirección completa, con http:// o https:// y el dominio.")
        return mode, value
    # contiene
    bare = value.split("://", 1)[-1]
    core = bare.strip("/")
    if len(core) < 4:
        raise ValueError("El texto es demasiado corto: excluiría casi todo el sitio. Usa al menos 4 caracteres, por ejemplo /fotos/.")
    if "/" not in core and "." in core:
        raise ValueError("Eso es solo el dominio: excluiría todo el sitio. Agrega la parte de la página, por ejemplo /fotos/.")
    first = core.split("/", 1)[0]
    path = core.split("/", 1)[1] if "." in first and "/" in core else core
    if len(path.strip("/")) < 4:
        raise ValueError("Esa ruta es demasiado corta (por ejemplo /es/): excluiría casi todo el sitio. Usa una página concreta, como /fotos/.")
    return mode, value


def fetch_ai_max_url_exclusions(customer_id):
    """Exclusiones de página (WEBPAGE negativo) que ya existen en las campañas de la cuenta."""
    query = """
        SELECT campaign.id, campaign.name,
               campaign_criterion.resource_name, campaign_criterion.criterion_id,
               campaign_criterion.webpage.criterion_name, campaign_criterion.webpage.conditions
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'WEBPAGE' AND campaign_criterion.negative = TRUE
    """
    rows = []
    for r in _search(customer_id, query):
        campaign = r.get("campaign", {})
        crit = r.get("campaignCriterion", {})
        webpage = crit.get("webpage", {})
        conds = webpage.get("conditions") or []
        url_conds = [c for c in conds if c.get("operand") == "URL"]
        first = (url_conds or conds or [{}])[0]
        operator = first.get("operator")
        rows.append({
            "campaign_id": str(campaign.get("id")) if campaign.get("id") is not None else None,
            "campaign_name": campaign.get("name") or "(sin nombre)",
            "resource_name": crit.get("resourceName"),
            "criterion_id": str(crit.get("criterionId")) if crit.get("criterionId") is not None else None,
            "name": webpage.get("criterionName") or "",
            "mode": "equals" if operator == "EQUALS" else "contains" if operator == "CONTAINS" else "other",
            "value": first.get("argument") or "",
            "conditions": len(conds),
        })
    return sorted(rows, key=lambda x: (x["campaign_name"], x["value"]))


def push_ai_max_url_exclusions(customer_id, items, validate_only=True):
    """Crea exclusiones de página. items: [{campaign_id, mode, value}], ya normalizados.
    validate_only=True: Google valida sin escribir. Usa partialFailure: una regla inválida no tumba las demás."""
    if not items:
        return {"created": 0, "failed": [], "validate_only": validate_only}
    operations = []
    for item in items:
        operator = "EQUALS" if item["mode"] == "equals" else "CONTAINS"
        operations.append({"create": {
            "campaign": f"customers/{customer_id}/campaigns/{item['campaign_id']}",
            "negative": True,
            "webpage": {
                "criterionName": f"Excluir ({'exacta' if item['mode'] == 'equals' else 'contiene'}): {item['value']}"[:250],
                "conditions": [{"operand": "URL", "operator": operator, "argument": item["value"]}],
            },
        }})
    payload = _mutate_with_partial_failure(f"{BASE_URL}/customers/{customer_id}/campaignCriteria:mutate", operations, validate_only)
    failed_indices, failed_messages = _partial_failures(payload, items, lambda it: f"\"{it['value']}\"")
    return {"created": len(items) - len(failed_indices), "failed": failed_messages, "validate_only": validate_only}


def remove_ai_max_url_exclusions(customer_id, resource_names, validate_only=True):
    """Quita exclusiones de página por su resource_name (customers/ID/campaignCriteria/CAMPAÑA~CRITERIO)."""
    import re as _re
    pattern = _re.compile(rf"^customers/{_re.escape(str(customer_id))}/campaignCriteria/\d+~\d+$")
    clean = [rn for rn in resource_names if isinstance(rn, str) and pattern.match(rn)]
    if len(clean) != len(resource_names):
        raise ValueError("Alguna exclusión a quitar no es válida para esta cuenta.")
    if not clean:
        return {"removed": 0, "validate_only": validate_only}
    payload = _mutate_with_partial_failure(f"{BASE_URL}/customers/{customer_id}/campaignCriteria:mutate", [{"remove": rn} for rn in clean], validate_only)
    failed_indices, failed_messages = _partial_failures(payload, clean, lambda rn: rn.rsplit("/", 1)[-1])
    return {"removed": len(clean) - len(failed_indices), "failed": failed_messages, "validate_only": validate_only}


def _mutate_with_partial_failure(url, operations, validate_only):
    body = {"operations": operations, "partialFailure": True, "validateOnly": validate_only}
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Ads API respondió {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"No se pudo conectar a la API de Google Ads: {e.reason}") from e


def _partial_failures(payload, items, label):
    failed_indices, messages = set(), []
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
                    messages.append(f"{label(items[idx])}: {message}")
                else:
                    messages.append(message)
    return failed_indices, messages


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


def fetch_negative_keyword_sources(customer_id):
    """Todas las negativas de palabra clave que afectan a las campañas de la cuenta, por origen:
      - "campaign": las puestas directo en cada campaña (fetch_account_negative_keywords);
      - "lists": listas compartidas de negativas (SharedSet NEGATIVE_KEYWORDS) con sus palabras y las
        campañas a las que están enlazadas; si la lista también está enlazada a la cuenta (negativas de
        nivel cuenta, CustomerNegativeCriterion NEGATIVE_KEYWORD_LIST), `account` es True y aplica a todas.
    Las negativas de cuenta no existen como palabra suelta en la API: solo como listas enlazadas, y esas
    listas son de otro tipo (ACCOUNT_LEVEL_NEGATIVE_KEYWORDS), no NEGATIVE_KEYWORDS.
    Verificado contra cuentas reales (2026-11-05): 64 de 120 cuentas usan listas enlazadas a campañas; 3 de
    150 tenían además una lista a nivel cuenta. Cada origen que falle
    se reporta en "errores" sin tumbar los demás."""
    sources = {"campaign": [], "lists": [], "errores": []}
    try:
        sources["campaign"] = fetch_account_negative_keywords(customer_id)
    except RuntimeError as e:
        sources["errores"].append(f"campañas: {' '.join(str(e).split())[:120]}")
    by_list = {}
    try:
        for r in _search(customer_id, """
            SELECT campaign.id, shared_set.id, shared_set.name
            FROM campaign_shared_set
            WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'
              AND campaign_shared_set.status = 'ENABLED'
        """):
            sid = str(r.get("sharedSet", {}).get("id"))
            entry = by_list.setdefault(sid, {"id": sid, "name": r.get("sharedSet", {}).get("name") or sid,
                                              "campaign_ids": [], "keywords": [], "account": False})
            if r.get("campaign", {}).get("id") is not None:
                entry["campaign_ids"].append(str(r["campaign"]["id"]))
    except RuntimeError as e:
        sources["errores"].append(f"listas enlazadas a campañas: {' '.join(str(e).split())[:120]}")
    try:
        for r in _search(customer_id, """
            SELECT customer_negative_criterion.negative_keyword_list.shared_set
            FROM customer_negative_criterion
            WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'
        """):
            ref = (r.get("customerNegativeCriterion", {}).get("negativeKeywordList", {}) or {}).get("sharedSet") or ""
            sid = ref.rsplit("/", 1)[-1]
            if sid.isdigit():
                by_list.setdefault(sid, {"id": sid, "name": sid, "campaign_ids": [], "keywords": [], "account": False})["account"] = True
    except RuntimeError as e:
        sources["errores"].append(f"listas de la cuenta: {' '.join(str(e).split())[:120]}")
    if by_list:
        try:
            for r in _search(customer_id, """
                SELECT shared_set.id, shared_set.name, shared_criterion.keyword.text, shared_criterion.keyword.match_type
                FROM shared_criterion
                WHERE shared_set.type IN ('NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS')
                  AND shared_criterion.type = 'KEYWORD'
            """):
                sid = str(r.get("sharedSet", {}).get("id"))
                kw = r.get("sharedCriterion", {}).get("keyword", {})
                if sid in by_list and kw.get("text"):
                    by_list[sid]["keywords"].append({"text": kw["text"], "match_type": kw.get("matchType") or "UNKNOWN"})
                    if by_list[sid]["name"] == sid and r.get("sharedSet", {}).get("name"):
                        by_list[sid]["name"] = r["sharedSet"]["name"]
        except RuntimeError as e:
            sources["errores"].append(f"palabras de las listas: {' '.join(str(e).split())[:120]}")
    sources["lists"] = list(by_list.values())
    return sources


def fetch_positive_keywords(customer_id, limit=60000):
    """Palabras clave positivas ACTIVAS (campaña, grupo de anuncios y palabra activos) de la cuenta, para
    comprobar que una negativa propuesta no bloquea tus propias palabras clave (lo que Google llama
    "conflicto de palabras clave negativas"). Solo Search tiene palabras clave; PMax no."""
    query = f"""
        SELECT campaign.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = false
          AND ad_group_criterion.status = 'ENABLED'
          AND ad_group.status = 'ENABLED'
          AND campaign.status = 'ENABLED'
        LIMIT {int(limit)}
    """
    rows = []
    for r in _search(customer_id, query):
        kw = r.get("adGroupCriterion", {}).get("keyword", {})
        if kw.get("text") and r.get("campaign", {}).get("id") is not None:
            rows.append({"campaign_id": str(r["campaign"]["id"]), "text": kw["text"], "match_type": kw.get("matchType") or "UNKNOWN"})
    return rows


def push_negative_keywords(customer_id, items, validate_only=True):
    """Sube palabras clave negativas a nivel de campaña (concordancia exacta
    por defecto; "match_type": "PHRASE" en el item la pasa a frase).
    items: lista de {"campaign_id": ..., "term": ..., "match_type"?: ...}.

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
            "keyword": {"text": item["term"], "matchType": item.get("match_type") if item.get("match_type") in ("EXACT", "PHRASE") else "EXACT"},
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
    result = {"created": created, "failed": failed_messages, "validate_only": validate_only}
    if not validate_only:
        # Con partialFailure, "results" trae una entrada por operación (vacía si esa falló): de ahí sale el
        # resource_name de cada negativa creada, que se guarda para poder deshacer la subida.
        results = payload.get("results") or []
        created_items = []
        for idx, item in enumerate(items):
            rn = (results[idx] or {}).get("resourceName") if idx < len(results) and isinstance(results[idx], dict) else None
            if rn and idx not in failed_indices:
                created_items.append({
                    "campaign_id": str(item["campaign_id"]), "campaign_name": item.get("campaign_name") or "",
                    "term": item["term"], "match_type": item.get("match_type") if item.get("match_type") in ("EXACT", "PHRASE") else "EXACT",
                    "resource_name": rn,
                })
        result["created_items"] = created_items
    return result


def remove_campaign_negative_keywords(customer_id, resource_names, validate_only=True):
    """Quita negativas de campaña por su resource_name (customers/ID/campaignCriteria/CAMPAÑA~CRITERIO), para
    deshacer una subida. Devuelve cuáles se quitaron (`removed_names`) y los fallos."""
    import re as _re
    pattern = _re.compile(rf"^customers/{_re.escape(str(customer_id))}/campaignCriteria/\d+~\d+$")
    clean = [rn for rn in resource_names if isinstance(rn, str) and pattern.match(rn)]
    if len(clean) != len(resource_names):
        raise ValueError("Alguna negativa a quitar no es válida para esta cuenta.")
    if not clean:
        return {"removed": 0, "removed_names": [], "failed": [], "validate_only": validate_only}
    payload = _mutate_with_partial_failure(f"{BASE_URL}/customers/{customer_id}/campaignCriteria:mutate", [{"remove": rn} for rn in clean], validate_only)
    failed_indices, failed_messages = _partial_failures(payload, clean, lambda rn: rn.rsplit("/", 1)[-1])
    removed_names = [rn for i, rn in enumerate(clean) if i not in failed_indices]
    return {"removed": len(removed_names), "removed_names": removed_names, "failed": list(dict.fromkeys(failed_messages)), "validate_only": validate_only}


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


def _post_json(url, body, timeout=None):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=_auth_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or TIMEOUT_SECONDS) as resp:
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

SIMULATED_AD_STRUCTURE = {
    "1111111111": {
        "structure": [
            ("501", "Estelar Hoteles - CO:es - Search Marca", "5011", "Marca exacta", 8520000000, "https://www.estelar-demo.example/reservas"),
            ("501", "Estelar Hoteles - CO:es - Search Marca", "5012", "Marca + hotel", 2100000000, "https://www.estelar-demo.example/reservas"),
            ("502", "Estelar Hoteles - CO:es - Search Genérica", "5021", "Hoteles baratos", 14640000000, "https://www.estelar-demo.example/ofertas"),
            ("503", "Estelar Hoteles - UK:en - Search Marca", "5031", "Brand exact", 1200000000, "https://www.estelar-demo.example/en/book"),
        ],
    },
    "2222222222": {
        "structure": [
            ("601", "Click Clack - Search Marca", "6011", "Marca", 3200000000, "https://clickclack-demo.example/"),
            ("602", "Click Clack - Search Eventos", "6021", "Eventos y reuniones", 900000000, ""),
        ],
    },
}


def _simulated_ad_targets_raw(customer_id):
    spec = SIMULATED_AD_STRUCTURE.get(str(customer_id))
    if not spec:
        return None
    structure, cost_by_group, url_by_group, overall = [], {}, {}, Counter()
    for camp_id, camp_name, gid, gname, cost_micros, url in spec["structure"]:
        structure.append({"campaign": {"id": camp_id, "name": camp_name}, "adGroup": {"id": gid, "name": gname}})
        cost_by_group[gid] = cost_micros
        if url:
            url_by_group[gid] = Counter({url: 2})
            overall[url] += 2
    return structure, cost_by_group, url_by_group, overall


def simulated_ad_targets(customer_id):
    raw = _simulated_ad_targets_raw(customer_id)
    if raw is None:
        return {"campaigns": [], "urls": [], "default_url": ""}
    return _build_ad_targets(*raw)


def simulated_create_responsive_search_ad(customer_id, ad_group_id, headlines, descriptions, path1, path2, final_url,
                                          url_confirmed=False, validate_only=True, head_pins=None, desc_pins=None):
    """Misma validación que create_responsive_search_ad, sin tocar Google: sirve para probar el flujo en modo simulado."""
    if not str(ad_group_id).isdigit():
        raise ValueError("Falta o es inválido el grupo de anuncios.")
    final_url = normalize_final_url(final_url)
    raw = _simulated_ad_targets_raw(customer_id)
    group = None
    if raw:
        for r in raw[0]:
            if r["adGroup"]["id"] == str(ad_group_id):
                group = r
    if not group:
        raise ValueError("No se encontró el grupo de anuncios en esta cuenta.")
    known = _check_ad_url_rule(final_url, list(raw[3]), url_confirmed)
    if any("rechazar" in t.lower() for t in headlines):
        raise RuntimeError('Google Ads API respondió 400: {"error": {"details": [{"errors": [{"message": "Simulación de rechazo por política."}]}]}}')
    resource = f"customers/{customer_id}/adGroupAds/{ad_group_id}~9{str(ad_group_id)[-3:]}0001"
    return {
        "validate_only": validate_only, "applied": not validate_only, "campaign_id": group["campaign"]["id"],
        "campaign_name": group["campaign"]["name"], "ad_group_name": group["adGroup"]["name"],
        "resource_name": resource if not validate_only else "", "ad_id": resource.split("~")[-1] if not validate_only else "",
        "url_known": known,
    }


SIMULATED_MCC_GROUPS = [{"id": "9999999999", "name": "Estelar Hoteles MCC (simulado)"}]

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


def simulated_account_pacing(customer_id, month_from=None, month_to=None):
    today = datetime.date.today()
    cur = (today.year, today.month)
    preset = _SIMULATED_PACING.get(customer_id)
    if month_from is None or (month_from == cur and month_to == cur):
        days_in_month = calendar.monthrange(today.year, today.month)[1]
        if not preset:
            return {
                "spend_mtd": 0, "monthly_target": None,
                "days_elapsed": today.day, "days_in_month": days_in_month, "is_complete": False,
            }
        return {
            "spend_mtd": round(preset["spend_mtd_per_day"] * today.day, 2),
            "monthly_target": preset["monthly_target"],
            "days_elapsed": today.day,
            "days_in_month": days_in_month,
            "is_complete": False,
        }
    months = list(_month_iter(month_from, month_to))
    spend_by_month, target_by_month = {}, {}
    for y, m in months:
        dim = calendar.monthrange(y, m)[1]
        if not preset:
            spend_by_month[f"{y}-{m:02d}"] = 0
            continue
        if (y, m) == cur:
            spend = preset["spend_mtd_per_day"] * today.day
        else:
            # Variación determinística por mes, para que el selector muestre
            # meses distintos (algunos por arriba del objetivo, otros por debajo).
            spend = preset["spend_mtd_per_day"] * dim * (0.8 + 0.07 * ((y * 12 + m) % 5))
        spend_by_month[f"{y}-{m:02d}"] = round(spend, 2)
        # Un mes de cada 4 sin objetivo en la cuenta 2, para poder ver el
        # caso "objetivo de X de Y meses".
        no_target = customer_id == "2222222222" and (y * 12 + m) % 4 == 0
        target_by_month[(y, m)] = None if no_target else preset["monthly_target"]
    return aggregate_pacing_months(months, spend_by_month, target_by_month, today)


def simulated_account_campaigns_budget(customer_id):
    rows = simulated_campaign_rows(only_active=True)
    out = []
    for c in rows:
        cid = _SIMULATED_CAMPAIGN_IDS_BY_NAME.get(c["campaign"], c["campaign"])
        out.append({
            "campaign_id": cid,
            "campaign_name": c["campaign"],
            "bidding_strategy_type": c["bid_strategy"],
            "target_roas": _SIMULATED_TARGET_ROAS_BY_NAME.get(c["campaign"]),
            "budget_resource_name": f"customers/{customer_id}/campaignBudgets/{cid}",
            "daily_budget": c["budget"],
            "is_shared": False,
            "impressions": c["impressions"],
            "clicks": c["clicks"],
            "ctr": c["ctr"],
            "cost": c["cost"],
            "conversions": c["conversions"],
            "conv_value": c.get("conv_value") or 0,
            "cost_per_conv": c["cost_per_conv"],
        })
    out.sort(key=lambda r: r["cost"], reverse=True)
    return out


def simulated_update_campaign_daily_budget(new_daily_budget, validate_only=True):
    if not new_daily_budget or new_daily_budget <= 0:
        raise ValueError("El presupuesto diario debe ser un número mayor que cero.")
    return {"validate_only": validate_only, "applied": not validate_only, "new_daily_budget": new_daily_budget, "simulated": True}


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
            "text_customization": "OPTED_IN" if entry["enabled"] else "OPTED_OUT",
            "final_url_expansion": "OPTED_IN" if entry["enabled"] else "OPTED_OUT",
        })
    return out


def simulated_account_audiences(date_from=None, date_to=None):
    """Audiencias de ejemplo (la API de Google Ads no está configurada): 10 audiencias en 4 campañas activas."""
    camps = {c["campaign_id"]: c for c in simulated_campaigns_overview()}
    order = ["1111111102", "1111111101", "1111111103", "1111111104"]  # Search marca, Search genérica, PMax, Display remarketing
    # nombre, tipo, subtipo, tamaño búsqueda, tamaño display, gasto, conversiones, CPA % (gasto ÷ valor), matriz por campaña
    spec = [
        ("Abandonaron reserva", "list", "RULE_BASED", 4200, 3100, 868000, 62, 0.08, "OOPS"),
        ("Visitantes 30 días", "list", "RULE_BASED", 12800, 9400, 912000, 48, 0.11, "OOPS"),
        ("Visitantes 180 días", "list", "RULE_BASED", 41000, 30500, 1705000, 55, 0.16, "OOPS"),
        ("Clientes anteriores", "list", "CRM_BASED", 1900, 1500, 462000, 21, 0.13, "O.PN"),
        ("In-market: Hoteles", "in_market", "IN_MARKET", None, None, 2664000, 74, 0.17, ".OPS"),
        ("In-market: Vacaciones", "in_market", "IN_MARKET", None, None, 2378000, 41, 0.27, ".O.."),
        ("Viajeros frecuentes", "affinity", "AFFINITY", None, None, 1332000, 18, 0.38, "..PS"),
        ("Amantes de la playa", "affinity", "AFFINITY", None, None, 864000, 9, 0.52, "...O"),
        ("Búsquedas «hotel medellín»", "custom", None, None, None, 957000, 33, 0.15, ".OP."),
        ("Último minuto", "in_market", "IN_MARKET", None, None, 612000, 12, 0.24, ".O.."),
    ]
    lists, usage, pmax = [], [], []
    for i, (name, kind, sub, ss, sd, cost, conv, cpa, mx) in enumerate(spec):
        cost = cost / 1000  # los importes de la tabla están en miles para leerlos mejor arriba
        key = {"list": f"customers/1111111111/userLists/{900 + i}", "custom": f"customers/1111111111/customAudiences/{700 + i}"}.get(kind, f"customers/1111111111/userInterests/{80000 + i}")
        if kind == "list":
            lists.append({"key": key, "id": str(900 + i), "name": name, "type": sub, "status": "OPEN", "size_search": ss, "size_display": sd, "life_span": 30 if "30" in name else 180})
        cells = [(cid, code) for cid, code in zip(order, mx) if code != "."]
        paid = [(cid, code) for cid, code in cells if code in ("O", "S")]
        # El modo en grupo de anuncios: la última letra se reparte entre observación (O) y segmentación (S).
        for cid, code in cells:
            c = camps[cid]
            base = {"level": "campaign", "campaign_id": cid, "campaign": c["campaign_name"], "campaign_status": c["status"], "channel": c["channel_type"],
                    "ad_group_id": None, "ad_group": "", "key": key, "name": name, "kind": kind, "sub": sub}
            if code == "P":
                pmax.append({"campaign_id": cid, "campaign": c["campaign_name"], "asset_group": "Grupo principal", "key": key, "name": name, "lists": [key] if kind == "list" else []})
                continue
            share = 1 / max(1, len([1 for _, cc in paid]))
            is_neg = code == "N"
            usage.append({**base, "negative": is_neg, "bid_modifier": None if is_neg else (1.2 if (i == 0 and cid == "1111111101") else 1.0),
                          "mode": "targeting" if code == "S" else "observation", "has_metrics": not is_neg,
                          "impressions": 0 if is_neg else int(cost * 9 * share), "clicks": 0 if is_neg else int(cost / 1.8 * share),
                          "cost": 0.0 if is_neg else round(cost * share, 2), "conversions": 0.0 if is_neg else round(conv * share, 2),
                          "conv_value": 0.0 if is_neg else round(cost / cpa * share, 2)})
    # Lista vacía y lista muy pequeña, para que el inventario muestre los avisos.
    lists.append({"key": "customers/1111111111/userLists/950", "id": "950", "name": "Newsletter — suscriptores", "type": "CRM_BASED", "status": "OPEN", "size_search": 0, "size_display": 0, "life_span": 10000})
    lists.append({"key": "customers/1111111111/userLists/951", "id": "951", "name": "Visitantes página de eventos", "type": "RULE_BASED", "status": "OPEN", "size_search": 340, "size_display": 280, "life_span": 30})
    lists.append({"key": "customers/1111111111/userLists/952", "id": "952", "name": "Lista de prueba (cerrada)", "type": "RULE_BASED", "status": "CLOSED", "size_search": 8200, "size_display": 6100, "life_span": 90})
    for i, nm in enumerate(["Similar a Visitantes 30 días", "Similar a Clientes anteriores"]):
        lists.append({"key": f"customers/1111111111/userLists/{960 + i}", "id": str(960 + i), "name": nm, "type": "SIMILAR", "status": "OPEN", "size_search": 0, "size_display": 0, "life_span": 540})
    for l in lists:
        l.setdefault("read_only", l["type"] == "SIMILAR")
    campaigns = [{"id": c["campaign_id"], "name": c["campaign_name"], "status": c["status"], "channel": c["channel_type"]} for c in camps.values()]
    return {"lists": lists, "campaigns": campaigns, "usage": usage, "pmax_signals": pmax, "errors": {}}


def simulated_campaigns_overview():
    out = []
    for c in SIMULATED_CAMPAIGNS:
        out.append({
            "campaign_id": _SIMULATED_CAMPAIGN_IDS_BY_NAME.get(c["campaign"], c["campaign"]),
            "campaign_name": c["campaign"],
            "status": c["status"],
            "channel_type": {"performance max": "PERFORMANCE_MAX", "search": "SEARCH", "display": "DISPLAY"}.get(c["channel_type_raw"], "SEARCH"),
            "budget": c["budget"], "impressions": c["impressions"], "clicks": c["clicks"], "cost": c["cost"],
            "budget_resource_name": f"customers/0/campaignBudgets/{_SIMULATED_CAMPAIGN_IDS_BY_NAME.get(c['campaign'], c['campaign'])}",
            "budget_shared": "Display" in c["campaign"],  # una compartida de ejemplo para probar el bloqueo
            "conversions": c["conversions"], "conv_value": c["conv_value"],
            "bidding_strategy_type": c["bid_strategy"],
            "target_roas": 4.0 if c["bid_strategy"] == "TARGET_ROAS" else None, "target_cpa": None,
            "impr_share": c["impr_share"], "top_impr_share": None if c["impr_share"] is None else round(c["impr_share"] * 0.6, 3),
            "lost_is_budget": c["lost_is_budget"], "lost_is_rank": c["lost_is_rank"],
        })
    return out


def simulated_campaign_windows(customer_id, windows=(7, 14, 30)):
    """Datos de ejemplo de las ventanas de 7, 14 y 30 días: determinista por cuenta y campaña, con ROAS que varía entre
    campañas y entre ventanas para que salgan los distintos veredictos."""
    import zlib
    end = datetime.date.today() - datetime.timedelta(days=1)
    ranges = {str(n): {"from": (end - datetime.timedelta(days=n - 1)).isoformat(), "to": end.isoformat()} for n in windows}
    base = simulated_campaigns_overview()
    out = {}
    for n in windows:
        rows = {}
        for c in base:
            h = zlib.crc32(f"{customer_id}:{c['campaign_id']}".encode())
            quality = 0.55 + (h % 100) / 100 * 1.0            # 0,55 a 1,55: ROAS relativo de la campaña
            drift = {7: 0.8 + ((h >> 8) % 50) / 100, 14: 0.9 + ((h >> 8) % 25) / 100, 30: 1.0}[n]
            cost = c["cost"] * n / 30 * (0.9 + ((h >> 4) % 20) / 100)
            conv_base_roas = (c["conv_value"] / c["cost"]) if c["cost"] else 0
            value = cost * conv_base_roas * quality * drift
            conv = c["conversions"] * n / 30 * quality * drift
            limited = ((h >> 12) % 3) == 0
            rows[str(c["campaign_id"])] = {
                "impressions": int(c["impressions"] * n / 30), "cost": round(cost, 2), "conversions": round(conv, 1), "conv_value": round(value, 2),
                "lost_is_budget": (0.28 if limited else 0.02) if c["lost_is_budget"] is not None else None, "impr_share": c["impr_share"],
            }
        out[str(n)] = rows
    return {"ranges": ranges, "windows": out}


def simulated_campaign_daily(campaign_id, date_from, date_to):
    """Serie diaria de ejemplo: el promedio de la campaña simulada con una variación fija por fecha."""
    import math
    camp = next((c for c in simulated_campaigns_overview() if c["campaign_id"] == str(campaign_id)), None)
    if camp is None:
        return []
    start, end = datetime.date.fromisoformat(date_from), datetime.date.fromisoformat(date_to)
    n = max(1, (end - start).days + 1)
    out = []
    for i in range(n):
        d = start + datetime.timedelta(days=i)
        wave = 1 + 0.25 * math.sin(d.toordinal() * 0.9) + (0.15 if d.weekday() >= 4 else 0)
        impressions = int(camp["impressions"] / n * wave)
        clicks = int(camp["clicks"] / n * wave)
        cost = round(camp["cost"] / n * wave, 2)
        conv = round(camp["conversions"] / n * wave * (1 + 0.3 * math.cos(d.toordinal())), 1)
        def share(v, amp=0.08):
            return None if v is None else max(0.0, min(1.0, round(v + amp * math.sin(d.toordinal() * 1.3), 3)))
        out.append({
            "date": d.isoformat(), "impressions": impressions, "clicks": clicks, "cost": cost, "conversions": conv,
            "conv_value": round(camp["conv_value"] / n * wave, 2), "budget": camp["budget"],
            "impr_share": share(camp["impr_share"]), "top_impr_share": share(camp["top_impr_share"]),
            "lost_is_budget": share(camp["lost_is_budget"], 0.05), "lost_is_rank": share(camp["lost_is_rank"], 0.05),
        })
    return out


def simulated_campaign_breakdown(campaign_id):
    camp = next((c for c in simulated_campaigns_overview() if c["campaign_id"] == str(campaign_id)), None)
    if camp is None:
        return None

    def part(share, name, **extra):
        return {"name": name, "impressions": int(camp["impressions"] * share), "clicks": int(camp["clicks"] * share),
                "cost": round(camp["cost"] * share, 2), "conversions": round(camp["conversions"] * share, 1),
                "conv_value": round(camp["conv_value"] * share, 2), **extra}

    is_pmax = camp["channel_type"] == "PERFORMANCE_MAX"
    names = ["Habitaciones y tarifas", "Marca", "Promociones"] if not is_pmax else ["Hoteles - Colombia", "Hoteles - Resto"]
    shares = [0.55, 0.3, 0.15] if not is_pmax else [0.7, 0.3]
    groups = [dict(part(sh, nm), id=str(i + 1), type="SEARCH_STANDARD") for i, (nm, sh) in enumerate(zip(names, shares))]
    locations = [
        part(0.6, "Colombia", resource="geoTargetConstants/2170", canonical="Colombia", target_type="Country", country_code="CO", excluded=False),
        part(0.25, "Bogota", resource="geoTargetConstants/1011044", canonical="Bogota,Capital District,Colombia", target_type="City", country_code="CO", excluded=False),
        part(0.15, "Medellin", resource="geoTargetConstants/1011051", canonical="Medellin,Antioquia,Colombia", target_type="City", country_code="CO", excluded=False),
        {"name": "Venezuela", "resource": "geoTargetConstants/2862", "canonical": "Venezuela", "target_type": "Country", "country_code": "VE", "excluded": True,
         "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0},
    ]
    return {
        "groups": {"kind": "asset_group" if is_pmax else "ad_group", "groups": groups},
        "targeting": {"locations": locations, "radii": [], "languages": ["Spanish"], "geo_target_type": "PRESENCE_OR_INTEREST"},
    }


def _sim_prev(block, factor):
    """Periodo anterior simulado: el mismo bloque de métricas con otra escala."""
    return {**block, "impressions": int(block["impressions"] * factor), "clicks": int(block["clicks"] * factor),
            "cost": round(block["cost"] * factor, 2), "conversions": round(block["conversions"] * factor * 0.9, 1),
            "conv_value": round(block["conv_value"] * factor * 0.9, 2)}


def simulated_breakdown_previous(campaign_id):
    data = simulated_campaign_breakdown(campaign_id)
    if data is None:
        return {"prev_groups": {}, "prev_locations": {}}
    return {
        "prev_groups": {g["id"]: _sim_prev(g, 0.85) for g in data["groups"]["groups"]},
        "prev_locations": {l["resource"]: _sim_prev(l, 0.8) for l in data["targeting"]["locations"] if not l["excluded"]},
    }


def simulated_account_changes(days=30):
    """Historial de cambios de ejemplo (la API de Google Ads no está configurada)."""
    today = datetime.date.today()
    camps = [(c["campaign_id"], c["campaign_name"]) for c in simulated_campaigns_overview()]
    users = ["ana.gomez@agencia.com", "luis.perez@agencia.com", "cesar@agencia.com", ""]
    web, api, auto, rec = "GOOGLE_ADS_WEB_CLIENT", "GOOGLE_ADS_API", "INTERNAL_TOOL", "GOOGLE_ADS_RECOMMENDATIONS"
    # (días atrás, hora, usuario, origen, campaña, recurso, operación, items, texto, grupo)
    plan = [
        (0, "09:12", 0, web, 1, "CAMPAIGN_BUDGET", "UPDATE", [("Presupuesto diario", 3200.0, 3600.0, "money")], None, ""),
        (1, "17:40", 1, api, 0, "CAMPAIGN", "UPDATE", [("ROAS objetivo", 5.5, 6.0, "roas")], None, ""),
        (2, "11:05", 0, web, 1, "CAMPAIGN_CRITERION", "CREATE", [], "Palabra clave negativa «empleo» (phrase)", ""),
        (2, "11:06", 0, web, 1, "CAMPAIGN_CRITERION", "CREATE", [], "Palabra clave negativa «gratis» (broad)", ""),
        (3, "08:30", 2, web, 2, "CAMPAIGN", "UPDATE", [("Estado", "PAUSED", "ENABLED", "status")], None, ""),
        (4, "15:22", 1, web, 1, "AD_GROUP", "UPDATE", [("Estado", "ENABLED", "PAUSED", "status")], None, "Promociones"),
        (5, "10:00", 3, auto, 0, "CAMPAIGN", "UPDATE", [("Estrategia de puja", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "bid_strategy")], None, ""),
        (6, "13:47", 1, web, 1, "AD_GROUP_AD", "UPDATE", [("Titulares del anuncio", None, None, "text")], None, "Habitaciones y tarifas"),
        (7, "09:55", 0, web, 0, "CAMPAIGN_BUDGET", "UPDATE", [("Presupuesto diario", 7000.0, 8500.0, "money")], None, ""),
        (9, "16:10", 2, api, 1, "CAMPAIGN_CRITERION", "REMOVE", [], "Ubicación excluida", ""),
        (11, "12:00", 3, rec, 1, "AD_GROUP_CRITERION", "CREATE", [], "Palabra clave «hotel cerca del aeropuerto» (phrase)", "Habitaciones y tarifas"),
        (12, "18:25", 0, web, 3, "CAMPAIGN", "UPDATE", [("Estado", "ENABLED", "PAUSED", "status")], None, ""),
        (14, "10:40", 1, web, 1, "AD_GROUP_BID_MODIFIER", "UPDATE", [("Modificador de puja", 1.0, 1.2, "number")], None, "Marca"),
        (18, "09:20", 0, web, 0, "CAMPAIGN_BUDGET", "UPDATE", [("Presupuesto diario", 6000.0, 7000.0, "money")], None, ""),
        (21, "14:15", 2, web, 2, "CAMPAIGN", "UPDATE", [("Nombre", "Search Marca", "Search Marca ES", "text")], None, ""),
        (25, "11:30", 1, api, 1, "CAMPAIGN_CRITERION", "CREATE", [], "Palabra clave negativa «trabajo» (phrase)", ""),
        (29, "08:05", 0, web, 0, "CAMPAIGN", "UPDATE", [("ROAS objetivo", 5.0, 5.5, "roas")], None, ""),
    ]
    out = []
    for ago, hhmm, u, client, ci, rtype, op, items, text, group in plan:
        if ago > days - 1:
            continue
        d = (today - datetime.timedelta(days=ago)).isoformat()
        cid, cname = camps[ci % len(camps)]
        out.append({
            "when": f"{d} {hhmm}:00", "date": d, "user": users[u], "client": client, "resource": rtype,
            "resource_label": _CHANGE_RESOURCE_LABELS.get(rtype, rtype), "operation": op,
            "operation_label": _CHANGE_OPERATION_LABELS.get(op, ""),
            "items": [{"label": l, "old": o, "new": n, "kind": k} for l, o, n, k in items], "text": text,
            "campaign_id": cid, "campaign_name": cname, "ad_group_name": group,
        })
    return {"changes": out, "truncated": False, "days": days, "errors": {}}


def simulated_campaign_keyword_daily(campaign_id, date_from, date_to):
    """Datos de ejemplo de la evolución de las 10 palabras clave principales (determinista por campaña)."""
    camp = next((c for c in simulated_campaigns_overview() if c["campaign_id"] == str(campaign_id)), None)
    if camp is None or camp["channel_type"] != "SEARCH":
        return {"date_from": date_from, "date_to": date_to, "keywords": []}
    texts = ["hotel estelar bogota", "hotel cerca aeropuerto", "reservar hotel centro", "hoteles baratos", "hotel con piscina",
             "hotel zona rosa", "mejor hotel bogota", "hotel para negocios", "hotel familiar", "hotel desayuno incluido"]
    matches = ["BROAD", "PHRASE", "EXACT", "BROAD", "PHRASE", "EXACT", "BROAD", "PHRASE", "EXACT", "BROAD"]
    start = datetime.date.fromisoformat(date_from)
    end = datetime.date.fromisoformat(date_to)
    n_days = (end - start).days + 1
    out = []
    for i, (text, match) in enumerate(zip(texts, matches)):
        days = []
        for d in range(n_days):
            day = start + datetime.timedelta(days=d)
            wave = 1 + 0.25 * ((d + i * 3) % 7 - 3) / 3
            imps = int((900 - i * 70) * wave)
            clicks = int(imps * (0.05 - i * 0.002))
            cpc = (1.1 + i * 0.08) * (1 + 0.1 * ((d + i) % 5 - 2) / 2)
            share = None if (i == 9 and d % 6 == 0) else round(max(0.05, min(1.0, 0.75 - i * 0.05 + 0.08 * ((d + i) % 6 - 3) / 3)), 3)
            days.append({"date": day.isoformat(), "impressions": imps, "clicks": clicks, "cost": round(clicks * cpc, 2), "impr_share": share})
        out.append({"key": f"1000~{2000 + i}", "text": text, "match_type": match, "ad_group": "Grupo principal", "days": days})
    return {"date_from": date_from, "date_to": date_to, "keywords": out}


def simulated_campaign_insight(view, campaign_id):
    camp = next((c for c in simulated_campaigns_overview() if c["campaign_id"] == str(campaign_id)), None)
    if camp is None:
        return None
    base = {k: camp[k] for k in ("impressions", "clicks", "cost", "conversions", "conv_value")}
    shares = {"impr_share": camp["impr_share"], "top_impr_share": camp["top_impr_share"], "lost_is_budget": camp["lost_is_budget"], "lost_is_rank": camp["lost_is_rank"]}
    shares_prev = {k: (None if v is None else round(max(0.0, v * 0.9), 3)) for k, v in shares.items()}
    if view == "context":
        limited = (camp["lost_is_budget"] or 0) > 0.2
        return {
            "current": {**base, **shares}, "previous": {**_sim_prev(base, 0.85), **shares_prev},
            "status": {"primary_status": "LIMITED" if limited else "ELIGIBLE", "reasons": ["BUDGET_CONSTRAINED"] if limited else [],
                       "bidding_system_status": "ENABLED", "budget": camp["budget"], "shared_budget": False,
                       "recommended_budget": round(camp["budget"] * 1.6, 2) if limited else None},
            "changes": [
                {"when": "2026-11-02 10:15:00", "date": "2026-11-02", "user": "ejemplo@agencia.com", "client": "GOOGLE_ADS_WEB_CLIENT", "resource": "CAMPAIGN_BUDGET",
                 "resource_label": "Presupuesto", "operation": "UPDATE", "operation_label": "Cambió", "text": None,
                 "items": [{"label": "Presupuesto diario", "old": round(camp["budget"] * 0.8, 2), "new": camp["budget"], "kind": "money"}]},
                {"when": "2026-10-28 16:40:00", "date": "2026-10-28", "user": "ejemplo@agencia.com", "client": "GOOGLE_ADS_API", "resource": "CAMPAIGN_CRITERION",
                 "resource_label": "Segmentación o negativa de campaña", "operation": "CREATE", "operation_label": "Creó", "items": [],
                 "text": "Palabra clave negativa «empleo» (phrase)"},
            ],
            "errors": {},
        }
    if view == "segments":
        def seg(key, share):
            return {"key": key, **{k: (round(v * share, 2) if isinstance(v, float) else int(v * share)) for k, v in base.items()}}
        weekday = [("MONDAY", 0.13), ("TUESDAY", 0.12), ("WEDNESDAY", 0.12), ("THURSDAY", 0.14), ("FRIDAY", 0.17), ("SATURDAY", 0.18), ("SUNDAY", 0.14)]
        return {
            "device": [seg("MOBILE", 0.6), seg("DESKTOP", 0.35), seg("TABLET", 0.05)],
            "weekday": [seg(k, v) for k, v in weekday],
            "conversions": [{"name": "Reservas-purchase", "category": "PURCHASE", "conversions": round(camp["conversions"] * 0.8, 1), "conv_value": round(camp["conv_value"] * 0.9, 2)},
                            {"name": "Clic en teléfono", "category": "CONTACT", "conversions": round(camp["conversions"] * 0.2, 1), "conv_value": 0.0}],
            "countries": [{"name": "Colombia", "country_code": "CO", **seg("x", 0.9)}, {"name": "United States", "country_code": "US", **seg("x", 0.1)}],
            "errors": {},
        }
    if view == "keywords":
        if camp["channel_type"] != "SEARCH":
            return []
        rows = []
        for i, (text, mt, qs, rel, lp, ctr, share) in enumerate([
            ("hotel estelar bogota", "BROAD", 9, "ABOVE_AVERAGE", "ABOVE_AVERAGE", "ABOVE_AVERAGE", 0.4),
            ("hotel cerca aeropuerto", "PHRASE", 5, "AVERAGE", "BELOW_AVERAGE", "AVERAGE", 0.25),
            ("reservar hotel centro", "EXACT", 7, "ABOVE_AVERAGE", "AVERAGE", "AVERAGE", 0.2),
            ("hoteles baratos", "BROAD", 3, "BELOW_AVERAGE", "BELOW_AVERAGE", "BELOW_AVERAGE", 0.15)]):
            rows.append({"text": text, "match_type": mt, "status": "ENABLED", "ad_group": "Grupo principal", "quality_score": qs,
                         "ad_relevance": rel, "landing_page": lp, "expected_ctr": ctr,
                         "impressions": int(base["impressions"] * share), "clicks": int(base["clicks"] * share), "cost": round(base["cost"] * share, 2),
                         "conversions": round(base["conversions"] * share * (0 if i == 3 else 1), 1), "conv_value": round(base["conv_value"] * share * (0 if i == 3 else 1), 2)})
        return rows
    if view == "position":
        if camp["impr_share"] is None:
            empty = {k: None for k in _POSITION_FIELDS}
            return {"current": empty, "previous": empty}
        cur = {"impr_share": camp["impr_share"], "top_impr_share": camp["top_impr_share"], "lost_is_budget": camp["lost_is_budget"], "lost_is_rank": camp["lost_is_rank"],
               "abs_top_impr_share": round(camp["top_impr_share"] * 0.6, 3), "lost_top_budget": camp["lost_is_budget"], "lost_top_rank": camp["lost_is_rank"],
               "lost_abs_top_budget": camp["lost_is_budget"], "lost_abs_top_rank": round((camp["lost_is_rank"] or 0) * 3, 3),
               "click_share": round(camp["impr_share"] * 0.7, 3), "exact_impr_share": round(min(1.0, camp["impr_share"] + 0.1), 3)}
        prev = {k: (None if v is None else round(max(0.0, v * 0.9), 3)) for k, v in cur.items()}
        return {"current": cur, "previous": prev}
    return None


def simulated_update_campaign_status(campaign_id, status, validate_only=True):
    return {"validate_only": validate_only, "applied": not validate_only, "status": status, "simulated": True}


def simulated_update_campaign_ai_max(campaign_id, enable, validate_only=True):
    return {"validate_only": validate_only, "applied": not validate_only, "enabled": bool(enable), "simulated": True}


SIMULATED_AI_MAX_CREATED_ASSETS = [
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "asset_id": "9001", "asset_type": "TEXT", "field_type": "HEADLINE", "text": "Reserva al mejor precio garantizado", "performance_label": "NOT_APPLICABLE", "impressions": 120, "clicks": 9, "cost": 6.3, "conversions": 1},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "asset_id": "9002", "asset_type": "TEXT", "field_type": "DESCRIPTION", "text": "Hoteles Estelar: reserva directa con beneficios exclusivos", "performance_label": "NOT_APPLICABLE", "impressions": 64, "clicks": 3, "cost": 2.1, "conversions": 0},
]

SIMULATED_AI_MAX_COMBINATIONS = [
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "search_term": "estelar hoteles reservas oficiales", "landing_page": "https://www.estelar.example/es/ofertas/", "headline": "Ofertas Hoteles Estelar | Web Oficial", "impressions": 340, "clicks": 28, "cost": 19.6, "conversions": 3},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "search_term": "hotel estelar cartagena", "landing_page": "https://www.estelar.example/es/", "headline": "Hotel Estelar Cartagena, Web Oficial", "impressions": 210, "clicks": 17, "cost": 11.4, "conversions": 1},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "search_term": "hotel estelar cartagena", "landing_page": "https://www.estelar.example/es/servicios/", "headline": "Servicios Hotel Estelar Cartagena", "impressions": 41, "clicks": 1, "cost": 0.7, "conversions": 0},
]

SIMULATED_AI_MAX_LANDING_PAGES = [
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "page": "https://www.estelar.example/es/", "impressions": 520, "clicks": 41, "cost": 28.4, "conversions": 2},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "page": "https://www.estelar.example/es/ofertas/", "impressions": 340, "clicks": 28, "cost": 19.6, "conversions": 3},
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "page": "https://www.estelar.example/es/fotos/", "impressions": 38, "clicks": 0, "cost": 0, "conversions": 0},
]


def simulated_ai_max_created(campaign_id=None):
    def pick(rows):
        return [r for r in rows if not campaign_id or r["campaign_id"] == str(campaign_id)]
    combos = pick(SIMULATED_AI_MAX_COMBINATIONS)
    pages = pick(SIMULATED_AI_MAX_LANDING_PAGES)
    return {"assets": pick(SIMULATED_AI_MAX_CREATED_ASSETS), "combinations": combos, "combinations_total": len(combos),
            "pages": pages, "pages_total": len(pages)}


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


# Términos reales de la campaña PMax simulada (con costo), para probar la pestaña "Con IA" con Performance Max.
SIMULATED_PMAX_SEARCH_TERMS = [
    {"term": "hotel estelar corporativo bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 210, "impr": 5600, "cost": 310.5, "conversions": 18.4, "is_category": False, "pmax": True},
    {"term": "airbnb bogota centro", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 40, "impr": 900, "cost": 52.0, "conversions": 0, "is_category": False, "pmax": True},
    {"term": "empleo hotel bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 22, "impr": 410, "cost": 27.4, "conversions": 0, "is_category": False, "pmax": True},
    {"term": "hoteles para eventos empresariales bogota", "campaign_id": "1111111103", "campaign_name": "Estelar Hoteles - CO:es - PMAX Corpo", "ad_group_id": None, "ad_group_name": None, "clicks": 95, "impr": 3100, "cost": 120.8, "conversions": 6.1, "is_category": False, "pmax": True},
]


def simulated_pmax_search_terms():
    return SIMULATED_PMAX_SEARCH_TERMS


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


SIMULATED_AI_MAX_URL_EXCLUSIONS = [
    {"campaign_id": "1111111102", "campaign_name": "Estelar Hoteles - CO:es - Search Marca", "resource_name": "customers/1111111111/campaignCriteria/1111111102~9001", "criterion_id": "9001", "name": "Excluir (contiene): /fotos/", "mode": "contains", "value": "/fotos/", "conditions": 1},
]


def simulated_ai_max_url_exclusions():
    return list(SIMULATED_AI_MAX_URL_EXCLUSIONS)


def simulated_push_ai_max_url_exclusions(items, validate_only=True):
    return {"created": len(items), "failed": [], "validate_only": validate_only, "simulated": True}


def simulated_remove_ai_max_url_exclusions(resource_names, validate_only=True):
    return {"removed": len(resource_names), "failed": [], "validate_only": validate_only, "simulated": True}


def simulated_push_negative_keywords(items, validate_only=True):
    result = {"created": len(items), "failed": [], "validate_only": validate_only, "simulated": True}
    if not validate_only:
        result["created_items"] = [{
            "campaign_id": str(i["campaign_id"]), "campaign_name": i.get("campaign_name") or "", "term": i["term"],
            "match_type": i.get("match_type") if i.get("match_type") in ("EXACT", "PHRASE") else "EXACT",
            "resource_name": f"customers/simulada/campaignCriteria/{i['campaign_id']}~{abs(hash(i['term'])) % 10**9}",
        } for i in items]
    return result


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


# ---------------------------------------------------------------------------
# Auditoría de cuenta (solo lectura) — alimenta account_audit.run_audit()
# ---------------------------------------------------------------------------

def fetch_audit_data(customer_id, date_from, date_to):
    """Junta los datos que necesita la auditoría con ~12 consultas GAQL de
    solo lectura. Solo la consulta de campañas es imprescindible (si falla,
    se propaga); cada una de las demás se aísla: si Google rechaza un campo
    (pasó con casi todas las integraciones nuevas), ese bloque queda en None y
    en data["unavailable"] con el motivo, y la auditoría marca esas revisiones
    como "no verificables" en vez de caerse o inventar un hallazgo."""
    between = f"segments.date BETWEEN '{date_from}' AND '{date_to}'"
    data = {"unavailable": {}}

    campaigns = []
    campaigns_query = f"""
        SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
               campaign.bidding_strategy_type, campaign.campaign_budget, campaign.start_date_time,
               campaign.network_settings.target_google_search,
               campaign.network_settings.target_search_network,
               campaign.network_settings.target_content_network,
               campaign.geo_target_type_setting.positive_geo_target_type,
               metrics.cost_micros, metrics.conversions, metrics.conversions_value,
               metrics.impressions, metrics.clicks{{extra}}
        FROM campaign
        WHERE {between} AND campaign.status != 'REMOVED'
    """
    # Los experimentos que ya terminaron (tipo EXPERIMENT con serving_status ENDED) no son campañas reales de la
    # cuenta: se dejan fuera de la auditoría y del puntaje, igual que en Ritmo de consumo y Campañas. Si Google
    # rechazara esos dos campos, se vuelve a la consulta de siempre para no tumbar la auditoría.
    try:
        campaign_rows = _search(customer_id, campaigns_query.format(extra=",\n               campaign.experiment_type, campaign.serving_status"))
    except Exception as e:  # noqa: BLE001
        print(f"[audit] sin filtro de experimentos terminados ({customer_id}): {' '.join(str(e).split())[:200]}", flush=True)
        campaign_rows = _search(customer_id, campaigns_query.format(extra=""))
    ended_experiments = []
    for r in campaign_rows:
        c, m = r.get("campaign", {}), r.get("metrics", {})
        if _is_ended_experiment(c):
            ended_experiments.append({"id": str(c.get("id")), "name": c.get("name") or "(sin nombre)"})
            continue
        ns = c.get("networkSettings", {})
        campaigns.append({
            "id": str(c.get("id")), "name": c.get("name") or "(sin nombre)", "status": c.get("status") or "UNKNOWN",
            "channel_type": c.get("advertisingChannelType") or "UNKNOWN",
            "bidding": c.get("biddingStrategyType") or "UNSPECIFIED",
            "budget_resource": c.get("campaignBudget"),
            "start_date": (c.get("startDateTime") or "")[:10] or None,
            "search_partners": bool(ns.get("targetSearchNetwork")),
            "display_network": bool(ns.get("targetContentNetwork")),
            "geo_target_type": c.get("geoTargetTypeSetting", {}).get("positiveGeoTargetType"),
            "cost": _micros_to_units(_int_or_none(m.get("costMicros"))) or 0,
            "conversions": _float_or_none(m.get("conversions")) or 0,
            "conv_value": _float_or_none(m.get("conversionsValue")) or 0,
            "impressions": _int_or_none(m.get("impressions")) or 0,
            "clicks": _int_or_none(m.get("clicks")) or 0,
        })
    data["campaigns"] = campaigns
    data["excluded_experiments"] = ended_experiments
    # Para las consultas que no traen la campaña en cada fila: se dejan fuera con la propia consulta.
    excl = f"\n              AND campaign.id NOT IN ({', '.join(e['id'] for e in ended_experiments)})" if ended_experiments else ""

    def block(name, fn):
        try:
            data[name] = fn()
        except Exception as e:  # noqa: BLE001 — un campo rechazado no tumba la auditoría
            data[name] = None
            data["unavailable"][name] = " ".join(str(e).split())[:240]

    def customer_info():
        rows = _search(customer_id, """
            SELECT customer.descriptive_name, customer.currency_code
            FROM customer
        """)
        c = (rows[0] if rows else {}).get("customer", {})
        data["currency"] = c.get("currencyCode") or ""
        data["account_name"] = c.get("descriptiveName") or ""
        return True
    block("customer", customer_info)
    data.setdefault("currency", "")

    # A9: conversiones mejoradas. Desde la API v26 el ajuste de la cuenta se puede leer
    # (customer.conversion_tracking_setting.effective_enablement_setting: ON, OFF, o sin dato).
    # Va en su propio bloque para que, si Google lo rechaza, no se pierdan el nombre ni la moneda.
    def enhanced_conversions_setting():
        rows = _search(customer_id, "SELECT customer.conversion_tracking_setting.effective_enablement_setting FROM customer")
        c = (rows[0] if rows else {}).get("customer", {})
        v = c.get("conversionTrackingSetting", {}).get("effectiveEnablementSetting")
        data["enhanced_conversions"] = {"ON": True, "OFF": False}.get(v)
        return True
    data["enhanced_conversions"] = None
    block("enhanced_conversions_setting", enhanced_conversions_setting)

    def conversion_actions():
        rows = _search(customer_id, """
            SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type,
                   conversion_action.category, conversion_action.primary_for_goal,
                   conversion_action.click_through_lookback_window_days
            FROM conversion_action WHERE conversion_action.status != 'REMOVED'
        """)
        out = []
        for r in rows:
            a = r.get("conversionAction", {})
            out.append({
                "id": str(a.get("id")), "name": a.get("name") or "(sin nombre)", "status": a.get("status"),
                "type": a.get("type"), "category": a.get("category"),
                "primary_for_goal": bool(a.get("primaryForGoal")),
                "lookback_days": _int_or_none(a.get("clickThroughLookbackWindowDays")),
            })
        return out
    block("conversion_actions", conversion_actions)

    def conversion_action_metrics():
        rows = _search(customer_id, f"""
            SELECT segments.conversion_action_name, metrics.conversions, metrics.conversions_value
            FROM customer WHERE {between}
        """)
        out = {}
        for r in rows:
            name = r.get("segments", {}).get("conversionActionName")
            m = r.get("metrics", {})
            if name:
                cur = out.setdefault(name, {"conversions": 0.0, "value": 0.0})
                cur["conversions"] += _float_or_none(m.get("conversions")) or 0
                cur["value"] += _float_or_none(m.get("conversionsValue")) or 0
        return out
    block("conversion_action_metrics", conversion_action_metrics)

    def search_terms():
        rows = _search(customer_id, f"""
            SELECT search_term_view.search_term, campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks
            FROM search_term_view
            WHERE {between} AND metrics.cost_micros > 0
            ORDER BY metrics.cost_micros DESC LIMIT 1000
        """)
        return [{
            "term": r.get("searchTermView", {}).get("searchTerm") or "",
            "campaign_id": str(r.get("campaign", {}).get("id")),
            "cost": _micros_to_units(_int_or_none(r.get("metrics", {}).get("costMicros"))) or 0,
            "conversions": _float_or_none(r.get("metrics", {}).get("conversions")) or 0,
        } for r in rows]
    block("search_terms", search_terms)

    def network_split():
        rows = _search(customer_id, f"""
            SELECT campaign.id, segments.ad_network_type, metrics.cost_micros, metrics.conversions, metrics.clicks
            FROM campaign
            WHERE {between} AND campaign.advertising_channel_type = 'SEARCH' AND metrics.cost_micros > 0
        """)
        return [{
            "campaign_id": str(r.get("campaign", {}).get("id")),
            "network": r.get("segments", {}).get("adNetworkType"),
            "cost": _micros_to_units(_int_or_none(r.get("metrics", {}).get("costMicros"))) or 0,
            "conversions": _float_or_none(r.get("metrics", {}).get("conversions")) or 0,
            "clicks": _int_or_none(r.get("metrics", {}).get("clicks")) or 0,
        } for r in rows]
    block("network_split", network_split)

    def keywords():
        rows = _search(customer_id, f"""
            SELECT campaign.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                   ad_group_criterion.quality_info.quality_score, metrics.cost_micros, metrics.conversions, metrics.impressions, metrics.clicks
            FROM keyword_view
            WHERE {between} AND ad_group_criterion.status = 'ENABLED'
              AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND metrics.cost_micros > 0
            ORDER BY metrics.cost_micros DESC LIMIT 2000
        """)
        out = []
        for r in rows:
            crit = r.get("adGroupCriterion", {})
            out.append({
                "campaign_id": str(r.get("campaign", {}).get("id")),
                "text": crit.get("keyword", {}).get("text") or "",
                "match_type": crit.get("keyword", {}).get("matchType"),
                "quality_score": _int_or_none(crit.get("qualityInfo", {}).get("qualityScore")),
                "cost": _micros_to_units(_int_or_none(r.get("metrics", {}).get("costMicros"))) or 0,
                "conversions": _float_or_none(r.get("metrics", {}).get("conversions")) or 0,
                "impressions": _int_or_none(r.get("metrics", {}).get("impressions")) or 0,
                "clicks": _int_or_none(r.get("metrics", {}).get("clicks")) or 0,
            })
        return out
    block("keywords", keywords)

    def adgroup_keyword_counts():
        rows = _search(customer_id, """
            SELECT ad_group.id, ad_group.name
            FROM ad_group_criterion
            WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE
              AND ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'""" + excl + """
        """)
        counts = {}
        for r in rows:
            ag = r.get("adGroup", {})
            key = str(ag.get("id"))
            counts.setdefault(key, {"name": ag.get("name") or key, "keywords": 0})["keywords"] += 1
        return list(counts.values())
    block("adgroup_keyword_counts", adgroup_keyword_counts)

    def negatives():
        rows = _search(customer_id, """
            SELECT campaign.id, campaign_criterion.keyword.text
            FROM campaign_criterion
            WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED'
        """)
        return [{"campaign_id": str(r.get("campaign", {}).get("id")),
                 "text": r.get("campaignCriterion", {}).get("keyword", {}).get("text") or ""} for r in rows]
    block("negatives", negatives)

    def lost_is():
        rows = _search(customer_id, f"""
            SELECT campaign.id, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
            FROM campaign
            WHERE {between} AND campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED'
        """)
        return [{"campaign_id": str(r.get("campaign", {}).get("id")),
                 "budget_lost": _float_or_none(r.get("metrics", {}).get("searchBudgetLostImpressionShare")) or 0,
                 "rank_lost": _float_or_none(r.get("metrics", {}).get("searchRankLostImpressionShare")) or 0} for r in rows]
    block("lost_is", lost_is)

    def campaign_languages():
        rows = _search(customer_id, """
            SELECT campaign.id, campaign_criterion.language.language_constant
            FROM campaign_criterion
            WHERE campaign_criterion.type = 'LANGUAGE' AND campaign.status = 'ENABLED'
        """)
        return [{"campaign_id": str(r.get("campaign", {}).get("id"))} for r in rows]
    block("campaign_languages", campaign_languages)

    def assets():
        out = []
        for r in _search(customer_id, """
            SELECT campaign.id, campaign.status, campaign_asset.field_type FROM campaign_asset
            WHERE campaign_asset.status = 'ENABLED' AND campaign.status = 'ENABLED'""" + excl + """
        """):
            out.append({"field_type": r.get("campaignAsset", {}).get("fieldType")})
        for r in _search(customer_id, "SELECT customer_asset.field_type FROM customer_asset WHERE customer_asset.status = 'ENABLED'"):
            out.append({"field_type": r.get("customerAsset", {}).get("fieldType")})
        return out
    block("assets", assets)

    # B5 / B6: rendimiento por país. geographic_view separa "presencia" e "interés"
    # en filas distintas; se suman por país. Los nombres salen de geo_target_constant.
    def geo_performance():
        rows = _search(customer_id, f"""
            SELECT geographic_view.country_criterion_id, metrics.cost_micros, metrics.clicks,
                   metrics.conversions, metrics.conversions_value
            FROM geographic_view
            WHERE {between} AND metrics.cost_micros > 0
            ORDER BY metrics.cost_micros DESC LIMIT 500
        """)
        agg = {}
        for r in rows:
            cid = str(r.get("geographicView", {}).get("countryCriterionId") or "")
            if not cid:
                continue
            m = r.get("metrics", {})
            a = agg.setdefault(cid, {"country_id": cid, "country": cid, "cost": 0.0, "clicks": 0, "conversions": 0.0, "value": 0.0})
            a["cost"] += _micros_to_units(_int_or_none(m.get("costMicros"))) or 0
            a["clicks"] += _int_or_none(m.get("clicks")) or 0
            a["conversions"] += _float_or_none(m.get("conversions")) or 0
            a["value"] += _float_or_none(m.get("conversionsValue")) or 0
        if agg:
            try:
                inl = ", ".join(f"'geoTargetConstants/{i}'" for i in sorted(agg))
                for r in _search(customer_id, f"SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN ({inl})"):
                    g = r.get("geoTargetConstant", {})
                    cid = (g.get("resourceName") or "").split("/")[-1]
                    if cid in agg and g.get("name"):
                        agg[cid]["country"] = g["name"]
            except Exception:  # noqa: BLE001 — sin nombres se muestra el código del país
                pass
        return sorted(agg.values(), key=lambda a: -a["cost"])
    block("geo_performance", geo_performance)

    # B8: rendimiento por dispositivo (móvil, ordenador, tablet...).
    def device_performance():
        rows = _search(customer_id, f"""
            SELECT segments.device, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
            FROM customer WHERE {between}
        """)
        out = {}
        for r in rows:
            dev = r.get("segments", {}).get("device") or "UNKNOWN"
            m = r.get("metrics", {})
            d_ = out.setdefault(dev, {"device": dev, "cost": 0.0, "clicks": 0, "conversions": 0.0, "value": 0.0})
            d_["cost"] += _micros_to_units(_int_or_none(m.get("costMicros"))) or 0
            d_["clicks"] += _int_or_none(m.get("clicks")) or 0
            d_["conversions"] += _float_or_none(m.get("conversions")) or 0
            d_["value"] += _float_or_none(m.get("conversionsValue")) or 0
        return sorted(out.values(), key=lambda x: -x["cost"])
    block("device_performance", device_performance)

    # G5: mismo número de días justo antes del periodo, para comparar la evolución.
    def previous_period():
        d_from, d_to = datetime.date.fromisoformat(date_from), datetime.date.fromisoformat(date_to)
        n = (d_to - d_from).days + 1
        p_to = d_from - datetime.timedelta(days=1)
        p_from = p_to - datetime.timedelta(days=n - 1)
        rows = _search(customer_id, f"""
            SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value
            FROM customer WHERE segments.date BETWEEN '{p_from.isoformat()}' AND '{p_to.isoformat()}'
        """)
        tot = {"cost": 0.0, "conversions": 0.0, "value": 0.0, "date_from": p_from.isoformat(), "date_to": p_to.isoformat()}
        for r in rows:
            m = r.get("metrics", {})
            tot["cost"] += _micros_to_units(_int_or_none(m.get("costMicros"))) or 0
            tot["conversions"] += _float_or_none(m.get("conversions")) or 0
            tot["value"] += _float_or_none(m.get("conversionsValue")) or 0
        return tot
    block("previous_period", previous_period)

    def recommendation_subscriptions():
        rows = _search(customer_id, "SELECT recommendation_subscription.type, recommendation_subscription.status FROM recommendation_subscription")
        return [{"type": r.get("recommendationSubscription", {}).get("type"),
                 "status": r.get("recommendationSubscription", {}).get("status")} for r in rows]
    block("recommendation_subscriptions", recommendation_subscriptions)

    # Audiencias (reglas U1 a U5): listas propias con su tamaño, dónde se usan y en qué modo.
    def user_lists():
        rows = _search(customer_id, """
            SELECT user_list.resource_name, user_list.name, user_list.type, user_list.membership_status,
                   user_list.size_for_search, user_list.size_for_display, user_list.membership_life_span
            FROM user_list LIMIT 2000
        """)
        out = []
        for r in rows:
            u = r.get("userList", {})
            out.append({"resource": u.get("resourceName"), "name": u.get("name") or "", "type": u.get("type"),
                        "status": u.get("membershipStatus"),
                        "size_search": _int_or_none(u.get("sizeForSearch")), "size_display": _int_or_none(u.get("sizeForDisplay")),
                        "life_span": _int_or_none(u.get("membershipLifeSpan"))})
        return out
    block("user_lists", user_lists)

    def audience_criteria():
        out = []
        for r in _search(customer_id, """
            SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign_criterion.negative,
                   campaign_criterion.user_list.user_list
            FROM campaign_criterion
            WHERE campaign_criterion.type = 'USER_LIST' AND campaign.status = 'ENABLED'
        """):
            out.append({"level": "campaign", "campaign_id": str(r.get("campaign", {}).get("id")), "campaign": r.get("campaign", {}).get("name") or "",
                        "channel": r.get("campaign", {}).get("advertisingChannelType"), "ad_group_id": None, "ad_group": "",
                        "negative": bool(r.get("campaignCriterion", {}).get("negative")),
                        "list": r.get("campaignCriterion", {}).get("userList", {}).get("userList")})
        for r in _search(customer_id, """
            SELECT ad_group.id, ad_group.name, campaign.id, campaign.name, campaign.advertising_channel_type,
                   ad_group_criterion.negative, ad_group_criterion.user_list.user_list
            FROM ad_group_criterion
            WHERE ad_group_criterion.type = 'USER_LIST' AND ad_group_criterion.status = 'ENABLED'
              AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
        """):
            out.append({"level": "ad_group", "campaign_id": str(r.get("campaign", {}).get("id")), "campaign": r.get("campaign", {}).get("name") or "",
                        "channel": r.get("campaign", {}).get("advertisingChannelType"),
                        "ad_group_id": str(r.get("adGroup", {}).get("id")), "ad_group": r.get("adGroup", {}).get("name") or "",
                        "negative": bool(r.get("adGroupCriterion", {}).get("negative")),
                        "list": r.get("adGroupCriterion", {}).get("userList", {}).get("userList")})
        return out
    block("audience_criteria", audience_criteria)

    # Modo de las audiencias por grupo de anuncios: "observación" (bid_only) solo ajusta la puja;
    # "segmentación" limita la campaña a esa audiencia.
    def audience_modes():
        out = {}
        for r in _search(customer_id, """
            SELECT ad_group.id, ad_group.targeting_setting.target_restrictions
            FROM ad_group WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
        """):
            for t in r.get("adGroup", {}).get("targetingSetting", {}).get("targetRestrictions", []):
                if t.get("targetingDimension") == "AUDIENCE":
                    out[str(r["adGroup"].get("id"))] = "observation" if t.get("bidOnly") else "targeting"
        return out
    block("audience_modes", audience_modes)

    # Performance Max: solo si hay campañas PMax activas (suma unas 4 consultas).
    if any(c["channel_type"] == "PERFORMANCE_MAX" and c["status"] == "ENABLED" for c in campaigns):
        def pmax_asset_groups():
            rows = _search(customer_id, f"""
                SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength,
                       campaign.id, campaign.status, metrics.impressions,
                       metrics.cost_micros, metrics.conversions, metrics.conversions_value
                FROM asset_group
                WHERE {between} AND asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
            """)
            groups = {}
            for r in rows:
                ag = r.get("assetGroup", {})
                gid = str(ag.get("id"))
                g = groups.setdefault(gid, {"id": gid, "name": ag.get("name") or gid,
                                            "campaign_id": str(r.get("campaign", {}).get("id")),
                                            "ad_strength": ag.get("adStrength"), "impressions": 0,
                                            "cost": 0.0, "conversions": 0.0, "conv_value": 0.0})
                m_ = r.get("metrics", {})
                g["impressions"] += _int_or_none(m_.get("impressions")) or 0
                g["cost"] += _micros_to_units(_int_or_none(m_.get("costMicros"))) or 0
                g["conversions"] += _float_or_none(m_.get("conversions")) or 0
                g["conv_value"] += _float_or_none(m_.get("conversionsValue")) or 0
            return list(groups.values())
        block("pmax_asset_groups", pmax_asset_groups)

        def pmax_assets():
            rows = _search(customer_id, """
                SELECT asset_group.id, asset_group.status, campaign.id, campaign.status,
                       asset_group_asset.field_type, asset_group_asset.status
                FROM asset_group_asset
                WHERE asset_group_asset.status = 'ENABLED' AND asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'""" + excl + """
            """)
            return [{"asset_group_id": str(r.get("assetGroup", {}).get("id")),
                     "field_type": r.get("assetGroupAsset", {}).get("fieldType")} for r in rows]
        block("pmax_assets", pmax_assets)

        def pmax_signals():
            rows = _search(customer_id, """
                SELECT asset_group.id, asset_group.status, campaign.id, campaign.status,
                       asset_group_signal.audience.audience, asset_group_signal.search_theme.text
                FROM asset_group_signal
                WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'""" + excl + """
            """)
            return [{"asset_group_id": str(r.get("assetGroup", {}).get("id"))} for r in rows]
        block("pmax_signals", pmax_signals)

        # Audiencias de las señales de PMax resueltas hasta las listas que contienen (para U4).
        def pmax_signal_lists():
            segs = {}
            for r in _search(customer_id, "SELECT audience.resource_name, audience.dimensions FROM audience"):
                a_ = r.get("audience", {})
                lists_ = []
                for dim in a_.get("dimensions", []):
                    for seg in dim.get("audienceSegments", {}).get("segments", []):
                        ul = seg.get("userList", {}).get("userList")
                        if ul:
                            lists_.append(ul)
                segs[a_.get("resourceName")] = lists_
            out = {}
            for r in _search(customer_id, """
                SELECT asset_group.id, asset_group.status, campaign.status, asset_group_signal.audience.audience
                FROM asset_group_signal
                WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
            """):
                aud = r.get("assetGroupSignal", {}).get("audience", {}).get("audience")
                if aud:
                    out.setdefault(str(r.get("assetGroup", {}).get("id")), []).extend(segs.get(aud, []))
            return out
        block("pmax_signal_lists", pmax_signal_lists)

        def pmax_lost_is():
            rows = _search(customer_id, f"""
                SELECT campaign.id, metrics.search_budget_lost_impression_share
                FROM campaign
                WHERE {between} AND campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND campaign.status = 'ENABLED'
            """)
            return [{"campaign_id": str(r.get("campaign", {}).get("id")),
                     "budget_lost": _float_or_none(r.get("metrics", {}).get("searchBudgetLostImpressionShare")) or 0} for r in rows]
        block("pmax_lost_is", pmax_lost_is)

        # P9: exclusiones de marca de cada campaña (BRAND_LIST con negative=True) y
        # categorías de búsqueda con sus impresiones (el costo no viene en ese recurso).
        def pmax_brand_lists():
            rows = _search(customer_id, """
                SELECT campaign.id, campaign.status, campaign_criterion.negative
                FROM campaign_criterion
                WHERE campaign_criterion.type = 'BRAND_LIST' AND campaign.status = 'ENABLED'
            """)
            return [{"campaign_id": str(r.get("campaign", {}).get("id")),
                     "negative": bool(r.get("campaignCriterion", {}).get("negative"))} for r in rows]
        block("pmax_brand_lists", pmax_brand_lists)

        def pmax_categories():
            return [{"campaign_id": r["campaign_id"], "term": r["term"], "impressions": r["impr"]}
                    for r in fetch_pmax_search_term_insights(customer_id, date_from, date_to)]
        block("pmax_categories", pmax_categories)

        # P10: reparto de impresiones por tipo de ubicación. Esta vista no admite
        # costo, clics ni conversiones: solo impresiones.
        def pmax_placements():
            rows = _search(customer_id, f"""
                SELECT performance_max_placement_view.placement_type, metrics.impressions
                FROM performance_max_placement_view WHERE {between}
            """)
            out = {}
            for r in rows:
                t = r.get("performanceMaxPlacementView", {}).get("placementType") or "UNKNOWN"
                out[t] = out.get(t, 0) + (_int_or_none(r.get("metrics", {}).get("impressions")) or 0)
            return out
        block("pmax_placements", pmax_placements)

        # P11: cambios de presupuesto o puja de los últimos 14 días (el historial de Google
        # guarda 30 como máximo). El historial también trae change_event.user_email y
        # client_type (quién y desde dónde), que P11 todavía no usa.
        def pmax_changes():
            d_to = datetime.date.fromisoformat(date_to)
            d_from = max(datetime.date.fromisoformat(date_from), d_to - datetime.timedelta(days=13))
            rows = _search(customer_id, f"""
                SELECT change_event.change_date_time, change_event.change_resource_type,
                       change_event.change_resource_name, change_event.changed_fields
                FROM change_event
                WHERE change_event.change_date_time >= '{d_from.isoformat()} 00:00:00'
                  AND change_event.change_date_time <= '{d_to.isoformat()} 23:59:59'
                  AND change_event.change_resource_type IN ('CAMPAIGN_BUDGET', 'CAMPAIGN')
                ORDER BY change_event.change_date_time DESC LIMIT 1000
            """)
            return [{"type": r.get("changeEvent", {}).get("changeResourceType"),
                     "resource": r.get("changeEvent", {}).get("changeResourceName"),
                     "fields": r.get("changeEvent", {}).get("changedFields") or ""} for r in rows]
        block("pmax_changes", pmax_changes)

    # ---- IA Max (reglas M1 a M8) ----
    # Solo se consulta el resto si hay campañas Search activas con IA Max prendido; si no, el área no aparece.
    def ai_max_campaigns():
        rows = _search(customer_id, """
            SELECT campaign.id, campaign.name, campaign.asset_automation_settings,
                   campaign.aca_migration_date_time, campaign.broad_match_migration_date_time
            FROM campaign
            WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
              AND campaign.ai_max_setting.enable_ai_max = TRUE""" + excl + """
        """)
        out = []
        for r in rows:
            c = r.get("campaign", {})
            text_auto = _asset_automation_status(c, "TEXT_ASSET_AUTOMATION")
            url_auto = _asset_automation_status(c, "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION")
            out.append({
                "id": str(c.get("id")), "name": c.get("name") or "(sin nombre)",
                # True / False, o None si la API no devolvió el ajuste
                "text_customization": None if text_auto is None else text_auto == "OPTED_IN",
                "final_url_expansion": None if url_auto is None else url_auto == "OPTED_IN",
                "aca_migrated": (c.get("acaMigrationDateTime") or "")[:10] or None,
                "broad_match_migrated": (c.get("broadMatchMigrationDateTime") or "")[:10] or None,
            })
        return out
    block("ai_max_campaigns", ai_max_campaigns)

    if data.get("ai_max_campaigns"):
        ai_ids = ", ".join(str(int(c["id"])) for c in data["ai_max_campaigns"])

        def ai_max_terms():
            # Términos con su origen de coincidencia (palabra clave del anunciante o IA Max), sumados por término.
            rows = _search(customer_id, f"""
                SELECT campaign.id, segments.search_term_match_source, search_term_view.search_term,
                       metrics.clicks, metrics.cost_micros, metrics.conversions
                FROM search_term_view
                WHERE {between} AND campaign.id IN ({ai_ids})
                ORDER BY metrics.cost_micros DESC LIMIT 5000
            """)
            grouped = {}
            for r in rows:
                key = (str(r.get("campaign", {}).get("id")), r.get("segments", {}).get("searchTermMatchSource") or "UNKNOWN",
                       (r.get("searchTermView", {}).get("searchTerm") or "").strip())
                m = r.get("metrics", {})
                g = grouped.setdefault(key, {"campaign_id": key[0], "source": key[1], "term": key[2], "clicks": 0, "cost": 0.0, "conversions": 0.0})
                g["clicks"] += _int_or_none(m.get("clicks")) or 0
                g["cost"] += _micros_to_units(_int_or_none(m.get("costMicros"))) or 0
                g["conversions"] += _float_or_none(m.get("conversions")) or 0
            return list(grouped.values())
        block("ai_max_terms", ai_max_terms)

        def ai_max_pages():
            rows, _total = fetch_ai_max_landing_pages(customer_id, limit=1000, date_from=date_from, date_to=date_to)
            return rows
        block("ai_max_pages", ai_max_pages)
        block("ai_max_url_exclusions", lambda: fetch_ai_max_url_exclusions(customer_id))
        block("ai_max_negatives", lambda: fetch_account_negative_keywords(customer_id))

    # Lo que sí trae la campaña en cada fila (términos, palabras clave, negativas, audiencias, PMax…): se quitan las de los experimentos terminados.
    if ended_experiments:
        ended_ids = {e["id"] for e in ended_experiments}
        for k, v in list(data.items()):
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v) and any("campaign_id" in x for x in v):
                data[k] = [x for x in v if str(x.get("campaign_id")) not in ended_ids]
    return data


def simulated_audit_data():
    """Cuenta de hotel inventada con problemas sembrados para ver el flujo
    completo sin la API: conversiones duplicadas, microconversiones
    primarias, display en una campaña Search, sin campaña de marca, etc."""
    camp = lambda i, n, ch, bid, cost, conv, val, imp, **kw: dict(
        {"id": i, "name": n, "status": "ENABLED", "channel_type": ch, "bidding": bid, "search_partners": False,
         "display_network": False, "geo_target_type": "PRESENCE_OR_INTEREST", "cost": cost, "conversions": conv,
         "conv_value": val, "impressions": imp, "clicks": int(imp * 0.03)}, **kw)
    campaigns = [
        camp("1", "Hotel Demo - CO:es - Search Genérica", "SEARCH", "MAXIMIZE_CONVERSIONS", 9800, 61, 41200, 310000, search_partners=True, display_network=True),
        camp("6", "Hotel Demo - CO:es - Search Marca", "SEARCH", "TARGET_ROAS", 1800, 40, 22400, 150000, geo_target_type="PRESENCE"),
        camp("7", "Hotel Demo - PMAX Todo Incluido", "PERFORMANCE_MAX", "MAXIMIZE_CONVERSIONS", 900, 8, 0, 90000, geo_target_type=None),
        camp("2", "Hotel Demo - CO:es - Search Todo Incluido", "SEARCH", "TARGET_SPEND", 4300, 18, 9400, 180000, search_partners=True),
        camp("3", "Hotel Demo - PMAX Reservas", "PERFORMANCE_MAX", "MAXIMIZE_CONVERSION_VALUE", 7600, 52, 38900, 520000, geo_target_type=None, budget_resource="customers/1/campaignBudgets/3"),
        camp("4", "Hotel Demo - Display Remarketing", "DISPLAY", "MAXIMIZE_CONVERSIONS", 1200, 6, 2100, 410000, geo_target_type="PRESENCE"),
        camp("5", "Hotel Demo - Search Fin de Año", "SEARCH", "TARGET_CPA", 0, 0, 0, 0, geo_target_type="PRESENCE", start_date="2024-11-02"),
        camp("8", "Hotel Demo - Search Semana Santa (nueva)", "SEARCH", "TARGET_CPA", 0, 0, 0, 0, geo_target_type="PRESENCE", start_date=datetime.date.today().isoformat()),
    ]
    return {
        "unavailable": {"customer": "Dato de ejemplo: campo no consultado en modo simulado."},
        "currency": "USD", "account_name": "Hotel Demo (simulada)", "enhanced_conversions": False,
        "campaigns": campaigns,
        "conversion_actions": [
            {"id": "11", "name": "Reserva confirmada (web)", "status": "ENABLED", "type": "WEBPAGE", "category": "PURCHASE", "primary_for_goal": True, "lookback_days": 30},
            {"id": "12", "name": "GA4 purchase", "status": "ENABLED", "type": "GOOGLE_ANALYTICS_4_PURCHASE", "category": "PURCHASE", "primary_for_goal": True, "lookback_days": 30},
            {"id": "13", "name": "Clic en WhatsApp", "status": "ENABLED", "type": "WEBPAGE", "category": "CONTACT", "primary_for_goal": True, "lookback_days": 30},
            {"id": "14", "name": "Ver disponibilidad", "status": "ENABLED", "type": "WEBPAGE", "category": "ENGAGEMENT", "primary_for_goal": False, "lookback_days": 7},
        ],
        "conversion_action_metrics": {
            "Reserva confirmada (web)": {"conversions": 85.0, "value": 91200.0},
            "GA4 purchase": {"conversions": 40.0, "value": 0.0},
            "Clic en WhatsApp": {"conversions": 12.0, "value": 0.0},
        },
        "search_terms": [
            {"term": "hotel demo cartagena", "campaign_id": "1", "cost": 1450.0, "conversions": 9.0},
            {"term": "hotel demo cartagena", "campaign_id": "6", "cost": 800.0, "conversions": 30.0},
            {"term": "hoteles todo incluido cartagena", "campaign_id": "1", "cost": 1100.0, "conversions": 4.0},
            {"term": "empleo hotel cartagena", "campaign_id": "1", "cost": 380.0, "conversions": 0.0},
            {"term": "trabajo en hoteles", "campaign_id": "2", "cost": 290.0, "conversions": 0.0},
            {"term": "hoteles gratis", "campaign_id": "1", "cost": 210.0, "conversions": 0.0},
            {"term": "hotel barato cerca del mar", "campaign_id": "2", "cost": 640.0, "conversions": 0.0},
            {"term": "hotel con piscina cartagena", "campaign_id": "1", "cost": 720.0, "conversions": 5.0},
        ],
        "network_split": [
            {"campaign_id": "1", "network": "SEARCH", "cost": 7900.0, "conversions": 55.0, "clicks": 4100},
            {"campaign_id": "1", "network": "SEARCH_PARTNERS", "cost": 1900.0, "conversions": 6.0, "clicks": 1300},
            {"campaign_id": "2", "network": "SEARCH", "cost": 3400.0, "conversions": 14.0, "clicks": 1900},
            {"campaign_id": "2", "network": "SEARCH_PARTNERS", "cost": 900.0, "conversions": 1.0, "clicks": 600},
        ],
        "keywords": [
            {"campaign_id": "2", "text": "hotel cartagena", "match_type": "BROAD", "quality_score": 4, "cost": 1500.0, "conversions": 5.0, "impressions": 52000, "clicks": 1600},
            {"campaign_id": "2", "text": "hoteles todo incluido", "match_type": "BROAD", "quality_score": 6, "cost": 1100.0, "conversions": 7.0, "impressions": 34000, "clicks": 700},
            {"campaign_id": "1", "text": "hotel demo", "match_type": "EXACT", "quality_score": 9, "cost": 900.0, "conversions": 11.0, "impressions": 3000, "clicks": 640},
            {"campaign_id": "1", "text": "hotel centro historico", "match_type": "PHRASE", "quality_score": 3, "cost": 420.0, "conversions": 1.0, "impressions": 9000, "clicks": 130},
            {"campaign_id": "1", "text": "hoteles baratos", "match_type": "BROAD", "quality_score": 7, "cost": 380.0, "conversions": 0.0, "impressions": 8000, "clicks": 210},
        ],
        "geo_performance": [
            {"country_id": "2170", "country": "Colombia", "cost": 14800.0, "clicks": 6900, "conversions": 118.0, "value": 71200.0},
            {"country_id": "2840", "country": "Estados Unidos", "cost": 820.0, "clicks": 310, "conversions": 0.0, "value": 0.0},
            {"country_id": "2484", "country": "México", "cost": 640.0, "clicks": 260, "conversions": 4.0, "value": 2900.0},
            {"country_id": "2862", "country": "Venezuela", "cost": 90.0, "clicks": 40, "conversions": 0.0, "value": 0.0},
        ],
        "adgroup_keyword_counts": [{"name": "Genéricas Cartagena", "keywords": 34}, {"name": "Marca", "keywords": 6}],
        "negatives": [{"campaign_id": "1", "text": "piscina"}],
        "lost_is": [{"campaign_id": "1", "budget_lost": 0.27, "rank_lost": 0.08}, {"campaign_id": "2", "budget_lost": 0.04, "rank_lost": 0.31}],
        "device_performance": [
            {"device": "MOBILE", "cost": 10200.0, "clicks": 5400, "conversions": 71.0, "value": 40100.0},
            {"device": "DESKTOP", "cost": 5200.0, "clicks": 1900, "conversions": 49.0, "value": 33800.0},
            {"device": "TABLET", "cost": 950.0, "clicks": 260, "conversions": 2.0, "value": 1100.0},
        ],
        "previous_period": {"cost": 14100.0, "conversions": 138.0, "value": 88000.0, "date_from": "2026-08-14", "date_to": "2026-09-12"},
        "campaign_languages": [{"campaign_id": "1"}, {"campaign_id": "2"}],
        "assets": [{"field_type": "SITELINK"}, {"field_type": "SITELINK"}, {"field_type": "CALLOUT"}],
        # Dos recomendaciones de riesgo alto y una de riesgo medio, para ver la regla F1 y poder probar el botón de pausarlas.
        "recommendation_subscriptions": [{"type": "MAXIMIZE_CLICKS_OPT_IN", "status": "ENABLED"}, {"type": "KEYWORD", "status": "ENABLED"},
                                         {"type": "SITELINK_ASSET", "status": "ENABLED"}, {"type": "CALLOUT_ASSET", "status": "PAUSED"}],
        "pmax_asset_groups": [
            {"id": "g1", "name": "Habitaciones y vistas", "campaign_id": "3", "ad_strength": "POOR", "impressions": 310000, "cost": 5200.0, "conversions": 4.0, "conv_value": 2800.0},
            {"id": "g2", "name": "Marca", "campaign_id": "3", "ad_strength": "EXCELLENT", "impressions": 190000, "cost": 2400.0, "conversions": 48.0, "conv_value": 36100.0},
            {"id": "g3", "name": "Plan todo incluido", "campaign_id": "7", "ad_strength": "AVERAGE", "impressions": 90000, "cost": 900.0, "conversions": 8.0, "conv_value": 0.0},
        ],
        "pmax_assets": (
            [{"asset_group_id": "g1", "field_type": "HEADLINE", "label": "LOW"}] * 3
            + [{"asset_group_id": "g1", "field_type": "DESCRIPTION", "label": "GOOD"}] * 2
            + [{"asset_group_id": "g1", "field_type": "MARKETING_IMAGE", "label": "LOW"}] * 1
            + [{"asset_group_id": "g1", "field_type": "SQUARE_MARKETING_IMAGE", "label": "GOOD"}] * 2
            + [{"asset_group_id": "g2", "field_type": "HEADLINE", "label": "GOOD"}] * 8
            + [{"asset_group_id": "g2", "field_type": "DESCRIPTION", "label": "GOOD"}] * 4
            + [{"asset_group_id": "g2", "field_type": ft, "label": "GOOD"} for ft in ("MARKETING_IMAGE", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "YOUTUBE_VIDEO")]
            + [{"asset_group_id": "g3", "field_type": "HEADLINE", "label": "GOOD"}] * 5
            + [{"asset_group_id": "g3", "field_type": "DESCRIPTION", "label": "GOOD"}] * 4
            + [{"asset_group_id": "g3", "field_type": ft, "label": "GOOD"} for ft in ("MARKETING_IMAGE", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE")]
        ),
        "pmax_signals": [{"asset_group_id": "g2"}],
        "user_lists": [
            {"resource": "customers/1/userLists/1", "name": "Todos los visitantes", "type": "RULE_BASED", "status": "OPEN", "size_search": 3100, "size_display": 1500, "life_span": 30},
            {"resource": "customers/1/userLists/2", "name": "Carrito abandonado", "type": "REMARKETING", "status": "OPEN", "size_search": 200, "size_display": 270, "life_span": 90},
            {"resource": "customers/1/userLists/3", "name": "Clientes 2026", "type": "CRM_BASED", "status": "OPEN", "size_search": 2700, "size_display": 2200, "life_span": 540},
            {"resource": "customers/1/userLists/4", "name": "AdWords optimized list", "type": "LOGICAL", "status": "OPEN", "size_search": 350000, "size_display": 110000, "life_span": 30},
        ],
        "audience_criteria": [
            {"level": "campaign", "campaign_id": "1", "campaign": "Hotel Demo - CO:es - Search Genérica", "channel": "SEARCH", "ad_group_id": None, "ad_group": "", "negative": False, "list": "customers/1/userLists/2"},
            {"level": "ad_group", "campaign_id": "2", "campaign": "Hotel Demo - CO:es - Search Todo Incluido", "channel": "SEARCH", "ad_group_id": "20", "ad_group": "Remarketing", "negative": False, "list": "customers/1/userLists/1"},
        ],
        "audience_modes": {"20": "targeting"},
        "ai_max_campaigns": [
            {"id": "1", "name": "Hotel Demo - CO:es - Search Genérica", "text_customization": True, "final_url_expansion": True, "aca_migrated": None, "broad_match_migrated": None},
            {"id": "6", "name": "Hotel Demo - CO:es - Search Marca", "text_customization": True, "final_url_expansion": False, "aca_migrated": "2026-09-12", "broad_match_migrated": None},
        ],
        "ai_max_terms": [
            {"campaign_id": "1", "source": "ADVERTISER_PROVIDED_KEYWORD", "term": "hotel demo cartagena", "clicks": 600, "cost": 2400.0, "conversions": 30.0},
            {"campaign_id": "1", "source": "AI_MAX_BROAD_MATCH", "term": "hoteles baratos", "clicks": 260, "cost": 2200.0, "conversions": 0.0},
            {"campaign_id": "1", "source": "AI_MAX_KEYWORDLESS", "term": "empleo en hoteles de cartagena", "clicks": 120, "cost": 900.0, "conversions": 0.0},
            {"campaign_id": "1", "source": "AI_MAX_KEYWORDLESS", "term": "hotel con piscina centro historico", "clicks": 90, "cost": 700.0, "conversions": 4.0},
            {"campaign_id": "6", "source": "ADVERTISER_PROVIDED_KEYWORD", "term": "hotel demo", "clicks": 400, "cost": 700.0, "conversions": 30.0},
            {"campaign_id": "6", "source": "AI_MAX_BROAD_MATCH", "term": "hotel demo reservas", "clicks": 80, "cost": 300.0, "conversions": 9.0},
        ],
        "ai_max_pages": [
            {"campaign_id": "1", "campaign_name": "Hotel Demo - CO:es - Search Genérica", "page": "https://www.hoteldemo.com/blog/que-hacer-en-cartagena", "impressions": 9000, "clicks": 140, "cost": 820.0, "conversions": 0.0},
            {"campaign_id": "1", "campaign_name": "Hotel Demo - CO:es - Search Genérica", "page": "https://www.hoteldemo.com/habitaciones", "impressions": 40000, "clicks": 900, "cost": 3900.0, "conversions": 34.0},
        ],
        "ai_max_url_exclusions": [],
        "ai_max_negatives": [{"campaign_id": "1", "campaign_name": "Hotel Demo - CO:es - Search Genérica", "text": "empleo", "match_type": "EXACT"}],
        "pmax_signal_lists": {"g2": [], "g3": ["customers/1/userLists/1"]},
        "pmax_lost_is": [{"campaign_id": "3", "budget_lost": 0.22}, {"campaign_id": "7", "budget_lost": 0.02}],
        "pmax_brand_lists": [],
        "pmax_categories": [
            {"campaign_id": "3", "term": "hotel demo cartagena", "impressions": 4200},
            {"campaign_id": "3", "term": "hoteles en cartagena", "impressions": 6100},
            {"campaign_id": "3", "term": "hotel todo incluido", "impressions": 3000},
        ],
        "pmax_placements": {"WEBSITE": 52000, "MOBILE_APPLICATION": 31000, "YOUTUBE_VIDEO": 17000},
        "pmax_changes": (
            [{"type": "CAMPAIGN_BUDGET", "resource": "customers/1/campaignBudgets/3", "fields": "amountMicros"}] * 4
            + [{"type": "CAMPAIGN", "resource": "customers/1/campaigns/3", "fields": "maximizeConversionValue.targetRoas"}] * 2
        ),
    }


# ---------------------------------------------------------------------------
# Hoteles — modificadores de oferta (AdGroupBidModifier, v26)
#
# Los modificadores de hotel (ventana de reserva, duración de la estancia,
# día de entrada, fechas elegidas por el usuario, rango de fechas de entrada)
# viven a nivel de GRUPO DE ANUNCIOS. La herramienta los edita por campaña:
# un mismo valor para ese tramo en todos los grupos de anuncios de la campaña.
#
# Nombres v26 (en v25 se llamaban hotel_advance_booking_window,
# hotel_length_of_stay, hotel_check_in_day, hotel_date_selection_type y
# hotel_check_in_date_range — los valores y los IDs de criterio no cambiaron).
#
# Cuentas con plantilla externa: en 30 de las 249 cuentas con modificadores
# que se escanearon (2026-11) hay una plantilla idéntica de valores aplicada
# de forma masiva por otra herramienta o socio. Escribir encima de esa
# plantilla se pisaría con el siguiente ciclo de esa herramienta, así que en
# esas cuentas la sección queda de solo lectura (ver hotel_template_locked).
# ---------------------------------------------------------------------------

# Los criterios 30000, 30001 y 30002 son los modificadores de dispositivo
# (escritorio, móvil, tablet) — viven en la misma tabla pero no son de hotel.
HOTEL_NON_HOTEL_CRITERION_IDS = "30000, 30001, 30002"

HOTEL_MODIFIER_TYPES = {
    "ventana": {
        "api": "advanceBookingWindow",
        "label": "Ventana de reserva",
        "help": "Días entre la búsqueda y la entrada al hotel.",
        "min": 0.1, "max": 10.0, "zero_ok": True,
    },
    "estancia": {
        "api": "lengthOfBooking",
        "label": "Duración de la estancia",
        "help": "Noches de la estancia buscada.",
        "min": 0.1, "max": 10.0, "zero_ok": True,
    },
    "dia": {
        "api": "startDayOfWeek",
        "label": "Día de entrada",
        "help": "Día de la semana en que empieza la estancia.",
        "min": 0.1, "max": 10.0, "zero_ok": True,
    },
    "fechas_usuario": {
        "api": "userSetDates",
        "label": "Fechas elegidas por el usuario",
        "help": "Si quien busca eligió fechas, o Google usó unas por defecto.",
        "min": 0.5, "max": 2.0, "zero_ok": False,
    },
    "rango_fechas": {
        "api": "startDateRange",
        "label": "Rango de fechas de entrada",
        "help": "Tramos de fechas concretas (temporadas, puentes). Solo lectura en esta versión.",
        "min": 0.1, "max": 10.0, "zero_ok": True,
    },
}
HOTEL_MODIFIER_TYPE_ORDER = ["ventana", "estancia", "dia", "fechas_usuario", "rango_fechas"]
HOTEL_EDITABLE_TYPES = {"ventana", "estancia", "dia", "fechas_usuario"}
HOTEL_DAY_ORDER = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
HOTEL_DAY_LABELS_ES = {
    "MONDAY": "Lunes", "TUESDAY": "Martes", "WEDNESDAY": "Miércoles", "THURSDAY": "Jueves",
    "FRIDAY": "Viernes", "SATURDAY": "Sábado", "SUNDAY": "Domingo",
}
HOTEL_DATE_SELECTION_LABELS_ES = {
    "DEFAULT_SELECTION": "Fechas por defecto (el usuario no eligió)",
    "USER_SELECTED": "El usuario eligió las fechas",
}

HOTEL_MODIFIER_FIELDS = """
    ad_group.id, ad_group.name, ad_group.status,
    ad_group_bid_modifier.resource_name, ad_group_bid_modifier.criterion_id,
    ad_group_bid_modifier.bid_modifier,
    ad_group_bid_modifier.advance_booking_window.min_days, ad_group_bid_modifier.advance_booking_window.max_days,
    ad_group_bid_modifier.length_of_booking.min_days, ad_group_bid_modifier.length_of_booking.max_days,
    ad_group_bid_modifier.start_day_of_week.day_of_week,
    ad_group_bid_modifier.user_set_dates.type,
    ad_group_bid_modifier.start_date_range.start_date, ad_group_bid_modifier.start_date_range.end_date
"""

# Firma de la plantilla externa: tres valores concretos que, juntos, casi
# seguro vienen de la misma herramienta (en el escaneo de 249 cuentas con
# modificadores, 30 cuentas tenían la primera, 29 las dos primeras). Se
# declara bloqueada la cuenta si salen DOS de las tres.
_HOTEL_TEMPLATE_SIGNATURES = [
    ("advance_booking_window", 3, 7, 0.57),
    ("length_of_booking", 8, 30, 0.23),
    ("advance_booking_window", 50, 330, 1.21),
]
_HOTEL_TEMPLATE_CACHE = {}
_HOTEL_TEMPLATE_CACHE_SECONDS = 600


def _hotel_valid_id(value):
    value = str(value or "").strip()
    if not value.isdigit():
        raise ValueError("ID inválido.")
    return value


def _hotel_modifier_key(m):
    """(tipo, etiqueta del tramo) de un AdGroupBidModifier ya parseado — o None
    si no es un modificador de hotel conocido."""
    if "advanceBookingWindow" in m:
        a = m["advanceBookingWindow"]
        return "ventana", f"{a.get('minDays', 0)}-{a.get('maxDays', '+')}"
    if "lengthOfBooking" in m:
        a = m["lengthOfBooking"]
        return "estancia", f"{a.get('minDays', 0)}-{a.get('maxDays', '+')}"
    if "startDayOfWeek" in m:
        return "dia", m["startDayOfWeek"].get("dayOfWeek", "?")
    if "userSetDates" in m:
        return "fechas_usuario", m["userSetDates"].get("type", "?")
    if "startDateRange" in m:
        a = m["startDateRange"]
        return "rango_fechas", f"{a.get('startDate', '?')}..{a.get('endDate', '?')}"
    return None


def _hotel_range(label):
    """'3-7' -> (3, 7); '50-+' -> (50, None)."""
    lo, _, hi = str(label).partition("-")
    try:
        lo_n = int(lo)
    except ValueError:
        return None
    return lo_n, (int(hi) if hi.lstrip("-").isdigit() else None)


def _hotel_tramo_sort_key(tipo, label):
    if tipo == "dia":
        return HOTEL_DAY_ORDER.index(label) if label in HOTEL_DAY_ORDER else 99
    if tipo == "fechas_usuario":
        return 0 if label == "DEFAULT_SELECTION" else 1
    r = _hotel_range(label)
    return r[0] if r else 9999


def _hotel_tramo_text(tipo, label):
    if tipo == "dia":
        return HOTEL_DAY_LABELS_ES.get(label, label)
    if tipo == "fechas_usuario":
        return HOTEL_DATE_SELECTION_LABELS_ES.get(label, label)
    if tipo in ("ventana", "estancia"):
        r = _hotel_range(label)
        if not r:
            return label
        lo, hi = r
        unit = "día" if tipo == "ventana" else "noche"
        if tipo == "ventana" and lo == 0 and hi == 0:
            return "Mismo día"
        if hi is None:
            return f"{lo} {unit}s o más"
        if lo == hi:
            return f"{lo} {unit}" + ("" if lo == 1 else "s")
        return f"{lo} a {hi} {unit}s"
    return label


def _hotel_criterion_object(tipo, label):
    """El sub-objeto de criterio (camelCase de la API REST) para CREAR un modificador."""
    if tipo in ("ventana", "estancia"):
        r = _hotel_range(label)
        if not r:
            raise ValueError(f"Tramo inválido: {label}.")
        obj = {"minDays": r[0]}
        if r[1] is not None:
            obj["maxDays"] = r[1]
        return obj
    if tipo == "dia":
        if label not in HOTEL_DAY_ORDER:
            raise ValueError(f"Día inválido: {label}.")
        return {"dayOfWeek": label}
    if tipo == "fechas_usuario":
        if label not in HOTEL_DATE_SELECTION_LABELS_ES:
            raise ValueError(f"Tipo de selección de fechas inválido: {label}.")
        return {"type": label}
    raise ValueError("Este tipo de modificador no se puede crear desde la plataforma.")


def hotel_template_locked(customer_id):
    """True si la cuenta tiene la plantilla externa de modificadores (ver nota
    de sección). Tres consultas pequeñas con LIMIT 1, en caché 10 minutos.
    Si una consulta falla no se asume nada: se cuenta como "no encontrada"
    (la escritura igual pasa por la vista previa de Google)."""
    customer_id = _hotel_valid_id(customer_id)
    now = time.time()
    cached = _HOTEL_TEMPLATE_CACHE.get(customer_id)
    if cached and now - cached[0] < _HOTEL_TEMPLATE_CACHE_SECONDS:
        return cached[1]
    hits = 0
    for field, lo, hi, val in _HOTEL_TEMPLATE_SIGNATURES:
        query = f"""
            SELECT ad_group_bid_modifier.bid_modifier
            FROM ad_group_bid_modifier
            WHERE campaign.advertising_channel_type = 'HOTEL'
              AND ad_group_bid_modifier.{field}.min_days = {lo}
              AND ad_group_bid_modifier.{field}.max_days = {hi}
              AND ad_group_bid_modifier.bid_modifier > {val - 0.005}
              AND ad_group_bid_modifier.bid_modifier < {val + 0.005}
            LIMIT 1
        """
        try:
            if _search(customer_id, query):
                hits += 1
        except RuntimeError:
            pass
    locked = hits >= 2
    _HOTEL_TEMPLATE_CACHE[customer_id] = (now, locked)
    return locked


def fetch_hotel_campaigns(customer_id, date_from, date_to):
    """Campañas de hotel (HOTEL) de la cuenta con sus métricas del periodo,
    más si la cuenta está bloqueada por plantilla externa."""
    customer_id = _hotel_valid_id(customer_id)
    camp_rows = _search(customer_id, """
        SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type
        FROM campaign
        WHERE campaign.advertising_channel_type = 'HOTEL' AND campaign.status != 'REMOVED'
    """)
    currency = ""
    try:
        cur = _search(customer_id, "SELECT customer.currency_code FROM customer LIMIT 1")
        if cur:
            currency = cur[0].get("customer", {}).get("currencyCode", "")
    except RuntimeError:
        pass
    metrics = {}
    metric_rows = _search(customer_id, f"""
        SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros,
               metrics.conversions, metrics.conversions_value
        FROM hotel_performance_view
        WHERE segments.date BETWEEN '{date_from}' AND '{date_to}'
    """)
    for r in metric_rows:
        cid = r["campaign"]["id"]
        m, acc = r["metrics"], metrics.setdefault(cid, {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0})
        acc["impressions"] += int(m.get("impressions", 0))
        acc["clicks"] += int(m.get("clicks", 0))
        acc["cost"] += int(m.get("costMicros", 0)) / MICROS
        acc["conversions"] += float(m.get("conversions", 0))
        acc["conv_value"] += float(m.get("conversionsValue", 0))
    campaigns = []
    for r in camp_rows:
        c = r["campaign"]
        mt = metrics.get(c["id"], {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0})
        campaigns.append({
            "campaign_id": c["id"], "campaign_name": c.get("name", ""), "status": c.get("status", ""),
            "bidding_strategy_type": c.get("biddingStrategyType", ""),
            **mt,
        })
    campaigns.sort(key=lambda x: -x["cost"])
    return {"campaigns": campaigns, "currency": currency, "template_locked": hotel_template_locked(customer_id)}


def _fetch_hotel_modifier_rows(customer_id, campaign_id):
    """Todos los modificadores de hotel de los grupos de anuncios (no
    eliminados) de una campaña, ya parseados."""
    rows = _search(customer_id, f"""
        SELECT {HOTEL_MODIFIER_FIELDS}
        FROM ad_group_bid_modifier
        WHERE campaign.id = {campaign_id}
          AND ad_group.status != 'REMOVED'
          AND ad_group_bid_modifier.criterion_id NOT IN ({HOTEL_NON_HOTEL_CRITERION_IDS})
    """)
    out = []
    for r in rows:
        m = r["adGroupBidModifier"]
        key = _hotel_modifier_key(m)
        if key is None:
            continue
        out.append({
            "ad_group_id": r["adGroup"]["id"],
            "ad_group_name": r["adGroup"].get("name", ""),
            "resource_name": m["resourceName"],
            "type": key[0], "label": key[1],
            "value": round(m["bidModifier"], 2) if "bidModifier" in m else None,
        })
    return out


def _hotel_perf_by_segment(customer_id, campaign_id, date_from, date_to):
    """Rendimiento de la campaña por tramo, de hotel_performance_view. Devuelve
    {tipo: {valor_del_segmento: acumulado}}, con valor_del_segmento int (ventana,
    estancia) o str (día, tipo de selección de fechas)."""
    specs = {
        "ventana": ("segments.hotel_booking_window_days", "hotelBookingWindowDays", int),
        "estancia": ("segments.hotel_length_of_stay", "hotelLengthOfStay", int),
        "dia": ("segments.hotel_check_in_day_of_week", "hotelCheckInDayOfWeek", str),
        "fechas_usuario": ("segments.hotel_date_selection_type", "hotelDateSelectionType", str),
    }
    out = {}
    for tipo, (seg, jkey, cast) in specs.items():
        try:
            rows = _search(customer_id, f"""
                SELECT campaign.id, {seg}, metrics.impressions, metrics.clicks, metrics.cost_micros,
                       metrics.conversions, metrics.conversions_value
                FROM hotel_performance_view
                WHERE campaign.id = {campaign_id} AND segments.date BETWEEN '{date_from}' AND '{date_to}'
            """)
        except RuntimeError:
            out[tipo] = None  # el desglose falló: se muestra como no disponible, no como cero
            continue
        agg = {}
        for r in rows:
            raw = r.get("segments", {}).get(jkey)
            if raw is None:
                continue
            val = cast(raw)
            m = r["metrics"]
            a = agg.setdefault(val, {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0})
            a["impressions"] += int(m.get("impressions", 0))
            a["clicks"] += int(m.get("clicks", 0))
            a["cost"] += int(m.get("costMicros", 0)) / MICROS
            a["conversions"] += float(m.get("conversions", 0))
            a["conv_value"] += float(m.get("conversionsValue", 0))
        out[tipo] = agg
    return out


def _hotel_perf_for_tramo(perf_by_type, tipo, label):
    """Acumulado del rendimiento que cae dentro de un tramo, o None si no se tiene."""
    seg = perf_by_type.get(tipo)
    if seg is None or tipo == "rango_fechas":
        return None
    total = {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0}
    if tipo in ("ventana", "estancia"):
        r = _hotel_range(label)
        if not r:
            return None
        lo, hi = r
        for val, a in seg.items():
            if val >= lo and (hi is None or val <= hi) and val >= 0:
                for k in total:
                    total[k] += a[k]
    else:
        a = seg.get(label)
        if a:
            total.update(a)
    return total


def fetch_hotel_campaign_modifiers(customer_id, campaign_id, date_from, date_to):
    """Perfil actual de modificadores de una campaña de hotel (un renglón por
    tramo) con el rendimiento de cada tramo en el periodo."""
    customer_id = _hotel_valid_id(customer_id)
    campaign_id = _hotel_valid_id(campaign_id)
    head = _search(customer_id, f"""
        SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type
        FROM campaign WHERE campaign.id = {campaign_id} AND campaign.advertising_channel_type = 'HOTEL'
    """)
    if not head:
        raise ValueError("No se encontró esa campaña de hotel en la cuenta.")
    ad_groups = _search(customer_id, f"""
        SELECT ad_group.id FROM ad_group WHERE campaign.id = {campaign_id} AND ad_group.status != 'REMOVED'
    """)
    n_groups = len(ad_groups)
    rows = _fetch_hotel_modifier_rows(customer_id, campaign_id)
    perf_by_type = _hotel_perf_by_segment(customer_id, campaign_id, date_from, date_to)
    totals = {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0}
    for a in (perf_by_type.get("estancia") or {}).values():
        for k in totals:
            totals[k] += a[k]

    grouped = {}
    for r in rows:
        grouped.setdefault((r["type"], r["label"]), []).append(r)
    tramos = []
    for (tipo, label), items in grouped.items():
        values = [i["value"] for i in items]
        distinct = sorted({v for v in values if v is not None})
        perf = _hotel_perf_for_tramo(perf_by_type, tipo, label)
        tramos.append({
            "type": tipo, "label": label, "text": _hotel_tramo_text(tipo, label),
            "value": distinct[0] if len(distinct) == 1 and all(v is not None for v in values) else None,
            "mixed": len(distinct) > 1 or any(v is None for v in values),
            "min_value": distinct[0] if distinct else None, "max_value": distinct[-1] if distinct else None,
            "ad_groups_with": len({i["ad_group_id"] for i in items}),
            "ad_groups_missing": max(0, n_groups - len({i["ad_group_id"] for i in items})),
            "perf": perf,
        })
    tramos.sort(key=lambda t: (HOTEL_MODIFIER_TYPE_ORDER.index(t["type"]), _hotel_tramo_sort_key(t["type"], t["label"])))
    c = head[0]["campaign"]
    return {
        "campaign_id": campaign_id, "campaign_name": c.get("name", ""), "status": c.get("status", ""),
        "bidding_strategy_type": c.get("biddingStrategyType", ""),
        "ad_groups": n_groups, "tramos": tramos, "totals": totals,
        "perf_available": {t: perf_by_type.get(t) is not None for t in ("ventana", "estancia", "dia", "fechas_usuario")},
        "template_locked": hotel_template_locked(customer_id),
    }


# Precio frente a la competencia (solo lectura): hotel_performance_view trae, por
# campaña de hotel, la diferencia de precio con el anunciante competidor más
# barato (fracción: 0,045 = el hotel es 4,5 % más caro; negativa = más barato) y
# en qué posición de precio quedó cada impresión.
HOTEL_PRICE_BUCKET_LABELS_ES = {
    "LOWEST_UNIQUE": "El más barato (único)",
    "LOWEST_TIED": "Empatado como el más barato",
    "NOT_LOWEST": "No es el más barato",
    "ONLY_PARTNER_SHOWN": "Solo se mostró tu precio",
    "UNKNOWN": "Sin dato",
}
HOTEL_PRICE_BUCKET_ORDER = ["LOWEST_UNIQUE", "LOWEST_TIED", "NOT_LOWEST", "ONLY_PARTNER_SHOWN", "UNKNOWN"]


def _hotel_price_weighted(rows, impressions_of, diff_of):
    """Diferencia de precio promedio ponderada por impresiones (None si ninguna fila la trae)."""
    num = den = 0.0
    for r in rows:
        d = diff_of(r)
        if d is None:
            continue
        w = impressions_of(r)
        num += d * w
        den += w
    return num / den if den else None


def fetch_hotel_price(customer_id, campaign_id, date_from, date_to):
    """Precio de una campaña de hotel frente a la competencia en el periodo: resumen,
    reparto por posición de precio y evolución diaria. Cada parte que Google rechace
    se devuelve como no disponible, no como cero."""
    customer_id = _hotel_valid_id(customer_id)
    campaign_id = _hotel_valid_id(campaign_id)
    where = f"campaign.id = {campaign_id} AND segments.date BETWEEN '{date_from}' AND '{date_to}'"

    summary = buckets = daily = None
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.hotel_eligible_impressions,
                   metrics.hotel_price_difference_percentage
            FROM hotel_performance_view WHERE {where}
        """)
        imp = sum(int(r["metrics"].get("impressions", 0)) for r in rows)
        summary = {
            "impressions": imp,
            "clicks": sum(int(r["metrics"].get("clicks", 0)) for r in rows),
            "eligible": sum(int(float(r["metrics"].get("hotelEligibleImpressions", 0) or 0)) for r in rows),
            "price_diff": _hotel_price_weighted(
                rows, lambda r: int(r["metrics"].get("impressions", 0)),
                lambda r: _float_or_none(r["metrics"].get("hotelPriceDifferencePercentage"))),
        }
    except RuntimeError:
        summary = None
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.id, segments.hotel_price_bucket, metrics.impressions, metrics.clicks,
                   metrics.hotel_price_difference_percentage
            FROM hotel_performance_view WHERE {where}
        """)
        agg = {}
        for r in rows:
            key = r.get("segments", {}).get("hotelPriceBucket", "UNKNOWN")
            m = r["metrics"]
            a = agg.setdefault(key, [])
            a.append((int(m.get("impressions", 0)), int(m.get("clicks", 0)), _float_or_none(m.get("hotelPriceDifferencePercentage"))))
        buckets = []
        for key in sorted(agg, key=lambda k: HOTEL_PRICE_BUCKET_ORDER.index(k) if k in HOTEL_PRICE_BUCKET_ORDER else 99):
            items = agg[key]
            buckets.append({
                "bucket": key, "label": HOTEL_PRICE_BUCKET_LABELS_ES.get(key, key),
                "impressions": sum(i[0] for i in items), "clicks": sum(i[1] for i in items),
                "price_diff": _hotel_price_weighted(items, lambda i: i[0], lambda i: i[2]),
            })
    except RuntimeError:
        buckets = None
    try:
        rows = _search(customer_id, f"""
            SELECT campaign.id, segments.date, metrics.impressions, metrics.hotel_price_difference_percentage
            FROM hotel_performance_view WHERE {where}
        """)
        by_day = {}
        for r in rows:
            day = r["segments"]["date"]
            m = r["metrics"]
            by_day.setdefault(day, []).append((int(m.get("impressions", 0)), _float_or_none(m.get("hotelPriceDifferencePercentage"))))
        daily = [{
            "date": day, "impressions": sum(i[0] for i in items),
            "price_diff": _hotel_price_weighted(items, lambda i: i[0], lambda i: i[1]),
        } for day, items in sorted(by_day.items())]
    except RuntimeError:
        daily = None
    return {"campaign_id": campaign_id, "summary": summary, "buckets": buckets, "daily": daily}


def fetch_hotel_price_account(customer_id, date_from, date_to):
    """Precio frente a la competencia de TODAS las campañas de hotel activas de una cuenta, en una sola pasada
    (para el ranking en varias cuentas). Solo lectura. Por campaña: impresiones, clics, gasto, conversiones,
    diferencia de precio promedio (ponderada por impresiones) y reparto por posición de precio."""
    customer_id = _hotel_valid_id(customer_id)
    camp_rows = _search(customer_id, """
        SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type
        FROM campaign
        WHERE campaign.advertising_channel_type = 'HOTEL' AND campaign.status = 'ENABLED'
    """)
    out = {"customer_id": customer_id, "currency": "", "campaigns": [], "summary": None}
    if not camp_rows:
        return out
    try:
        cur = _search(customer_id, "SELECT customer.currency_code FROM customer LIMIT 1")
        if cur:
            out["currency"] = cur[0].get("customer", {}).get("currencyCode", "")
    except RuntimeError:
        pass
    where = f"segments.date BETWEEN '{date_from}' AND '{date_to}'"
    per = {}
    for r in _search(customer_id, f"""
        SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
               metrics.hotel_eligible_impressions, metrics.hotel_price_difference_percentage
        FROM hotel_performance_view WHERE {where}
    """):
        m = r["metrics"]
        a = per.setdefault(r["campaign"]["id"], {"rows": [], "impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "eligible": 0})
        imp = int(m.get("impressions", 0))
        a["rows"].append((imp, _float_or_none(m.get("hotelPriceDifferencePercentage"))))
        a["impressions"] += imp
        a["clicks"] += int(m.get("clicks", 0))
        a["cost"] += int(m.get("costMicros", 0)) / MICROS
        a["conversions"] += float(m.get("conversions", 0))
        a["eligible"] += int(float(m.get("hotelEligibleImpressions", 0) or 0))
    buckets = {}
    try:
        for r in _search(customer_id, f"""
            SELECT campaign.id, segments.hotel_price_bucket, metrics.impressions, metrics.hotel_price_difference_percentage
            FROM hotel_performance_view WHERE {where}
        """):
            m = r["metrics"]
            key = r.get("segments", {}).get("hotelPriceBucket", "UNKNOWN")
            buckets.setdefault(r["campaign"]["id"], {}).setdefault(key, []).append(
                (int(m.get("impressions", 0)), _float_or_none(m.get("hotelPriceDifferencePercentage"))))
    except RuntimeError:
        buckets = None
    # Cuota de impresiones perdida por presupuesto y por ranking de cada campaña (para repartir las impresiones perdidas).
    lost = {}
    try:
        for r in _search(customer_id, f"""
            SELECT campaign.id, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share,
                   metrics.search_top_impression_share
            FROM campaign
            WHERE campaign.advertising_channel_type = 'HOTEL' AND campaign.status = 'ENABLED' AND {where}
        """):
            m = r["metrics"]
            lost[r["campaign"]["id"]] = {
                "budget": _float_or_none(m.get("searchBudgetLostImpressionShare")),
                "rank": _float_or_none(m.get("searchRankLostImpressionShare")),
                "top": _float_or_none(m.get("searchTopImpressionShare")),
            }
    except RuntimeError:
        lost = None
    campaigns, all_rows, all_buckets = [], [], {}
    for r in camp_rows:
        c = r["campaign"]
        a = per.get(c["id"])
        if not a or not a["impressions"]:
            continue
        item = {
            "campaign_id": c["id"], "campaign_name": c.get("name", ""), "bidding_strategy_type": c.get("biddingStrategyType", ""),
            "impressions": a["impressions"], "clicks": a["clicks"], "cost": a["cost"], "conversions": a["conversions"],
            "eligible": a["eligible"], "price_diff": _hotel_price_weighted(a["rows"], lambda i: i[0], lambda i: i[1]),
        }
        item.update(_hotel_missed(a["eligible"], a["impressions"], (lost or {}).get(c["id"]) if lost is not None else None))
        item.update(_hotel_bucket_shares(buckets.get(c["id"]) if buckets is not None else None))
        campaigns.append(item)
        all_rows.extend(a["rows"])
        for k, v in ((buckets or {}).get(c["id"]) or {}).items():
            all_buckets.setdefault(k, []).extend(v)
    campaigns.sort(key=lambda x: -(x["price_diff"] if x["price_diff"] is not None else -9))
    if campaigns:
        out["summary"] = {
            "impressions": sum(x["impressions"] for x in campaigns), "clicks": sum(x["clicks"] for x in campaigns),
            "cost": sum(x["cost"] for x in campaigns), "conversions": sum(x["conversions"] for x in campaigns),
            "eligible": sum(x["eligible"] for x in campaigns),
            "price_diff": _hotel_price_weighted(all_rows, lambda i: i[0], lambda i: i[1]),
            **_hotel_bucket_shares(all_buckets if buckets is not None else None),
            **_hotel_missed_total(campaigns),
        }
    out["campaigns"] = campaigns
    return out


def _hotel_missed(eligible, impressions, lost):
    """Impresiones perdidas de una campaña: las elegibles que no se mostraron. Con la cuota perdida por presupuesto y por
    ranking que informa Google se reparten en esas dos causas (cuota × elegibles) y lo que sobra queda en «otras».
    `lost` None = Google no entregó las cuotas: solo se informa el total."""
    missed = max(0, eligible - impressions)
    out = {"missed": missed, "missed_rank": None, "missed_budget": None, "missed_other": None,
           "impression_share": (impressions / eligible) if eligible else None}
    if lost is not None and (lost.get("rank") is not None or lost.get("budget") is not None):
        rank = min(missed, round((lost.get("rank") or 0) * eligible))
        budget = min(missed - rank, round((lost.get("budget") or 0) * eligible))
        out.update({"missed_rank": rank, "missed_budget": budget, "missed_other": max(0, missed - rank - budget)})
    return out


def _hotel_missed_total(campaigns):
    """Suma de las impresiones perdidas de varias campañas (los conteos sí se pueden sumar; son independientes de la moneda)."""
    eligible = sum(c["eligible"] for c in campaigns)
    imp = sum(c["impressions"] for c in campaigns)
    out = {"missed": sum(c["missed"] for c in campaigns), "impression_share": (imp / eligible) if eligible else None,
           "missed_rank": None, "missed_budget": None, "missed_other": None}
    if all(c["missed_rank"] is not None for c in campaigns):
        out["missed_rank"] = sum(c["missed_rank"] for c in campaigns)
        out["missed_budget"] = sum(c["missed_budget"] for c in campaigns)
        out["missed_other"] = sum(c["missed_other"] for c in campaigns)
    return out


def _hotel_bucket_shares(by_bucket):
    """De {posición: [(impresiones, diferencia)]} saca el % de impresiones donde no es el más barato, el % donde es
    el más barato o empata y cuánto más caro sale en las primeras. None si Google no entregó el reparto."""
    if not by_bucket:
        return {"not_lowest_share": None, "lowest_share": None, "not_lowest_diff": None}
    total = sum(i[0] for items in by_bucket.values() for i in items)
    if not total:
        return {"not_lowest_share": None, "lowest_share": None, "not_lowest_diff": None}
    imp = lambda keys: sum(i[0] for k in keys for i in by_bucket.get(k, []))  # noqa: E731
    nl = by_bucket.get("NOT_LOWEST", [])
    return {
        "not_lowest_share": imp(["NOT_LOWEST"]) / total * 100,
        "lowest_share": imp(["LOWEST_UNIQUE", "LOWEST_TIED"]) / total * 100,
        "not_lowest_diff": _hotel_price_weighted(nl, lambda i: i[0], lambda i: i[1]) if nl else None,
    }


def _hotel_month_bounds(month_from, month_to):
    """De dos meses AAAA-MM saca la primera y la última fecha (la última, como mucho hoy). ValueError con mensaje para el usuario."""
    pat = re.compile(r"^(\d{4})-(\d{2})$")
    m1, m2 = pat.match(str(month_from or "")), pat.match(str(month_to or ""))
    if not m1 or not m2 or not (1 <= int(m1.group(2)) <= 12) or not (1 <= int(m2.group(2)) <= 12):
        raise ValueError("month_from y month_to deben tener formato AAAA-MM.")
    y1, mo1, y2, mo2 = int(m1.group(1)), int(m1.group(2)), int(m2.group(1)), int(m2.group(2))
    if (y1, mo1) > (y2, mo2):
        raise ValueError("El mes inicial no puede ser posterior al final.")
    if (y2 - y1) * 12 + (mo2 - mo1) + 1 > 36:
        raise ValueError("El rango no puede pasar de 36 meses.")
    end = datetime.date(y2, mo2, calendar.monthrange(y2, mo2)[1])
    return datetime.date(y1, mo1, 1).isoformat(), min(end, datetime.date.today()).isoformat()


def fetch_hotel_share_monthly(customer_id, month_from, month_to):
    """Impresiones elegibles e impresiones de todas las campañas de hotel de la cuenta, mes a mes (también las pausadas hoy,
    para que el histórico sea comparable). La cuota de impresiones de cada mes es impresiones ÷ elegibles. Solo lectura."""
    customer_id = _hotel_valid_id(customer_id)
    d_from, d_to = _hotel_month_bounds(month_from, month_to)
    months = {}
    for r in _search(customer_id, f"""
        SELECT segments.month, metrics.impressions, metrics.hotel_eligible_impressions
        FROM hotel_performance_view WHERE segments.date BETWEEN '{d_from}' AND '{d_to}'
    """):
        key = str(r["segments"]["month"])[:7]
        m = r["metrics"]
        a = months.setdefault(key, {"eligible": 0, "impressions": 0})
        a["impressions"] += int(m.get("impressions", 0))
        a["eligible"] += int(float(m.get("hotelEligibleImpressions", 0) or 0))
    return {"customer_id": customer_id, "months": months}


def simulated_hotel_itinerary(customer_id, date_from=None, date_to=None):
    """Datos de ejemplo de la vista de anticipación y estadía: las dos campañas de ejemplo repartidas por tramo, con una forma
    reconocible (muchas reservas con poca anticipación, mejor ROAS con estadías largas y entre semana) y totales que coinciden
    con los de cada campaña."""
    import zlib
    shapes = {
        "window": [0.10, 0.22, 0.20, 0.17, 0.13, 0.09, 0.05, 0.03, 0.01], "stay": [0.34, 0.26, 0.17, 0.09, 0.05, 0.03, 0.03, 0.02, 0.01],
        "dow": [0.13, 0.17, 0.15, 0.14, 0.16, 0.15, 0.10],
    }
    quality = {  # peso relativo de conversiones por tramo (el gasto sigue la forma de arriba)
        "window": [0.6, 1.3, 1.5, 1.3, 1.0, 0.8, 0.4, 0.2, 0.1], "stay": [0.6, 1.0, 1.3, 1.5, 1.6, 1.8, 1.4, 0.8, 0.2],
        "dow": [1.1, 1.2, 1.1, 1.0, 0.8, 0.7, 0.9],
    }
    camps = [c for c in _SIM_HOTEL_CAMPAIGNS]
    out = {"customer_id": str(customer_id), "currency": "USD", "campaigns": [{"id": c["campaign_id"], "name": c["campaign_name"], "status": c["status"]} for c in camps],
           "buckets": {d: _hotel_itin_bucket_list(d) for d in HOTEL_ITIN_DIMS}, "titles": {d: v["title"] for d, v in HOTEL_ITIN_DIMS.items()}, "data": {}, "errors": []}
    for dim in HOTEL_ITIN_DIMS:
        keys = [b["key"] for b in out["buckets"][dim]][:-1]
        agg = {}
        for c in camps:
            h = zlib.crc32(f"{customer_id}:{c['campaign_id']}:{dim}".encode())
            w = [shapes[dim][i] * (0.85 + ((h >> i) % 31) / 100) for i in range(len(keys))]
            q = [quality[dim][i] * w[i] for i in range(len(keys))]
            sw, sq = sum(w), sum(q)
            rows = {}
            for i, k in enumerate(keys):
                share, qshare = w[i] / sw, q[i] / sq
                conv = c["conversions"] * qshare
                rows[k] = {"impressions": int(round(c["impressions"] * share)), "clicks": int(round(c["clicks"] * share)), "cost": round(c["cost"] * share, 2),
                           "conversions": round(conv, 1), "conv_value": round(c["conv_value"] * qshare, 2)}
            rows["na"] = {"impressions": 40, "clicks": 1, "cost": 0.6, "conversions": 0.0, "conv_value": 0.0} if dim == "window" else None
            if rows["na"] is None:
                del rows["na"]
            agg[c["campaign_id"]] = rows
        out["data"][dim] = agg
    return out


def simulated_hotel_share_monthly(customer_id, month_from, month_to):
    """Cuota mensual de ejemplo: cada cuenta simulada tiene un nivel y una caída reciente distintos; una llega a más de 100 %."""
    d_from, d_to = _hotel_month_bounds(month_from, month_to)
    start, end = datetime.date.fromisoformat(d_from), datetime.date.fromisoformat(d_to)
    seed = sum(int(ch) for ch in str(customer_id) if ch.isdigit()) % 9
    months, y, m = {}, start.year, start.month
    if str(customer_id)[-1:] == "7":
        return {"customer_id": str(customer_id), "months": {}}  # una cuenta sin datos de hotel
    while datetime.date(y, m, 1) <= end:
        i = (y - 2025) * 12 + m
        share = 0.93 - 0.02 * seed + 0.03 * ((i * 5 + seed) % 4) / 3 - (0.02 * max(0, i - 20) * (1 + seed % 3))
        if seed == 8 and m == 8:
            share = 1.01
        eligible = 30000 + 4000 * ((i + seed) % 5)
        months[f"{y}-{m:02d}"] = {"eligible": eligible, "impressions": round(eligible * max(0.2, share))}
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return {"customer_id": str(customer_id), "months": months}


# ---- Hoteles: anticipación de la reserva, duración de la estadía y día de entrada --------------------------------------------------
# Rendimiento de las campañas de hotel por tramos fijos, de hotel_performance_view. No depende de los modificadores de puja: sirve
# también para campañas que no tienen ninguno. (Los segmentos nuevos de v25.2/v26.2 para estas mismas dimensiones no devuelven datos
# en campañas de tipo Hotel; esta vista usa los segmentos hotel_* de siempre, comprobados con datos reales.)
HOTEL_ITIN_WINDOW = [("0", "Mismo día", 0, 0), ("1-3", "1 a 3 días", 1, 3), ("4-7", "4 a 7 días", 4, 7), ("8-14", "8 a 14 días", 8, 14),
                     ("15-30", "15 a 30 días", 15, 30), ("31-60", "31 a 60 días", 31, 60), ("61-90", "61 a 90 días", 61, 90),
                     ("91-180", "91 a 180 días", 91, 180), ("181+", "Más de 180 días", 181, None)]
HOTEL_ITIN_STAY = [("1", "1 noche", 1, 1), ("2", "2 noches", 2, 2), ("3", "3 noches", 3, 3), ("4", "4 noches", 4, 4), ("5", "5 noches", 5, 5),
                   ("6", "6 noches", 6, 6), ("7", "7 noches", 7, 7), ("8-14", "8 a 14 noches", 8, 14), ("15+", "15 noches o más", 15, None)]
HOTEL_ITIN_NA = ("na", "Sin dato")
HOTEL_ITIN_DIMS = {
    "window": {"seg": "segments.hotel_booking_window_days", "json": "hotelBookingWindowDays", "title": "Anticipación de la reserva", "ranges": HOTEL_ITIN_WINDOW},
    "stay": {"seg": "segments.hotel_length_of_stay", "json": "hotelLengthOfStay", "title": "Duración de la estadía", "ranges": HOTEL_ITIN_STAY},
    "dow": {"seg": "segments.hotel_check_in_day_of_week", "json": "hotelCheckInDayOfWeek", "title": "Día de entrada", "ranges": None},
}


def _hotel_itin_bucket(dim, raw):
    """Clave del tramo en que cae el valor `raw` que devuelve Google (días o noches como número; día de la semana como texto)."""
    if dim == "dow":
        return raw if raw in HOTEL_DAY_ORDER else HOTEL_ITIN_NA[0]
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return HOTEL_ITIN_NA[0]
    if n < 0 or (dim == "stay" and n < 1):
        return HOTEL_ITIN_NA[0]  # Google usa -1 cuando no tiene el dato
    for key, _label, lo, hi in HOTEL_ITIN_DIMS[dim]["ranges"]:
        if n >= lo and (hi is None or n <= hi):
            return key
    return HOTEL_ITIN_NA[0]


def _hotel_itin_bucket_list(dim):
    if dim == "dow":
        out = [{"key": d, "label": HOTEL_DAY_LABELS_ES[d]} for d in HOTEL_DAY_ORDER]
    else:
        out = [{"key": k, "label": label} for k, label, _lo, _hi in HOTEL_ITIN_DIMS[dim]["ranges"]]
    out.append({"key": HOTEL_ITIN_NA[0], "label": HOTEL_ITIN_NA[1]})
    return out


def fetch_hotel_itinerary(customer_id, date_from, date_to):
    """Para cada campaña de hotel con actividad en el rango: impresiones, clics, gasto, conversiones y valor por tramo de anticipación
    de la reserva, de duración de la estadía y de día de entrada. Cada dimensión es una consulta a hotel_performance_view (las tres salen
    a la vez). Si una falla, esa dimensión queda en None y las otras siguen. Solo lectura."""
    customer_id = _hotel_valid_id(customer_id)
    names = {}
    for r in _search(customer_id, """
        SELECT campaign.id, campaign.name, campaign.status
        FROM campaign WHERE campaign.advertising_channel_type = 'HOTEL' AND campaign.status != 'REMOVED'
    """):
        c = r.get("campaign", {})
        names[str(c.get("id"))] = {"id": str(c.get("id")), "name": c.get("name") or "(sin nombre)", "status": c.get("status")}
    out = {"customer_id": customer_id, "currency": "", "campaigns": [], "buckets": {d: _hotel_itin_bucket_list(d) for d in HOTEL_ITIN_DIMS},
           "titles": {d: v["title"] for d, v in HOTEL_ITIN_DIMS.items()}, "data": {}, "errors": []}
    if not names:
        out["data"] = {d: {} for d in HOTEL_ITIN_DIMS}
        return out
    try:
        cur = _search(customer_id, "SELECT customer.currency_code FROM customer LIMIT 1")
        if cur:
            out["currency"] = cur[0].get("customer", {}).get("currencyCode", "")
    except RuntimeError:
        pass

    def one(dim):
        spec = HOTEL_ITIN_DIMS[dim]
        try:
            rows = _search(customer_id, f"""
                SELECT campaign.id, {spec['seg']}, metrics.impressions, metrics.clicks, metrics.cost_micros,
                       metrics.conversions, metrics.conversions_value
                FROM hotel_performance_view
                WHERE segments.date BETWEEN '{date_from}' AND '{date_to}' AND metrics.impressions > 0
            """)
        except RuntimeError as e:
            return dim, None, " ".join(str(e).split())[:200]
        agg = {}
        for r in rows:
            cid = str(r.get("campaign", {}).get("id"))
            key = _hotel_itin_bucket(dim, r.get("segments", {}).get(spec["json"]))
            m = r.get("metrics", {})
            a = agg.setdefault(cid, {}).setdefault(key, {"impressions": 0, "clicks": 0, "cost": 0.0, "conversions": 0.0, "conv_value": 0.0})
            a["impressions"] += int(m.get("impressions", 0) or 0)
            a["clicks"] += int(m.get("clicks", 0) or 0)
            a["cost"] += (int(m.get("costMicros", 0) or 0)) / MICROS
            a["conversions"] += float(m.get("conversions", 0) or 0)
            a["conv_value"] += float(m.get("conversionsValue", 0) or 0)
        return dim, agg, None

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(one, HOTEL_ITIN_DIMS.keys()))
    seen = set()
    for dim, agg, err in results:
        out["data"][dim] = agg
        if err:
            out["errors"].append(f"{HOTEL_ITIN_DIMS[dim]['title']}: {err}")
        else:
            seen.update(agg.keys())
    out["campaigns"] = sorted((names[c] for c in seen if c in names), key=lambda c: c["name"].lower())
    return out


def _hotel_validate_changes(changes):
    if not isinstance(changes, list) or not changes:
        raise ValueError("No hay cambios que aplicar.")
    if len(changes) > 200:
        raise ValueError("Demasiados cambios a la vez (máximo 200 tramos).")
    clean, seen = [], set()
    for ch in changes:
        tipo, label = str(ch.get("type") or ""), str(ch.get("label") or "")
        spec = HOTEL_MODIFIER_TYPES.get(tipo)
        if not spec or tipo not in HOTEL_EDITABLE_TYPES:
            raise ValueError(f"El tipo \"{tipo}\" no se puede editar desde la plataforma.")
        if (tipo, label) in seen:
            raise ValueError(f"El tramo {label} aparece repetido.")
        seen.add((tipo, label))
        try:
            value = round(float(ch.get("value")), 2)
        except (TypeError, ValueError):
            raise ValueError(f"El valor del tramo {_hotel_tramo_text(tipo, label)} no es un número.")
        if value == 0 and not spec["zero_ok"]:
            raise ValueError(f"\"{spec['label']}\" no admite 0 (excluir): usa un valor entre {spec['min']} y {spec['max']}.")
        if value != 0 and not (spec["min"] <= value <= spec["max"]):
            zero_note = " (o 0 para no servir en ese tramo)" if spec["zero_ok"] else ""
            raise ValueError(
                f"{spec['label']} · {_hotel_tramo_text(tipo, label)}: el valor debe estar entre {spec['min']} y {spec['max']}"
                f"{zero_note} — recibido {value}."
            )
        _hotel_criterion_object(tipo, label)  # valida el tramo
        clean.append({"type": tipo, "label": label, "value": value})
    return clean


def update_hotel_campaign_modifiers(customer_id, campaign_id, changes, validate_only=True):
    """Pone el mismo valor en un tramo para TODOS los grupos de anuncios de la
    campaña: actualiza el modificador donde ya existe y lo crea donde falta.
    Vuelve a leer lo vigente en Google antes de armar las operaciones (no se
    confía en lo que mostraba el navegador). validate_only=True valida sin
    aplicar. Usa partialFailure: un grupo con problema no tumba el resto."""
    customer_id = _hotel_valid_id(customer_id)
    campaign_id = _hotel_valid_id(campaign_id)
    if hotel_template_locked(customer_id):
        raise PermissionError(
            "Esta cuenta tiene una plantilla externa de modificadores de oferta. "
            "Para no pisar ese trabajo, la plataforma solo permite verlos aquí."
        )
    clean = _hotel_validate_changes(changes)
    group_rows = _search(customer_id, f"""
        SELECT ad_group.id FROM ad_group WHERE campaign.id = {campaign_id} AND ad_group.status != 'REMOVED'
    """)
    group_ids = [r["adGroup"]["id"] for r in group_rows]
    if not group_ids:
        raise ValueError("La campaña no tiene grupos de anuncios.")
    existing = {}
    for r in _fetch_hotel_modifier_rows(customer_id, campaign_id):
        existing[(r["ad_group_id"], r["type"], r["label"])] = r

    operations, items, summary = [], [], []
    updated = created = unchanged = 0
    for ch in clean:
        tipo, label, value = ch["type"], ch["label"], ch["value"]
        spec = HOTEL_MODIFIER_TYPES[tipo]
        prev_values, n_up, n_new, n_same = set(), 0, 0, 0
        for gid in group_ids:
            cur = existing.get((gid, tipo, label))
            if cur is not None:
                prev_values.add(cur["value"])
                if cur["value"] is not None and abs(cur["value"] - value) < 0.005:
                    n_same += 1
                    continue
                operations.append({"update": {"resourceName": cur["resource_name"], "bidModifier": value}, "updateMask": "bid_modifier"})
                items.append(f"{cur['ad_group_name'] or gid} · {_hotel_tramo_text(tipo, label)}")
                n_up += 1
            else:
                operations.append({"create": {
                    "adGroup": f"customers/{customer_id}/adGroups/{gid}",
                    "bidModifier": value,
                    spec["api"]: _hotel_criterion_object(tipo, label),
                }})
                items.append(f"grupo {gid} · {_hotel_tramo_text(tipo, label)}")
                n_new += 1
        updated += n_up; created += n_new; unchanged += n_same
        summary.append({
            "type": tipo, "label": label, "text": _hotel_tramo_text(tipo, label), "new_value": value,
            "previous_values": sorted(v for v in prev_values if v is not None),
            "ad_groups_updated": n_up, "ad_groups_created": n_new, "ad_groups_unchanged": n_same,
        })
    if len(operations) > 20000:
        raise ValueError(f"El cambio tocaría {len(operations)} modificadores; el máximo por vez es 20.000. Divide los tramos.")

    failed = []
    n_failed = 0
    url = f"{BASE_URL}/customers/{customer_id}/adGroupBidModifiers:mutate"
    for start in range(0, len(operations), 2000):
        chunk_ops, chunk_items = operations[start:start + 2000], items[start:start + 2000]
        payload = _mutate_with_partial_failure(url, chunk_ops, validate_only)
        failed_idx, messages = _partial_failures(payload, chunk_items, lambda it: it)
        n_failed += len(failed_idx)
        failed.extend(m for m in messages if m not in failed)  # Google repite el mismo mensaje por operación
    return {
        "validate_only": validate_only, "applied": not validate_only,
        "updated": updated, "created": created, "unchanged": unchanged,
        "operations": len(operations), "failed_count": n_failed, "failed": failed[:20],
        "changes": summary,
    }


# Hoteles simulado — dos campañas de hotel con modificadores y rendimiento
# de ejemplo, en memoria: aplicar (validate_only=False) cambia los valores y
# la siguiente lectura ya los trae, para poder probar el flujo completo.
_SIM_HOTEL_CAMPAIGNS = [
    {"campaign_id": "9100000001", "campaign_name": "Hotel Demo - Hotel Ads - Cartagena", "status": "ENABLED",
     "bidding_strategy_type": "MANUAL_CPC", "impressions": 48200, "clicks": 1530, "cost": 2140.0, "conversions": 52.0, "conv_value": 31800.0},
    {"campaign_id": "9100000002", "campaign_name": "Hotel Demo - Hotel Ads - Santa Marta", "status": "ENABLED",
     "bidding_strategy_type": "PERCENT_CPC", "impressions": 22100, "clicks": 640, "cost": 810.0, "conversions": 11.0, "conv_value": 6200.0},
]
_SIM_HOTEL_GROUPS = {"9100000001": 4, "9100000002": 2}
_SIM_HOTEL_BASE = [
    ("ventana", "0-0", 0.8), ("ventana", "1-2", 1.0), ("ventana", "3-7", 1.0), ("ventana", "8-14", 1.0),
    ("ventana", "15-30", 1.0), ("ventana", "31-49", 1.0), ("ventana", "50-330", 1.0),
    ("estancia", "1-1", 1.0), ("estancia", "2-2", 1.0), ("estancia", "3-3", 1.0),
    ("estancia", "4-5", 1.0), ("estancia", "6-30", 1.0),
    ("dia", "MONDAY", 1.0), ("dia", "TUESDAY", 1.0), ("dia", "WEDNESDAY", 1.0), ("dia", "THURSDAY", 1.0),
    ("dia", "FRIDAY", 1.0), ("dia", "SATURDAY", 1.0), ("dia", "SUNDAY", 1.0),
    ("fechas_usuario", "DEFAULT_SELECTION", 1.0), ("fechas_usuario", "USER_SELECTED", 1.0),
]
_SIM_HOTEL_STATE = {}  # campaign_id -> {(tipo, label): value}
# Peso de impresiones por tramo para generar rendimiento de ejemplo creíble.
_SIM_HOTEL_PERF = {
    ("ventana", "0-0"): (0.14, 0.7), ("ventana", "1-2"): (0.12, 0.9), ("ventana", "3-7"): (0.20, 1.1),
    ("ventana", "8-14"): (0.18, 1.2), ("ventana", "15-30"): (0.16, 1.0), ("ventana", "31-49"): (0.12, 0.8),
    ("ventana", "50-330"): (0.08, 0.6),
    ("estancia", "1-1"): (0.38, 1.2), ("estancia", "2-2"): (0.28, 1.0), ("estancia", "3-3"): (0.16, 0.9),
    ("estancia", "4-5"): (0.12, 0.6), ("estancia", "6-30"): (0.06, 0.3),
    ("dia", "MONDAY"): (0.10, 0.9), ("dia", "TUESDAY"): (0.10, 0.9), ("dia", "WEDNESDAY"): (0.12, 1.0),
    ("dia", "THURSDAY"): (0.15, 1.1), ("dia", "FRIDAY"): (0.22, 1.2), ("dia", "SATURDAY"): (0.20, 1.0),
    ("dia", "SUNDAY"): (0.11, 0.8),
    ("fechas_usuario", "DEFAULT_SELECTION"): (0.55, 0.7), ("fechas_usuario", "USER_SELECTED"): (0.45, 1.3),
}


def _sim_hotel_state(campaign_id):
    if campaign_id not in _SIM_HOTEL_STATE:
        _SIM_HOTEL_STATE[campaign_id] = {(t, l): v for t, l, v in _SIM_HOTEL_BASE}
    return _SIM_HOTEL_STATE[campaign_id]


def simulated_hotel_campaigns(date_from=None, date_to=None):
    return {"campaigns": [dict(c) for c in _SIM_HOTEL_CAMPAIGNS], "currency": "USD", "template_locked": False}


def simulated_hotel_campaign_modifiers(campaign_id, date_from=None, date_to=None):
    camp = next((c for c in _SIM_HOTEL_CAMPAIGNS if c["campaign_id"] == campaign_id), None)
    if camp is None:
        raise ValueError("No se encontró esa campaña de hotel en la cuenta.")
    state = _sim_hotel_state(campaign_id)
    tramos = []
    for tipo, label, _ in _SIM_HOTEL_BASE:
        share, conv_idx = _SIM_HOTEL_PERF[(tipo, label)]
        perf = {
            "impressions": round(camp["impressions"] * share),
            "clicks": round(camp["clicks"] * share),
            "cost": round(camp["cost"] * share, 2),
            "conversions": round(camp["conversions"] * share * conv_idx, 1),
            "conv_value": round(camp["conv_value"] * share * conv_idx, 2),
        }
        v = state[(tipo, label)]
        tramos.append({
            "type": tipo, "label": label, "text": _hotel_tramo_text(tipo, label), "value": v, "mixed": False,
            "min_value": v, "max_value": v, "ad_groups_with": _SIM_HOTEL_GROUPS[campaign_id], "ad_groups_missing": 0, "perf": perf,
        })
    totals = {k: camp[k] for k in ("impressions", "clicks", "cost", "conversions", "conv_value")}
    return {
        "campaign_id": campaign_id, "campaign_name": camp["campaign_name"], "status": camp["status"],
        "bidding_strategy_type": camp["bidding_strategy_type"], "ad_groups": _SIM_HOTEL_GROUPS[campaign_id],
        "tramos": tramos, "totals": totals,
        "perf_available": {"ventana": True, "estancia": True, "dia": True, "fechas_usuario": True},
        "template_locked": False,
    }


def simulated_hotel_price(campaign_id, date_from=None, date_to=None):
    """Precio de ejemplo: la campaña de Cartagena sale más cara que la competencia y la de Santa Marta más barata."""
    camp = next((c for c in _SIM_HOTEL_CAMPAIGNS if c["campaign_id"] == campaign_id), None)
    if camp is None:
        raise ValueError("No se encontró esa campaña de hotel en la cuenta.")
    expensive = campaign_id == "9100000001"
    shares = ([("LOWEST_UNIQUE", 0.12, -0.062), ("LOWEST_TIED", 0.31, 0.004), ("NOT_LOWEST", 0.52, 0.094), ("ONLY_PARTNER_SHOWN", 0.05, None)]
              if expensive else
              [("LOWEST_UNIQUE", 0.46, -0.081), ("LOWEST_TIED", 0.38, 0.002), ("NOT_LOWEST", 0.13, 0.057), ("ONLY_PARTNER_SHOWN", 0.03, None)])
    imp = camp["impressions"]
    buckets = [{"bucket": k, "label": HOTEL_PRICE_BUCKET_LABELS_ES[k], "impressions": round(imp * sh),
                "clicks": round(camp["clicks"] * sh), "price_diff": d} for k, sh, d in shares]
    diff = _hotel_price_weighted(buckets, lambda b: b["impressions"], lambda b: b["price_diff"])
    start = datetime.date.fromisoformat(date_from) if date_from else datetime.date.today() - datetime.timedelta(days=30)
    end = datetime.date.fromisoformat(date_to) if date_to else datetime.date.today() - datetime.timedelta(days=1)
    n = max(1, (end - start).days + 1)
    daily = []
    for i in range(min(n, 120)):
        wave = ((i * 7) % 11 - 5) / 100.0  # oscilación determinista de ±5 puntos
        daily.append({"date": (start + datetime.timedelta(days=i)).isoformat(), "impressions": round(imp / n),
                      "price_diff": round(diff + wave, 4)})
    return {
        "campaign_id": campaign_id,
        "summary": {"impressions": imp, "clicks": camp["clicks"], "eligible": round(imp * 1.38), "price_diff": diff},
        "buckets": buckets, "daily": daily,
    }


def simulated_hotel_price_account(customer_id, date_from=None, date_to=None):
    """Ranking de ejemplo: cada cuenta simulada reparte las dos campañas de ejemplo con un desvío distinto de precio."""
    seed = sum(int(ch) for ch in str(customer_id) if ch.isdigit()) % 7
    shift = (seed - 3) * 0.012
    campaigns, all_rows, all_buckets = [], [], {}
    for camp in _SIM_HOTEL_CAMPAIGNS:
        if camp["status"] != "ENABLED":
            continue
        price = simulated_hotel_price(camp["campaign_id"], date_from, date_to)
        by_bucket = {}
        for b in price["buckets"]:
            d = None if b["price_diff"] is None else b["price_diff"] + shift
            by_bucket[b["bucket"]] = [(b["impressions"], d)]
        rows = [(i[0], i[1]) for items in by_bucket.values() for i in items]
        eligible = price["summary"]["eligible"] + seed * 900  # cada cuenta simulada pierde una parte distinta
        lost = {"rank": max(0.0, (eligible - camp["impressions"]) / eligible * 0.88), "budget": 0.0 if seed % 3 else 0.03}
        item = {
            "campaign_id": camp["campaign_id"], "campaign_name": camp["campaign_name"],
            "bidding_strategy_type": camp["bidding_strategy_type"], "impressions": camp["impressions"], "clicks": camp["clicks"],
            "cost": camp["cost"], "conversions": camp["conversions"], "eligible": eligible,
            "price_diff": _hotel_price_weighted(rows, lambda i: i[0], lambda i: i[1]),
            **_hotel_missed(eligible, camp["impressions"], lost),
            **_hotel_bucket_shares(by_bucket),
        }
        campaigns.append(item)
        all_rows.extend(rows)
        for k, v in by_bucket.items():
            all_buckets.setdefault(k, []).extend(v)
    # Una cuenta de cada ocho queda sin campañas de hotel activas, para ver ese caso en el ranking.
    if int(str(customer_id)[-1] if str(customer_id)[-1:].isdigit() else 0) % 8 == 7:
        return {"customer_id": str(customer_id), "currency": "USD", "campaigns": [], "summary": None}
    campaigns.sort(key=lambda x: -(x["price_diff"] if x["price_diff"] is not None else -9))
    return {
        "customer_id": str(customer_id), "currency": "USD", "campaigns": campaigns,
        "summary": {
            "impressions": sum(x["impressions"] for x in campaigns), "clicks": sum(x["clicks"] for x in campaigns),
            "cost": sum(x["cost"] for x in campaigns), "conversions": sum(x["conversions"] for x in campaigns),
            "eligible": sum(x["eligible"] for x in campaigns),
            "price_diff": _hotel_price_weighted(all_rows, lambda i: i[0], lambda i: i[1]),
            **_hotel_bucket_shares(all_buckets),
            **_hotel_missed_total(campaigns),
        },
    }


def simulated_update_hotel_campaign_modifiers(campaign_id, changes, validate_only=True):
    if campaign_id not in _SIM_HOTEL_GROUPS:
        raise ValueError("No se encontró esa campaña de hotel en la cuenta.")
    clean = _hotel_validate_changes(changes)
    state = _sim_hotel_state(campaign_id)
    n_groups = _SIM_HOTEL_GROUPS[campaign_id]
    summary, updated, unchanged = [], 0, 0
    for ch in clean:
        key = (ch["type"], ch["label"])
        if key not in state:
            raise ValueError(f"El tramo {_hotel_tramo_text(*key)} no existe en esta campaña (simulado).")
        prev = state[key]
        same = abs(prev - ch["value"]) < 0.005
        summary.append({
            "type": ch["type"], "label": ch["label"], "text": _hotel_tramo_text(*key), "new_value": ch["value"],
            "previous_values": [prev], "ad_groups_updated": 0 if same else n_groups, "ad_groups_created": 0,
            "ad_groups_unchanged": n_groups if same else 0,
        })
        updated += 0 if same else n_groups
        unchanged += n_groups if same else 0
        if not validate_only:
            state[key] = ch["value"]
    return {
        "validate_only": validate_only, "applied": not validate_only, "updated": updated, "created": 0,
        "unchanged": unchanged, "operations": updated, "failed_count": 0, "failed": [], "changes": summary, "simulated": True,
    }
