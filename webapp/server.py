"""
Servidor local de la Plataforma de Google Ads.

Además de servir los archivos estáticos y el endpoint /api/fetch (descarga
de páginas del lado del servidor para el Generador de copys, evitando el
bloqueo CORS del navegador), este servidor ahora protege la app con
usuario/contraseña:

- Registro abierto: cualquiera con el link puede crear su cuenta en /login.
- Contraseñas guardadas con hash + salt (PBKDF2-SHA256), nunca en texto
  plano, en una base SQLite local (`data.db`, se crea sola al arrancar).
- Sesión por cookie httpOnly + SameSite=Lax, válida 14 días.
- Todo lo que no sea la pantalla de login/registro (`/login`) o los
  endpoints de esa pantalla requiere sesión válida — si no la hay, la app
  redirige a /login.

Nota de seguridad: esto es suficiente para uso interno en red local/
localhost, tal como corre hoy. Si esta app se llega a exponer en una red
compartida o en internet, hace falta HTTPS + cookie "Secure", y probablemente
cerrar el registro abierto (dar de alta cuentas a mano) — ver README.md.

Correr con:
    python3 server.py
"""

import hashlib
import http.cookies
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import google_ads_client

PORT = int(os.environ.get("PORT", 8642))
TIMEOUT_SECONDS = 15
MAX_BYTES = 5_000_000  # 5 MB — suficiente para una página, evita descargas gigantes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# DATA_DIR es configurable para que en producción la base de datos viva en un
# volumen persistente separado del código (ver Dockerfile) — en local, sin la
# variable de entorno, sigue guardándose junto a server.py como siempre.
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)
DB_PATH = os.path.join(DATA_DIR, "data.db")

# En producción (detrás de HTTPS) la cookie de sesión debe llevar el atributo
# Secure — en local (http://localhost) un navegador la ignoraría y rompería
# el login, así que solo se activa si PMH_SECURE_COOKIES=1 (ver Dockerfile).
SECURE_COOKIES = os.environ.get("PMH_SECURE_COOKIES") == "1"

SESSION_COOKIE = "pmh_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 14  # 14 días
PBKDF2_ITERATIONS = 200_000

# Rutas que no requieren sesión (la pantalla de login/registro y sus llamadas).
PUBLIC_PATHS = {"/login", "/login.html", "/styles.css"}

# Único listado de archivos servibles — evita que SimpleHTTPRequestHandler
# exponga por accidente server.py, data.db (tiene los hashes de contraseña)
# o cualquier otro archivo de la carpeta.
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/engine.js": "engine.js",
    "/styles.css": "styles.css",
    "/login": "login.html",
    "/login.html": "login.html",
}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


# ---------------------------------------------------------------------------
# Base de datos — usuarios y sesiones
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def hash_password(password, salt_hex=None):
    salt_hex = salt_hex or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ITERATIONS
    ).hex()
    return salt_hex, digest


def verify_password(password, salt_hex, expected_hash):
    _, digest = hash_password(password, salt_hex)
    return secrets.compare_digest(digest, expected_hash)


