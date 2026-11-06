#!/usr/bin/env python3
"""Autoriza el acceso de SOLO LECTURA de Paid Media Helper a Google Analytics 4,
Google Tag Manager, Search Console y BigQuery.

Qué hace, en orden:
  1. Pide el ID y el secreto del cliente OAuth (tipo "Aplicación de escritorio") que
     creaste en Google Cloud. El secreto se escribe sin que se vea en pantalla.
  2. Abre el navegador en la pantalla de consentimiento de Google. Eliges la cuenta que
     tiene acceso a los GA4, GTM, Search Console y BigQuery de los clientes y aceptas.
  3. Recibe la autorización en una dirección local (127.0.0.1) y la cambia por un
     "refresh token". Nada de esto se imprime.
  4. Comprueba, solo leyendo, qué se ve: propiedades de GA4, cuentas de GTM, sitios de
     Search Console y proyectos de BigQuery. Guarda un inventario local (sin claves).
  5. Guarda las credenciales como variables de Railway (por entrada estándar, sin
     reiniciar el servicio) o, si prefieres, en un archivo local protegido.

Permisos que pide (todos de lectura):
  analytics.readonly, tagmanager.readonly, webmasters.readonly, bigquery.readonly

Es una credencial APARTE de la de Google Ads: si hubiera que revocarla, no afecta a las
cuentas de anuncios.

Usos:
  python3 autorizar_google_lectura.py                 # autoriza y comprueba
  python3 autorizar_google_lectura.py --sin-bigquery  # sin el permiso de BigQuery
  railway run python3 autorizar_google_lectura.py --probar     # repite la comprobación con lo ya guardado
  railway run python3 autorizar_google_lectura.py --revocar    # revoca el acceso guardado

Solo usa la biblioteca estándar de Python, igual que el resto de la plataforma.
"""

import argparse
import base64
import getpass
import hashlib
import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"

SCOPES = {
    "ga4": "https://www.googleapis.com/auth/analytics.readonly",
    "gtm": "https://www.googleapis.com/auth/tagmanager.readonly",
    "gsc": "https://www.googleapis.com/auth/webmasters.readonly",
    "bq": "https://www.googleapis.com/auth/bigquery.readonly",
}

# Nombres de las variables que usará el servidor (distintos a los de Google Ads a propósito).
ENV_CLIENT_ID = "GOOGLE_READ_CLIENT_ID"
ENV_CLIENT_SECRET = "GOOGLE_READ_CLIENT_SECRET"
ENV_REFRESH_TOKEN = "GOOGLE_READ_REFRESH_TOKEN"

LOCAL_DIR = os.path.join(os.path.expanduser("~"), ".pmh_lectura")
INVENTORY_PATH = os.path.join(LOCAL_DIR, "inventario.json")
LOCAL_TOKEN_PATH = os.path.join(LOCAL_DIR, "credenciales.json")
TIMEOUT_CONSENT_SECONDS = 300


# --------------------------------------------------------------------------- utilidades ---

def _private_dir():
    os.makedirs(LOCAL_DIR, mode=0o700, exist_ok=True)
    os.chmod(LOCAL_DIR, 0o700)


def _write_private(path, data):
    """Escribe un archivo que solo puede leer el usuario (permisos 600)."""
    _private_dir()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def _request(url, data=None, headers=None, method=None, timeout=30):
    """Devuelve (código HTTP, JSON). Nunca lanza por un error HTTP."""
    body = urllib.parse.urlencode(data).encode() if isinstance(data, dict) else data
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:300]}
    except urllib.error.URLError as e:
        return 0, {"error": {"message": f"No se pudo conectar: {e.reason}"}}


def _pkce_pair():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def build_auth_url(client_id, redirect_uri, scopes, state, challenge):
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # offline + consent: sin esto Google no devuelve un refresh token en la segunda autorización.
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


# ------------------------------------------------------------- recepción de la autorización ---

class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    result = {}

    def do_GET(self):  # noqa: N802 — nombre fijado por http.server
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" not in query and "error" not in query:
            self.send_response(404)
            self.end_headers()
            return
        type(self).result = {k: v[0] for k, v in query.items()}
        ok = "code" in query
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            ("<html><body style='font-family:sans-serif;padding:40px'>"
             + ("<h2>Listo</h2><p>Autorización recibida. Ya puedes cerrar esta pestaña y volver a la terminal.</p>"
                if ok else "<h2>No se autorizó</h2><p>Vuelve a la terminal para ver el motivo.</p>")
             + "</body></html>").encode("utf-8"))

    def log_message(self, *args):  # silencia el log: la URL lleva el código de autorización
        pass


