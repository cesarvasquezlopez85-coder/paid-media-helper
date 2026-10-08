"""Cliente mínimo de BigQuery (REST, solo librería estándar) — SOLO LECTURA.

Mismo enfoque que google_ads_client.py: `urllib` + refresh token de OAuth, sin
librerías externas. El refresh token de Google Ads NO sirve aquí (tiene solo el
scope `adwords`); hace falta uno con el scope de BigQuery — ver
`get_bigquery_refresh_token.py`.

Variables de entorno:
  BIGQUERY_PROJECT_ID      proyecto de Google Cloud donde corren (y se cobran) las consultas
  BIGQUERY_REFRESH_TOKEN   refresh token con scope https://www.googleapis.com/auth/bigquery.readonly
  BIGQUERY_CLIENT_ID       (opcional) por defecto reutiliza GOOGLE_ADS_CLIENT_ID
  BIGQUERY_CLIENT_SECRET   (opcional) por defecto reutiliza GOOGLE_ADS_CLIENT_SECRET
  BIGQUERY_LOCATION        (opcional) región de los datasets, ej. "US" o "EU"
  BIGQUERY_MAX_BYTES_BILLED (opcional) tope de bytes por consulta; por defecto 10 GB

Seguridad: el scope es readonly y, además, `run_query` rechaza cualquier
sentencia que no empiece por SELECT/WITH y fija `maximumBytesBilled`, de modo
que una consulta mal hecha falla en vez de generar costo.
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://bigquery.googleapis.com/bigquery/v2"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/bigquery.readonly"
TIMEOUT_SECONDS = 60
DEFAULT_MAX_BYTES_BILLED = 10 * 1024 ** 3  # 10 GB
MAX_ROWS = 50000

_token_cache = {"access_token": None, "expires_at": 0}
_IDENT_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _env(name, fallback_name=None):
    return os.environ.get(name) or (os.environ.get(fallback_name) if fallback_name else None)


def is_configured():
    return bool(
        os.environ.get("BIGQUERY_PROJECT_ID")
        and os.environ.get("BIGQUERY_REFRESH_TOKEN")
        and _env("BIGQUERY_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID")
        and _env("BIGQUERY_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET")
    )


def _get_access_token():
    now = time.time()
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["access_token"]
    data = urllib.parse.urlencode({
        "client_id": _env("BIGQUERY_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"),
        "client_secret": _env("BIGQUERY_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"),
        "refresh_token": os.environ["BIGQUERY_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"No se pudo renovar el token de BigQuery ({e.code}): {detail}") from e
    _token_cache["access_token"] = payload["access_token"]
    _token_cache["expires_at"] = now + payload.get("expires_in", 3600)
    return _token_cache["access_token"]


def _request(method, url, body=None):
    headers = {"Authorization": f"Bearer {_get_access_token()}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"BigQuery respondió {e.code}: {detail}") from e


def _check_ident(value, label):
    if not value or not _IDENT_RE.match(value):
        raise ValueError(f"{label} inválido.")
    return value


def _project():
    return os.environ["BIGQUERY_PROJECT_ID"]


def list_datasets(project_id=None):
    """Datasets visibles. `project_id` permite explorar otro proyecto donde
    estén los datos (la consulta se cobra a BIGQUERY_PROJECT_ID)."""
    pid = _check_ident(project_id or _project(), "project_id")
    payload = _request("GET", f"{BASE_URL}/projects/{pid}/datasets?all=false&maxResults=200")
    return [d["datasetReference"]["datasetId"] for d in payload.get("datasets", [])]


def list_tables(dataset_id, project_id=None):
    pid = _check_ident(project_id or _project(), "project_id")
    ds = _check_ident(dataset_id, "dataset_id")
    payload = _request("GET", f"{BASE_URL}/projects/{pid}/datasets/{ds}/tables?maxResults=500")
    return [
        {"table": t["tableReference"]["tableId"], "type": t.get("type")}
        for t in payload.get("tables", [])
    ]


def get_table_schema(dataset_id, table_id, project_id=None):
    pid = _check_ident(project_id or _project(), "project_id")
    ds = _check_ident(dataset_id, "dataset_id")
    tb = _check_ident(table_id, "table_id")
    payload = _request("GET", f"{BASE_URL}/projects/{pid}/datasets/{ds}/tables/{tb}")
    return {
        "numRows": payload.get("numRows"),
        "fields": [
            {"name": f["name"], "type": f["type"], "mode": f.get("mode", "NULLABLE")}
            for f in payload.get("schema", {}).get("fields", [])
        ],
    }


def run_query(sql, params=None, max_rows=1000):
    """Ejecuta una consulta SELECT/WITH con parámetros con nombre.

    params: {"nombre": ("STRING"|"INT64"|"FLOAT64"|"DATE", valor)}
    Devuelve {"columns": [...], "rows": [[...], ...], "bytesProcessed": int}.
    """
    stripped = sql.lstrip().lower()
    if not (stripped.startswith("select") or stripped.startswith("with")):
        raise ValueError("Solo se permiten consultas SELECT.")
    max_rows = min(int(max_rows), MAX_ROWS)
    max_bytes = os.environ.get("BIGQUERY_MAX_BYTES_BILLED") or DEFAULT_MAX_BYTES_BILLED
    body = {
        "query": sql,
        "useLegacySql": False,
        "maxResults": max_rows,
        "maximumBytesBilled": str(int(max_bytes)),
        "timeoutMs": 50000,
    }
    if os.environ.get("BIGQUERY_LOCATION"):
        body["location"] = os.environ["BIGQUERY_LOCATION"]
    if params:
        body["parameterMode"] = "NAMED"
        body["queryParameters"] = [
            {"name": name, "parameterType": {"type": typ}, "parameterValue": {"value": str(val)}}
            for name, (typ, val) in params.items()
        ]
    result = _request("POST", f"{BASE_URL}/projects/{_project()}/queries", body)
    if not result.get("jobComplete"):
        raise RuntimeError("La consulta de BigQuery tardó demasiado; acota el rango de fechas.")
    columns = [f["name"] for f in result.get("schema", {}).get("fields", [])]
    rows = [[cell.get("v") for cell in r["f"]] for r in result.get("rows", [])]
    return {
        "columns": columns,
        "rows": rows[:max_rows],
        "bytesProcessed": int(result.get("totalBytesProcessed") or 0),
    }


def check_connection():
    """Prueba rápida: SELECT 1 + datasets visibles. Para el botón de
    diagnóstico del administrador."""
    result = run_query("SELECT 1 AS ok", max_rows=1)
    return {"project": _project(), "ok": result["rows"] == [["1"]], "datasets": list_datasets()}