class Handler(SimpleHTTPRequestHandler):
    # -------------------------------------------------------------- GET ---
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/fetch":
            if not self._require_auth_json():
                return
            self._handle_fetch(parse_qs(parsed.query))
            return

        if path == "/api/me":
            self._handle_me()
            return

        if path == "/api/google-ads/status":
            if not self._require_auth_json():
                return
            self._send_json(200, {"configured": google_ads_client.is_configured()})
            return

        if path == "/api/google-ads/accounts":
            if not self._require_auth_json():
                return
            self._handle_google_ads_accounts()
            return

        if path == "/api/google-ads/campaigns":
            if not self._require_auth_json():
                return
            self._handle_google_ads_campaigns(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/search-terms":
            if not self._require_auth_json():
                return
            self._handle_google_ads_search_terms(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/campaign-list":
            if not self._require_auth_json():
                return
            self._handle_google_ads_campaign_list(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/impression-share-daily":
            if not self._require_auth_json():
                return
            self._handle_google_ads_impression_share_daily(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/roas":
            if not self._require_auth_json():
                return
            self._handle_google_ads_roas(parse_qs(parsed.query))
            return

        filename = STATIC_FILES.get(path)
        if filename is None:
            self.send_error(404, "No encontrado")
            return

        if path not in PUBLIC_PATHS:
            if not self._require_auth_redirect():
                return

        self._serve_file(filename)

    # ------------------------------------------------------------- POST ---
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "Cuerpo de la petición inválido."})
            return

        if path == "/api/register":
            self._handle_register(payload)
        elif path == "/api/login":
            self._handle_login(payload)
        elif path == "/api/logout":
            self._handle_logout()
        elif path == "/api/google-ads/negative-keywords":
            if not self._require_auth_json():
                return
            self._handle_google_ads_negative_keywords(payload)
        elif path == "/api/google-ads/roas-adjust":
            if not self._require_auth_json():
                return
            self._handle_google_ads_roas_adjust(payload)
        else:
            self.send_error(404, "No encontrado")

    # --------------------------------------------------------- estáticos ---
    def _serve_file(self, filename):
        path = os.path.join(BASE_DIR, filename)
        try:
            with open(path, "rb") as f:
                content = f.read()
        except OSError:
            self.send_error(404, "No encontrado")
            return
        ext = os.path.splitext(filename)[1]
        content_type = CONTENT_TYPES.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # -------------------------------------------------------------- auth ---
    def _get_session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        jar.load(raw)
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _get_current_user(self):
        token = self._get_session_token()
        if not token:
            return None
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT users.id AS id, users.username AS username, sessions.expires_at AS expires_at "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token = ?",
                (token,),
            ).fetchone()
        finally:
            conn.close()
        if not row or row["expires_at"] < time.time():
            return None
        return {"id": row["id"], "username": row["username"]}

    def _require_auth_redirect(self):
        if self._get_current_user():
            return True
        self.send_response(302)
        self.send_header("Location", "/login")
        self.end_headers()
        return False

    def _require_auth_json(self):
        if self._get_current_user():
            return True
        self._send_json(401, {"error": "No autenticado."})
        return False

    def _handle_me(self):
        user = self._get_current_user()
        if user:
            self._send_json(200, {"authenticated": True, "username": user["username"]})
        else:
            self._send_json(200, {"authenticated": False})

    def _handle_register(self, payload):
        username = (payload.get("username") or "").strip().lower()
        password = payload.get("password") or ""
        if len(username) < 3:
            self._send_json(400, {"error": "El usuario debe tener al menos 3 caracteres."})
            return
        if len(password) < 6:
            self._send_json(400, {"error": "La contraseña debe tener al menos 6 caracteres."})
            return

        conn = get_db()
        try:
            existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if existing:
                self._send_json(409, {"error": "Ese usuario ya existe. Prueba iniciar sesión."})
                return
            salt_hex, pw_hash = hash_password(password)
            cur = conn.execute(
                "INSERT INTO users (username, salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (username, salt_hex, pw_hash, time.time()),
            )
            conn.commit()
            user_id = cur.lastrowid
        finally:
            conn.close()
        self._start_session(user_id, username)

    def _handle_login(self, payload):
        username = (payload.get("username") or "").strip().lower()
        password = payload.get("password") or ""
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT id, salt, password_hash FROM users WHERE username = ?", (username,)
            ).fetchone()
        finally:
            conn.close()
        # Mismo mensaje si el usuario no existe o si la contraseña está mal,
        # para no filtrar qué usuarios existen (enumeración de cuentas).
        if not row or not verify_password(password, row["salt"], row["password_hash"]):
            self._send_json(401, {"error": "Usuario o contraseña incorrectos."})
            return
        self._start_session(row["id"], username)

    def _handle_logout(self):
        token = self._get_session_token()
        if token:
            conn = get_db()
            try:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
            finally:
                conn.close()
        jar = http.cookies.SimpleCookie()
        jar[SESSION_COOKIE] = ""
        jar[SESSION_COOKIE]["path"] = "/"
        jar[SESSION_COOKIE]["max-age"] = 0
        if SECURE_COOKIES:
            jar[SESSION_COOKIE]["secure"] = True
        self._send_json(200, {"ok": True}, extra_headers=[("Set-Cookie", jar[SESSION_COOKIE].OutputString())])

    def _start_session(self, user_id, username):
        token = secrets.token_urlsafe(32)
        now = time.time()
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, user_id, now, now + SESSION_TTL_SECONDS),
            )
            conn.commit()
        finally:
            conn.close()
        jar = http.cookies.SimpleCookie()
        jar[SESSION_COOKIE] = token
        jar[SESSION_COOKIE]["path"] = "/"
        jar[SESSION_COOKIE]["httponly"] = True
        jar[SESSION_COOKIE]["samesite"] = "Lax"
        jar[SESSION_COOKIE]["max-age"] = SESSION_TTL_SECONDS
        if SECURE_COOKIES:
            jar[SESSION_COOKIE]["secure"] = True
        self._send_json(
            200,
            {"ok": True, "username": username},
            extra_headers=[("Set-Cookie", jar[SESSION_COOKIE].OutputString())],
        )

    # ------------------------------------------------------ API Google Ads ---
    # Mientras GOOGLE_ADS_* no esté configurado en el entorno (developer
    # token pendiente de aprobación de Google), estos endpoints sirven datos
    # simulados en vez de fallar — así se puede construir y probar todo el
    # flujo (selector de cuenta, rango de fechas, tabla) desde ya. La
    # respuesta siempre incluye "simulated" para que la interfaz avise.
    def _handle_google_ads_accounts(self):
        if not google_ads_client.is_configured():
            self._send_json(200, {"accounts": google_ads_client.SIMULATED_ACCOUNTS, "simulated": True})
            return
        try:
            accounts = google_ads_client.list_client_accounts()
            self._send_json(200, {"accounts": accounts, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    def _handle_google_ads_campaigns(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        only_active = (query.get("only_active") or [""])[0].strip() == "1"
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_campaign_rows(only_active), "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        try:
            rows = google_ads_client.fetch_campaign_rows(customer_id, date_from, date_to, only_active)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    def _handle_google_ads_search_terms(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not google_ads_client.is_configured():
            rows = google_ads_client.simulated_search_terms() + google_ads_client.simulated_pmax_search_term_insights()
            self._send_json(200, {"rows": rows, "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        try:
            rows = google_ads_client.fetch_search_terms(customer_id, date_from, date_to)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})
            return

        # Categorías de Performance Max — recurso distinto (ver
        # fetch_pmax_search_term_insights), no cuentas sin campañas PMax lo
        # necesitan; si falla, no debe tumbar el reporte de términos Search
        # que sí funcionó.
        try:
            rows = rows + google_ads_client.fetch_pmax_search_term_insights(customer_id, date_from, date_to)
        except Exception:
            pass

        self._send_json(200, {"rows": rows, "simulated": False})

    def _handle_google_ads_campaign_list(self, query):
        # Listado liviano de TODAS las campañas activas de la cuenta (no
        # solo las que tienen search terms) — search_term_view es Search-only
        # por diseño de Google, así que este endpoint es la única forma de
        # ver campañas Performance Max / Demand Gen / Display en Negativización.
        customer_id = (query.get("customer_id") or [""])[0].strip()

        if not google_ads_client.is_configured():
            self._send_json(200, {"campaigns": google_ads_client.simulated_account_campaigns(), "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        try:
            campaigns = google_ads_client.fetch_account_campaigns(customer_id)
            self._send_json(200, {"campaigns": campaigns, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    def _handle_google_ads_impression_share_daily(self, query):
        # Serie diaria de Impression Share a nivel de cuenta, para el
        # gráfico de tendencia de Oportunidad de ingresos.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_impression_share_daily(date_from, date_to), "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        try:
            rows = google_ads_client.fetch_impression_share_daily(customer_id, date_from, date_to)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    def _handle_google_ads_roas(self, query):
        # ROAS logrado + ROAS objetivo por campaña, para la sección ROAS.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        only_active = (query.get("only_active") or [""])[0].strip() == "1"
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_roas_by_campaign(only_active), "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        try:
            rows = google_ads_client.fetch_roas_by_campaign(customer_id, date_from, date_to, only_active)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    # Escritura real sobre la cuenta del cliente — a diferencia de todos los
    # demás endpoints de /api/google-ads/, este modifica Google Ads. Por
    # default (validate_only ausente o true) SIEMPRE valida sin aplicar; el
    # llamador tiene que pedir explícitamente validate_only=false para que
    # el cambio quede escrito de verdad.
    def _handle_google_ads_negative_keywords(self, payload):
        customer_id = str(payload.get("customer_id") or "").strip()
        items = payload.get("items") or []
        validate_only = payload.get("validate_only", True) is not False

        if not isinstance(items, list) or not items:
            self._send_json(400, {"error": "Falta la lista de términos a subir."})
            return
        for item in items:
            if not isinstance(item, dict) or not item.get("campaign_id") or not item.get("term"):
                self._send_json(400, {"error": "Cada término debe traer campaign_id y term."})
                return

        if not google_ads_client.is_configured():
            result = google_ads_client.simulated_push_negative_keywords(items, validate_only)
            self._send_json(200, result)
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        try:
            result = google_ads_client.push_negative_keywords(customer_id, items, validate_only)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    # Escritura real sobre la cuenta del cliente — ajusta el ROAS objetivo de
    # una campaña. Igual que negative-keywords, por default (validate_only
    # ausente o true) SIEMPRE valida sin aplicar.
    def _handle_google_ads_roas_adjust(self, payload):
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        bidding_strategy_type = str(payload.get("bidding_strategy_type") or "").strip()
        validate_only = payload.get("validate_only", True) is not False
        try:
            target_roas = float(payload.get("target_roas"))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "target_roas debe ser un número."})
            return

        if not campaign_id or not bidding_strategy_type:
            self._send_json(400, {"error": "Faltan campaign_id o bidding_strategy_type."})
            return

        if not google_ads_client.is_configured():
            try:
                result = google_ads_client.simulated_update_campaign_target_roas(campaign_id, bidding_strategy_type, target_roas, validate_only)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        try:
            result = google_ads_client.update_campaign_target_roas(customer_id, campaign_id, bidding_strategy_type, target_roas, validate_only)
            self._send_json(200, result)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_json(502, {"error": str(e)})

    # ------------------------------------------------- Generador de copys ---
    def _handle_fetch(self, query):
        url = (query.get("url") or [""])[0].strip()
        if not url:
            self._send_json(400, {"error": "Falta el parámetro url."})
            return
        if not url.lower().startswith(("http://", "https://")):
            self._send_json(400, {"error": "La URL debe empezar con http:// o https://."})
            return

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (compatible; PaidMediaHelper/1.0; "
                    "+internal-tool-copy-generator)"
                ),
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                raw = resp.read(MAX_BYTES)
                charset = resp.headers.get_content_charset() or "utf-8"
                html = raw.decode(charset, errors="replace")
                final_url = resp.geturl()
            self._send_json(200, {"html": html, "url": final_url})
        except urllib.error.HTTPError as e:
            self._send_json(502, {"error": f"El sitio respondió con estado {e.code}."})
        except urllib.error.URLError as e:
            self._send_json(502, {"error": f"No se pudo conectar al sitio: {e.reason}"})
        except TimeoutError:
            self._send_json(504, {"error": "El sitio tardó demasiado en responder."})
        except Exception as e:  # noqa: BLE001 — este endpoint siempre debe responder JSON, nunca tumbar el server
            self._send_json(502, {"error": f"No se pudo descargar la página: {e}"})

    # --------------------------------------------------------------- json ---
    def _send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in extra_headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 — silencia el log por request
        pass


if __name__ == "__main__":
    os.chdir(BASE_DIR)
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Paid Media Helper corriendo en http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