def wait_for_authorization(server, timeout):
    """Atiende peticiones hasta que llegue la que trae el código (o el error) o se acabe el tiempo.
    Sigue escuchando aunque el navegador pida antes algo ajeno (por ejemplo el icono de la página)."""
    _CallbackHandler.result = {}
    server.timeout = 1  # cada vuelta espera como mucho 1 segundo, para poder revisar el tiempo total
    deadline = time.monotonic() + timeout
    while not _CallbackHandler.result and time.monotonic() < deadline:
        server.handle_request()
    return dict(_CallbackHandler.result)


# ----------------------------------------------------------------------------- credenciales ---

def ask_client():
    client_id = os.environ.get("PMH_READ_CLIENT_ID") or input("ID de cliente OAuth (termina en .apps.googleusercontent.com): ").strip()
    client_secret = os.environ.get("PMH_READ_CLIENT_SECRET") or getpass.getpass("Secreto del cliente (no se muestra al escribir): ").strip()
    if not client_id or not client_secret:
        sys.exit("Faltan el ID o el secreto del cliente.")
    return client_id, client_secret


def authorize(client_id, client_secret, scopes):
    """Flujo de escritorio con PKCE. Devuelve el refresh token y los permisos concedidos."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _CallbackHandler)  # puerto libre, solo local
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}"
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)
    url = build_auth_url(client_id, redirect_uri, scopes, state, challenge)

    print("\nSe abrirá el navegador. Si no se abre, copia este enlace en él:\n")
    print(url, "\n")
    print("Elige la cuenta de Google que tiene acceso a los GA4, GTM, Search Console y BigQuery de los clientes.")
    print("Es normal que Google avise de que la app no está verificada si es de uso interno.\n")
    webbrowser.open(url)

    params = wait_for_authorization(server, TIMEOUT_CONSENT_SECONDS)
    server.server_close()
    if not params:
        sys.exit(f"No llegó ninguna autorización en {TIMEOUT_CONSENT_SECONDS} segundos. Vuelve a ejecutar el script.")
    if params.get("error"):
        sys.exit(f"Google no concedió el acceso: {params['error']}.")
    if not secrets.compare_digest(params.get("state", ""), state):
        sys.exit("La respuesta no coincide con la solicitud (state distinto). Por seguridad se descarta; vuelve a intentarlo.")

    status, tok = _request(TOKEN_URL, data={
        "client_id": client_id, "client_secret": client_secret, "code": params["code"],
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect_uri,
    })
    if status != 200 or "access_token" not in tok:
        sys.exit(f"Google rechazó el intercambio del código ({status}): {tok.get('error_description') or tok.get('error')}")
    refresh = tok.get("refresh_token")
    if not refresh:
        sys.exit("Google no devolvió un refresh token. Quita el acceso anterior en https://myaccount.google.com/permissions "
                 "(busca el nombre de tu app) y vuelve a ejecutar el script.")
    return refresh, tok["access_token"], (tok.get("scope") or "").split()


def access_token_from_refresh(client_id, client_secret, refresh_token):
    status, tok = _request(TOKEN_URL, data={
        "client_id": client_id, "client_secret": client_secret,
        "refresh_token": refresh_token, "grant_type": "refresh_token",
    })
    if status != 200 or "access_token" not in tok:
        sys.exit(f"No se pudo renovar el acceso ({status}): {tok.get('error_description') or tok.get('error')}. "
                 "Si la pantalla de consentimiento está en modo 'Pruebas', el acceso caduca a los 7 días: ver la guía.")
    return tok["access_token"]


# ---------------------------------------------------------------------------- comprobación ---

def _api_problem(status, body):
    """Texto corto y útil cuando una API falla; si está desactivada, trae el enlace para activarla."""
    err = body.get("error", {}) if isinstance(body, dict) else {}
    msg = (err.get("message") or str(body))[:140].replace("\n", " ")
    for d in err.get("details") or []:
        meta = d.get("metadata") or {}
        if d.get("reason") == "SERVICE_DISABLED" and meta.get("activationUrl"):
            return f"API desactivada en el proyecto. Actívala aquí: {meta['activationUrl']}"
        if d.get("reason") == "ACCESS_TOKEN_SCOPE_INSUFFICIENT":
            return "falta el permiso en la autorización (vuelve a autorizar con ese permiso)"
    if status == 403:
        return f"sin acceso ({msg})"
    return f"HTTP {status}: {msg}"


def inventory(access_token, scopes_granted):
    """Lee, sin modificar nada, qué se ve con esta autorización. Devuelve el inventario."""
    headers = {"Authorization": f"Bearer {access_token}"}
    out = {"permisos": scopes_granted, "ga4": None, "gtm": None, "gsc": None, "bigquery": None, "problemas": {}}

    def probe(key, scope_key, label, fn):
        if SCOPES[scope_key] not in scopes_granted:
            out["problemas"][key] = "no se concedió este permiso"
            print(f"  {label:<14} sin permiso concedido")
            return
        try:
            result = fn()
            out[key] = result
            print(f"  {label:<14} {result['_resumen']}")
        except _ProbeError as e:
            out["problemas"][key] = str(e)
            print(f"  {label:<14} {e}")

    def ga4():
        accounts, props, token = 0, [], None
        while True:
            url = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200" + (f"&pageToken={token}" if token else "")
            st, d = _request(url, headers=headers)
            if st != 200:
                raise _ProbeError(_api_problem(st, d))
            for a in d.get("accountSummaries", []):
                accounts += 1
                for p in a.get("propertySummaries", []):
                    props.append({"property": p.get("property"), "nombre": p.get("displayName"), "cuenta": a.get("displayName")})
            token = d.get("nextPageToken")
            if not token:
                break
        return {"cuentas": accounts, "propiedades": props, "_resumen": f"{accounts} cuenta(s) y {len(props)} propiedad(es) de GA4"}

    def gtm():
        st, d = _request("https://tagmanager.googleapis.com/tagmanager/v2/accounts", headers=headers)
        if st != 200:
            raise _ProbeError(_api_problem(st, d))
        accs = [{"id": a.get("accountId"), "nombre": a.get("name")} for a in d.get("account", [])]
        return {"cuentas": accs, "_resumen": f"{len(accs)} cuenta(s) de Tag Manager"}

    def gsc():
        st, d = _request("https://www.googleapis.com/webmasters/v3/sites", headers=headers)
        if st != 200:
            raise _ProbeError(_api_problem(st, d))
        sites = [{"sitio": s.get("siteUrl"), "nivel": s.get("permissionLevel")} for s in d.get("siteEntry", [])]
        return {"sitios": sites, "_resumen": f"{len(sites)} sitio(s) de Search Console"}

    def bq():
        st, d = _request("https://bigquery.googleapis.com/bigquery/v2/projects?maxResults=200", headers=headers)
        if st != 200:
            raise _ProbeError(_api_problem(st, d))
        projects = [{"proyecto": p.get("id"), "nombre": p.get("friendlyName")} for p in d.get("projects", [])]
        return {"proyectos": projects, "_resumen": f"{len(projects)} proyecto(s) de BigQuery visibles"}

    print("\nQué se ve con esta autorización (solo lectura):")
    probe("ga4", "ga4", "GA4", ga4)
    probe("gtm", "gtm", "Tag Manager", gtm)
    probe("gsc", "gsc", "Search Console", gsc)
    probe("bigquery", "bq", "BigQuery", bq)
    for k in ("ga4", "gtm", "gsc", "bigquery"):
        if out[k]:
            out[k].pop("_resumen", None)
    return out


class _ProbeError(Exception):
    pass


def save_inventory(inv):
    _write_private(INVENTORY_PATH, inv)
    print(f"\nInventario guardado en {INVENTORY_PATH} (permisos 600, sin claves). No lo subas al repositorio.")


# ----------------------------------------------------------------------------- almacenamiento ---

def _railway(name, value, service):
    """Guarda una variable de Railway por entrada estándar (el valor no aparece en la lista de procesos)
    y sin disparar un despliegue."""
    cmd = ["railway", "variable", "set", name, "--stdin", "--skip-deploys"]
    if service:
        cmd += ["--service", service]
    p = subprocess.run(cmd, input=value, text=True, capture_output=True)
    return p.returncode == 0, (p.stderr or "")[:160]


def store_credentials(client_id, client_secret, refresh_token, service):
    have_railway = shutil.which("railway") is not None
    if have_railway:
        answer = input(f"\n¿Guardar las 3 credenciales como variables de Railway ({ENV_CLIENT_ID}, {ENV_CLIENT_SECRET}, {ENV_REFRESH_TOKEN})? [s/N] ").strip().lower()
        if answer == "s":
            ok_all = True
            for name, value in ((ENV_CLIENT_ID, client_id), (ENV_CLIENT_SECRET, client_secret), (ENV_REFRESH_TOKEN, refresh_token)):
                ok, err = _railway(name, value, service)
                print(f"  {name}: {'guardada' if ok else 'ERROR ' + err}")
                ok_all = ok_all and ok
            if ok_all:
                print("Listo. No se reinició el servicio. Cuando se use la integración habrá que desplegar.")
                return
            print("Alguna variable no se pudo guardar; se ofrece el archivo local como alternativa.")
    else:
        print("\nNo encuentro la CLI de Railway en este equipo.")
    answer = input("¿Guardarlas en un archivo local protegido (~/.pmh_lectura/credenciales.json) para pasarlas a Railway a mano? [s/N] ").strip().lower()
    if answer == "s":
        _write_private(LOCAL_TOKEN_PATH, {ENV_CLIENT_ID: client_id, ENV_CLIENT_SECRET: client_secret, ENV_REFRESH_TOKEN: refresh_token})
        print(f"Guardado en {LOCAL_TOKEN_PATH}. Bórralo en cuanto las pases a Railway.")
    else:
        print("No se guardó nada: el refresh token se pierde al cerrar este script. Habría que autorizar de nuevo.")


# ----------------------------------------------------------------------------------- modos ---

def env_credentials():
    cid, sec, ref = (os.environ.get(n) for n in (ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_REFRESH_TOKEN))
    if not (cid and sec and ref):
        sys.exit(f"Faltan variables de entorno ({ENV_CLIENT_ID}, {ENV_CLIENT_SECRET}, {ENV_REFRESH_TOKEN}). "
                 "Usa: railway run python3 autorizar_google_lectura.py --probar")
    return cid, sec, ref


def mode_probe():
    cid, sec, ref = env_credentials()
    token = access_token_from_refresh(cid, sec, ref)
    status, info = _request(f"{TOKENINFO_URL}?access_token={urllib.parse.quote(token)}")
    granted = (info.get("scope") or "").split() if status == 200 else []
    inv = inventory(token, granted)
    save_inventory(inv)


def mode_revoke():
    _, _, ref = env_credentials()
    status, body = _request(REVOKE_URL, data={"token": ref}, headers={"Content-Type": "application/x-www-form-urlencoded"})
    print("Acceso revocado en Google." if status == 200 else f"No se pudo revocar ({status}): {body}")
    print("Quita también las 3 variables de Railway (railway variable delete NOMBRE).")


def main():
    ap = argparse.ArgumentParser(description="Autoriza lectura de GA4, GTM, Search Console y BigQuery.")
    ap.add_argument("--sin-gtm", action="store_true", help="no pedir el permiso de Tag Manager")
    ap.add_argument("--sin-gsc", action="store_true", help="no pedir el permiso de Search Console")
    ap.add_argument("--sin-bigquery", action="store_true", help="no pedir el permiso de BigQuery")
    ap.add_argument("--servicio", help="servicio de Railway donde guardar las variables (si hay más de uno)")
    ap.add_argument("--probar", action="store_true", help="repite la comprobación con las variables ya guardadas")
    ap.add_argument("--revocar", action="store_true", help="revoca el acceso guardado")
    args = ap.parse_args()

    if args.probar:
        return mode_probe()
    if args.revocar:
        return mode_revoke()

    scopes = [SCOPES["ga4"]]
    if not args.sin_gtm:
        scopes.append(SCOPES["gtm"])
    if not args.sin_gsc:
        scopes.append(SCOPES["gsc"])
    if not args.sin_bigquery:
        scopes.append(SCOPES["bq"])
    print("Permisos que se pedirán (todos de solo lectura):")
    for s in scopes:
        print("  -", s)

    client_id, client_secret = ask_client()
    refresh, access, granted = authorize(client_id, client_secret, scopes)
    missing = [s for s in scopes if s not in granted]
    if missing:
        print("\nAviso: Google no concedió todos los permisos pedidos:", ", ".join(m.rsplit("/", 1)[-1] for m in missing))
    inv = inventory(access, granted)
    save_inventory(inv)
    store_credentials(client_id, client_secret, refresh, args.servicio)
    print("\nTerminado. Ninguna clave se imprimió ni se escribió en el repositorio.")


if __name__ == "__main__":
    main()
