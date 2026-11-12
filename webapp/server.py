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

import contextlib
import datetime
import hashlib
import http.cookies
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import account_audit
import bigquery_client
import claude_client
import hoteles_ia
import negativos_ia
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
# 6 era muy corto — con el rate limiting ya puesto (8 intentos/5min por IP)
# una contraseña de 10+ caracteres hace que la fuerza bruta, incluso
# offline si algún día se filtrara la base, tome muchísimo más tiempo.
MIN_PASSWORD_LENGTH = 10
# El username se pinta sin más filtro que escapeHtml() en varias pantallas
# (Administración, sidebar). escapeHtml() ya neutraliza cualquier intento de
# XSS ahí, pero esto es una segunda capa: sin esta validación, cualquiera
# podría registrar un username con comillas/backticks/espacios raros — no
# es explotable hoy, pero alcanza con que un futuro cambio olvide escapar en
# algún lugar nuevo. Se permiten letras, números, y . _ @ + - (cubre tanto
# usuarios tipo "cesar.vasquez" como usernames que son un email).
USERNAME_RE = re.compile(r"^[a-zA-Z0-9._@+-]{3,100}$")

# El rate limiting de login (_login_limiter) es por IP y vive en memoria —
# no protege contra fuerza bruta distribuida (muchas IPs distintas probando
# la misma cuenta) y se resetea en cada redeploy. Este bloqueo es por
# cuenta, se guarda en la base (sobrevive redeploys), y es independiente
# de la IP de quien lo intente.
LOGIN_LOCKOUT_THRESHOLD = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60

# Código de invitación para poder registrarse — ahora que la API de Google
# Ads está conectada de verdad (lectura Y escritura sobre cuentas reales de
# clientes), el registro abierto dejó de ser aceptable: cualquiera con el
# link podía crear una cuenta y, sin ningún control adicional, leer/escribir
# en cualquiera de las 1100+ cuentas del MCC. Fail-secure: si esta variable
# no está configurada, el registro queda CERRADO (no hay registro abierto
# por default) — hay que setearla explícitamente para permitir altas nuevas.
REGISTRATION_CODE = os.environ.get("PMH_REGISTRATION_CODE")

# Usuarios con acceso a TODAS las cuentas del MCC sin restricción — el resto
# de usuarios (por default, cualquiera nuevo) solo puede leer/escribir en
# las cuentas que se le asignen explícitamente en user_account_access (ver
# init_db). Se sincroniza en cada arranque, así que basta con actualizar
# esta variable en Railway y redesplegar para agregar o quitar admins.
ADMIN_USERNAMES = {u.strip().lower() for u in os.environ.get("PMH_ADMIN_USERNAMES", "").split(",") if u.strip()}

# Cualquier admin puede borrar a otro admin (protección contra eso: ninguna,
# es un modelo de confianza entre pares) — EXCEPTO a las cuentas listadas
# acá, que /api/admin/users/delete rechaza siempre sin importar quién esté
# logueado. La única forma de borrarlas de verdad es sacarlas primero de
# esta variable en Railway y redesplegar.
SUPER_ADMIN_USERNAMES = {u.strip().lower() for u in os.environ.get("PMH_SUPER_ADMIN_USERNAMES", "").split(",") if u.strip()}


# ---------------------------------------------------------------------------
# Rate limiting — en memoria, ventana deslizante. Suficiente para un solo
# proceso (como corre hoy); si algún día esto corre con más de una réplica,
# cada réplica llevaría su propia cuenta y el límite real efectivo sería
# más alto — para eso haría falta un store compartido (ej. Redis), no vale
# la pena la dependencia mientras siga siendo un solo proceso.
# ---------------------------------------------------------------------------

class RateLimiter:
    def __init__(self):
        self._hits = defaultdict(list)
        self._lock = threading.Lock()

    def allow(self, key, max_requests, window_seconds):
        now = time.time()
        with self._lock:
            hits = self._hits[key]
            cutoff = now - window_seconds
            while hits and hits[0] < cutoff:
                hits.pop(0)
            if len(hits) >= max_requests:
                return False
            hits.append(now)
            return True


# Login/registro: por IP, porque todavía no hay sesión con la que identificar
# a quién está intentando entrar. Límite generoso para no estorbar a alguien
# que se equivoca de contraseña un par de veces, pero suficiente para frenar
# fuerza bruta automatizada (8 intentos / 5 min ≈ 96/hora como máximo).
_login_limiter = RateLimiter()
_register_limiter = RateLimiter()
LOGIN_RATE_LIMIT = (8, 300)
REGISTER_RATE_LIMIT = (5, 300)

# Endpoints de escritura real (negativos, ajuste de ROAS): por usuario ya
# autenticado, no por IP — para que una sesión comprometida o un script
# desatendido no pueda automatizar cambios reales sobre las cuentas de
# clientes sin límite. 30/min alcanza de sobra para uso normal (cada llamada
# ya sube una lista completa de términos, no una por término).
_write_limiter = RateLimiter()

# Cuentas que cuelgan de cada sub-MCC (para el acceso por MCC). Recorrer un
# MCC grande son varias consultas a Google Ads, así que se cachea unos
# minutos: una cuenta nueva del hotel aparece sola en ese plazo, y una que
# se saque del MCC deja de ser accesible en ese mismo plazo.
MCC_MEMBERS_TTL_SECONDS = 600
_mcc_members_cache = {}
_mcc_members_lock = threading.Lock()


def get_mcc_member_ids(mcc_customer_id):
    """Set de customer_id de las cuentas hoja debajo de un sub-MCC, o None si
    no se pudo consultar (fail-secure: quien llama debe tratarlo como "sin
    acceso", y un fallo NO se cachea para reintentar en la próxima llamada)."""
    now = time.time()
    with _mcc_members_lock:
        hit = _mcc_members_cache.get(mcc_customer_id)
        if hit and hit[0] > now:
            return hit[1]
    try:
        members = {a["id"] for a in google_ads_client.list_mcc_group_accounts(mcc_customer_id)}
    except Exception as e:  # noqa: BLE001
        print(f"[mcc-access] no se pudo resolver el MCC {mcc_customer_id}: {str(e)[:200]}", flush=True)
        return None
    with _mcc_members_lock:
        _mcc_members_cache[mcc_customer_id] = (now + MCC_MEMBERS_TTL_SECONDS, members)
    return members
WRITE_RATE_LIMIT = (30, 60)

# Análisis con IA (Claude): cada llamada cuesta dinero real en la API de
# Anthropic, a diferencia del resto de endpoints — límite mucho más
# conservador que el de escritura normal. Por usuario, no por IP.
_ai_limiter = RateLimiter()
AI_RATE_LIMIT = (10, 3600)
# Generador de copys con IA: su propio tope por usuario (hasta 2 llamadas a Claude por generación).
_copy_limiter = RateLimiter()
COPY_RATE_LIMIT = (10, 3600)
# Cada auditoría hace ~12 consultas a Google Ads, que comparten la cuota del
# developer token de todo el equipo — por eso su propio tope por usuario.
_audit_limiter = RateLimiter()
AUDIT_RATE_LIMIT = (10, 3600)
# Auditoría de varias cuentas: cada cuenta del lote es una auditoría; el lote es de hasta 20 y el
# navegador las pide una por una, así que el tope por hora es mayor, pero sigue siendo por usuario.
_audit_batch_limiter = RateLimiter()
AUDIT_BATCH_RATE_LIMIT = (40, 3600)

# /api/change-password verifica una contraseña actual, igual que el login —
# por usuario ya autenticado (no por IP), para frenar fuerza bruta contra la
# contraseña vigente sin depender del límite de /api/login.
_change_password_limiter = RateLimiter()
CHANGE_PASSWORD_RATE_LIMIT = (8, 300)

# Rutas que no requieren sesión (la pantalla de login/registro y sus llamadas).
PUBLIC_PATHS = {"/login", "/login.html", "/login.js", "/styles.css"}

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
    "/login.js": "login.js",
    "/styles-roiback.css": "styles-roiback.css",
    # Librerías de terceros servidas desde aquí (ver webapp/vendor/LEEME.md): así la página no depende
    # de que unpkg o jsdelivr respondan para poder pintarse.
    "/vendor/lucide.min.js": "vendor/lucide.min.js",
    "/vendor/xlsx.full.min.js": "vendor/xlsx.full.min.js",
    "/vendor/chart.umd.min.js": "vendor/chart.umd.min.js",
    "/vendor/chartjs-plugin-datalabels.min.js": "vendor/chartjs-plugin-datalabels.min.js",
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


def save_audit_history(user_id, customer_id, simulated, report, ctx, days):
    sc = report["score"]
    findings = [{"id": f["id"], "severity": f["severity"], "title": f["title"]} for f in report["findings"]]
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO audit_history (customer_id, account_name, user_id, simulated, created_at, days, rules_version,
                   goal, target, score_total, label, critical, warnings, info, area_scores, findings)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (customer_id, (report.get("meta") or {}).get("account_name") or "", user_id, 1 if simulated else 0, time.time(), days,
             account_audit.RULES_VERSION, ctx.get("goal"), ctx.get("target"), sc["total"], sc["label"], sc["critical"], sc["warnings"],
             sc["info"], json.dumps({a: v["score"] for a, v in sc["by_area"].items()}, ensure_ascii=False),
             json.dumps(findings, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def load_audit_history(customer_id, simulated, limit=50):
    """Las últimas `limit` auditorías de la cuenta, de la más vieja a la más nueva."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM audit_history WHERE customer_id = ? AND simulated = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            (customer_id, 1 if simulated else 0, limit),
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in reversed(rows):
        out.append({
            "id": r["id"], "at": datetime.datetime.fromtimestamp(r["created_at"]).isoformat(timespec="seconds"),
            "days": r["days"], "rules_version": r["rules_version"], "goal": r["goal"], "target": r["target"],
            "score": r["score_total"], "label": r["label"], "critical": r["critical"], "warnings": r["warnings"], "info": r["info"],
            "areas": json.loads(r["area_scores"] or "{}"), "findings": json.loads(r["findings"] or "[]"),
        })
    return out


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
        # is_admin no estaba en el esquema original — las bases ya existentes
        # (producción incluida) necesitan la migración explícita; CREATE
        # TABLE IF NOT EXISTS no le agrega columnas a una tabla que ya existe.
        try:
            conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # ya existe, de un arranque anterior
        # Bloqueo de cuenta tras varios intentos fallidos de login seguidos —
        # ver LOGIN_LOCKOUT_THRESHOLD/LOGIN_LOCKOUT_SECONDS y _handle_login.
        try:
            conn.execute("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE users ADD COLUMN locked_until REAL")
        except sqlite3.OperationalError:
            pass
        # Se activa cuando un admin restablece la contraseña de alguien (ver
        # _handle_admin_reset_password) — obliga a definir una contraseña
        # propia antes de poder usar el resto de la app, para que la temporal
        # que le pasaron por fuera de la plataforma no quede como definitiva.
        try:
            conn.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        # Último ingreso exitoso (login o registro, que también deja logueado
        # de una vez) — se muestra en Administración para saber quién ha
        # entrado y cuándo fue la última vez. NULL para cuentas creadas antes
        # de este campo que nunca volvieron a entrar.
        try:
            conn.execute("ALTER TABLE users ADD COLUMN last_login_at REAL")
        except sqlite3.OperationalError:
            pass
        # Qué cuenta de Google Ads (customer_id) puede tocar cada usuario que
        # NO sea admin — sin ninguna fila acá, un usuario no-admin no puede
        # leer ni escribir en ninguna cuenta (fail-secure: antes de esto,
        # cualquier usuario autenticado podía tocar cualquiera de las 1100+
        # cuentas del MCC con solo mandar el customer_id).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_account_access (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                customer_id TEXT NOT NULL,
                account_name TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                UNIQUE(user_id, customer_id)
            )
            """
        )
        # Acceso por MCC: en vez de una fila por cuenta, el usuario queda
        # ligado a un sub-MCC (una marca de hotel) y puede tocar TODAS las
        # cuentas que cuelguen de él, incluidas las que se abran después —
        # la pertenencia se resuelve contra Google Ads al momento de chequear
        # (con caché corto), no se copia a user_account_access.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_mcc_access (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                mcc_customer_id TEXT NOT NULL,
                mcc_name TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                UNIQUE(user_id, mcc_customer_id)
            )
            """
        )
        # Qué cuentas quiere vigilar cada usuario en "Ritmo de consumo" —
        # independiente de user_account_access (permiso para tocar/leer una
        # cuenta): un admin puede acceder a cualquiera de las 1100+ cuentas
        # del MCC pero eso no significa que quiera verlas TODAS en este
        # tablero, así que acá cada quien arma su propia lista.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_pacing_watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                customer_id TEXT NOT NULL,
                account_name TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                UNIQUE(user_id, customer_id)
            )
            """
        )
        # MCCs completos agregados desde "Agregar un MCC completo" (Ritmo de consumo)
        # y qué cuentas trajo cada uno, para poder listarlos y quitar uno entero
        # con una "X" sin tocar las cuentas que el usuario agregó a mano.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_pacing_mcc_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_customer_id TEXT NOT NULL,
                group_name TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                UNIQUE(user_id, group_customer_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_pacing_mcc_group_accounts (
                user_id INTEGER NOT NULL,
                group_customer_id TEXT NOT NULL,
                customer_id TEXT NOT NULL,
                PRIMARY KEY(user_id, group_customer_id, customer_id)
            )
            """
        )
        # Pausas y activaciones de campañas hechas desde la sección Campañas: quién, cuándo y de qué estado a cuál.
        # Recomendaciones automáticas pausadas o reactivadas desde la Auditoría: quién, cuándo, cuenta y tipo.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS recommendation_subscription_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at REAL NOT NULL,
                user_id INTEGER,
                customer_id TEXT NOT NULL,
                rec_type TEXT NOT NULL,
                new_status TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS campaign_status_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at REAL NOT NULL,
                user_id INTEGER,
                customer_id TEXT NOT NULL,
                campaign_id TEXT NOT NULL,
                campaign_name TEXT,
                old_status TEXT,
                new_status TEXT NOT NULL
            )
            """
        )
        # Historial de la Auditoría de cuenta: una fila por auditoría, con el puntaje, el
        # puntaje por área y los hallazgos (id, gravedad, título) para poder mostrar la
        # tendencia y qué cambió entre una auditoría y la anterior. Se lee por cuenta de
        # Google Ads (customer_id), no por usuario: lo ve quien tenga acceso a la cuenta.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id TEXT NOT NULL,
                account_name TEXT,
                user_id INTEGER,
                simulated INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                days INTEGER NOT NULL,
                rules_version INTEGER NOT NULL,
                goal TEXT,
                target REAL,
                score_total INTEGER NOT NULL,
                label TEXT,
                critical INTEGER NOT NULL DEFAULT 0,
                warnings INTEGER NOT NULL DEFAULT 0,
                info INTEGER NOT NULL DEFAULT 0,
                area_scores TEXT,
                findings TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_history_customer ON audit_history(customer_id, created_at)")
        # Historial de negativas subidas desde la plataforma: una fila por subida y una por negativa creada (con su
        # resource_name de Google Ads), para poder ver qué se subió, quién y cuándo, y deshacerlo.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS neg_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at REAL NOT NULL,
                user_id INTEGER,
                customer_id TEXT NOT NULL,
                origen TEXT NOT NULL DEFAULT 'reglas',
                created INTEGER NOT NULL DEFAULT 0,
                undone_at REAL,
                undone_by INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS neg_upload_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                upload_id INTEGER NOT NULL,
                campaign_id TEXT NOT NULL,
                campaign_name TEXT,
                text TEXT NOT NULL,
                match_type TEXT NOT NULL,
                resource_name TEXT NOT NULL,
                removed_at REAL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_neg_uploads_customer ON neg_uploads(customer_id, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_neg_upload_items_upload ON neg_upload_items(upload_id)")
        # Consumo de la IA (Claude) por usuario, por día y por función: llamados, tokens y costo estimado en USD.
        # El día es el de Colombia (UTC-5), no el del servidor.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_usage (
                day TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                feature TEXT NOT NULL,
                calls INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (day, user_id, feature)
            )
            """
        )
        # PMH_ADMIN_USERNAMES es solo un piso mínimo garantizado en cada
        # arranque (para nunca quedar sin ningún admin) — SOLO sube a admin
        # a esos usernames, nunca baja a nadie. Bajar el flag a alguien más
        # ahora se hace desde el panel (/api/admin/users/set-admin), y esa
        # decisión debe sobrevivir el próximo deploy/restart, no revertirse.
        if ADMIN_USERNAMES:
            placeholders = ",".join("?" for _ in ADMIN_USERNAMES)
            conn.execute(f"UPDATE users SET is_admin = 1 WHERE username IN ({placeholders})", tuple(ADMIN_USERNAMES))
        conn.commit()
    finally:
        conn.close()


_COLOMBIA_TZ = datetime.timezone(datetime.timedelta(hours=-5))
AI_USAGE_FEATURES = ("negativizacion", "auditoria", "rendimiento", "copys", "hoteles")


def store_ai_usage(user_id, feature, calls, input_tokens, output_tokens, cost_usd):
    day = datetime.datetime.now(_COLOMBIA_TZ).strftime("%Y-%m-%d")
    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO ai_usage (day, user_id, feature, calls, input_tokens, output_tokens, cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(day, user_id, feature) DO UPDATE SET
                calls = calls + excluded.calls,
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens,
                cost_usd = cost_usd + excluded.cost_usd
            """,
            (day, user_id, feature, calls, input_tokens, output_tokens, cost_usd),
        )
        conn.commit()
    finally:
        conn.close()


@contextlib.contextmanager
def track_ai_usage(user_id, feature):
    """Anota los tokens que gaste lo que corra dentro del bloque (incluso si termina con error) en ai_usage.
    Un fallo al guardar el consumo nunca debe tumbar la respuesta al usuario."""
    claude_client.begin_usage()
    try:
        yield
    finally:
        rec = claude_client.end_usage()
        if rec["calls"]:
            try:
                store_ai_usage(user_id, feature, rec["calls"], rec["input"], rec["output"], rec["cost_usd"])
            except Exception as e:  # noqa: BLE001
                print(f"[ai-usage] no se pudo guardar el consumo: {' '.join(str(e).split())[:200]}", flush=True)


def store_neg_upload(user_id, customer_id, origen, created_items):
    """Guarda una subida de negativas con cada negativa creada. Devuelve el id, o None si no había nada."""
    if not created_items:
        return None
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO neg_uploads (created_at, user_id, customer_id, origen, created) VALUES (?, ?, ?, ?, ?)",
            (time.time(), user_id, str(customer_id), origen, len(created_items)),
        )
        upload_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO neg_upload_items (upload_id, campaign_id, campaign_name, text, match_type, resource_name) VALUES (?, ?, ?, ?, ?, ?)",
            [(upload_id, str(i["campaign_id"]), i.get("campaign_name") or "", i["term"], i["match_type"], i["resource_name"]) for i in created_items],
        )
        conn.commit()
        return upload_id
    finally:
        conn.close()


def store_campaign_status_change(user_id, customer_id, campaign_id, campaign_name, old_status, new_status):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO campaign_status_log (created_at, user_id, customer_id, campaign_id, campaign_name, old_status, new_status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (time.time(), user_id, str(customer_id), str(campaign_id), (campaign_name or "")[:200], old_status, new_status),
        )
        conn.commit()
    finally:
        conn.close()


def store_recommendation_subscription_change(user_id, customer_id, types, new_status):
    conn = get_db()
    try:
        now = time.time()
        conn.executemany(
            "INSERT INTO recommendation_subscription_log (created_at, user_id, customer_id, rec_type, new_status) VALUES (?, ?, ?, ?, ?)",
            [(now, user_id, str(customer_id), t, new_status) for t in types],
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



# /api/fetch descarga páginas a pedido de un usuario: sin este control podría usarse para que el servidor
# consulte direcciones internas (localhost, la red privada de Railway, el servicio de metadatos de la nube).
def _url_is_public(url):
    try:
        parts = urlparse(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host or port not in (None, 80, 443):
        return False
    try:
        infos = socket.getaddrinfo(host, port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False
    return True


class _PublicOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _url_is_public(newurl):
            raise urllib.error.URLError("la página redirige a una dirección no permitida")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_PUBLIC_ONLY_OPENER = urllib.request.build_opener(_PublicOnlyRedirect)

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

        if path == "/api/google-ads/pacing":
            if not self._require_auth_json():
                return
            self._handle_google_ads_pacing(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/pacing/watchlist":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist()
            return

        if path == "/api/google-ads/pacing/mcc-groups":
            if not self._require_auth_json():
                return
            self._handle_pacing_mcc_groups()
            return

        if path == "/api/google-ads/pacing/account-campaigns":
            if not self._require_auth_json():
                return
            self._handle_pacing_account_campaigns(parse_qs(parsed.query))
            return

        if path == "/api/bigquery/explore":
            self._handle_bigquery_explore(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/audit-history":
            self._handle_audit_history(parse_qs(parsed.query))
            return
        if path == "/api/google-ads/mcc-groups":
            if not self._require_auth_json():
                return
            self._handle_mcc_groups()
            return

        if path == "/api/google-ads/mcc-group-accounts":
            if not self._require_auth_json():
                return
            self._handle_mcc_group_accounts(parse_qs(parsed.query))
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

        if path == "/api/google-ads/campaigns-overview":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_campaigns_overview(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/campaign-daily":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_campaign_daily(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/campaign-breakdown":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_campaign_breakdown(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/campaign-insight":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_campaign_insight(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/account-changes":
            if not self._require_auth_json():
                return
            self._handle_google_ads_account_changes(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/audiences":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_audiences(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/hotel-campaigns":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_hotel_campaigns(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/hotel-modifiers":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_hotel_modifiers(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/hotel-price":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_hotel_price(parse_qs(parsed.query))
            return

        # Historial de negativas subidas desde la plataforma (en afinado: solo super admin).
        if path == "/api/google-ads/negative-uploads":
            if not self._require_super_admin_json():
                return
            self._handle_negative_uploads(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/recommendations":
            if not self._require_auth_json():
                return
            self._handle_google_ads_recommendations(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/ai-max":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/ai-max-served":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_served(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/ai-max-created":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_created(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/ai-max-url-exclusions":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_url_exclusions(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/content-exclusions":
            if not self._require_auth_json():
                return
            self._handle_google_ads_content_exclusions(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/keyword-planner/geo-search":
            if not self._require_auth_json():
                return
            self._handle_keyword_planner_geo_search(parse_qs(parsed.query))
            return

        if path == "/api/google-ads/keyword-planner/languages":
            if not self._require_auth_json():
                return
            self._handle_keyword_planner_languages(parse_qs(parsed.query))
            return

        # Listado de cuentas registradas (sin contraseñas) — solo admins.
        if path == "/api/admin/users":
            if not self._require_admin_json():
                return
            self._handle_admin_users()
            return

        # Consumo de la IA por usuario, día y función — solo super admin (el costo no lo ven los demás admins).
        if path == "/api/admin/ai-usage":
            if not self._require_super_admin_json():
                return
            self._handle_admin_ai_usage(parse_qs(parsed.query))
            return

        # Qué customer_id de Google Ads puede tocar un usuario — solo admins.
        if path == "/api/admin/access":
            if not self._require_admin_json():
                return
            self._handle_admin_access(parse_qs(parsed.query))
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
        elif path == "/api/google-ads/pacing/watchlist/add":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist_add(payload)
        elif path == "/api/google-ads/pacing/watchlist/remove":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist_remove(payload)
        elif path == "/api/google-ads/pacing/watchlist/clear":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist_clear()
        elif path == "/api/google-ads/pacing/watchlist/add-mcc-group":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist_add_mcc_group(payload)
        elif path == "/api/google-ads/pacing/watchlist/remove-mcc-group":
            if not self._require_auth_json():
                return
            self._handle_pacing_watchlist_remove_mcc_group(payload)
        elif path == "/api/google-ads/pacing/campaign-budget-adjust":
            if not self._require_auth_json():
                return
            self._handle_pacing_campaign_budget_adjust(payload)
        elif path == "/api/google-ads/negative-keywords":
            if not self._require_auth_json():
                return
            self._handle_google_ads_negative_keywords(payload)
        elif path == "/api/google-ads/roas-adjust":
            if not self._require_auth_json():
                return
            self._handle_google_ads_roas_adjust(payload)
        elif path == "/api/google-ads/negative-uploads/undo":
            if not self._require_super_admin_json():
                return
            self._handle_negative_uploads_undo(payload)
        elif path == "/api/google-ads/campaign-status":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_campaign_status(payload)
        elif path == "/api/google-ads/recommendation-subscriptions":
            # Pausar o reactivar recomendaciones automáticas desde la Auditoría: para todos los usuarios con sesión
            # (cada cuenta valida el acceso del usuario).
            self._handle_recommendation_subscriptions(payload)
        elif path == "/api/google-ads/hotel-modifiers-apply":
            if not self._require_super_admin_json():
                return
            self._handle_google_ads_hotel_modifiers_apply(payload)
        elif path == "/api/google-ads/ai-max-toggle":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_toggle(payload)
        elif path == "/api/google-ads/ai-max-url-exclusions/apply":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_url_exclusions_apply(payload)
        elif path == "/api/google-ads/ai-max-url-exclusions/remove":
            if not self._require_auth_json():
                return
            self._handle_google_ads_ai_max_url_exclusions_remove(payload)
        elif path == "/api/google-ads/content-exclusions/add-labels":
            if not self._require_auth_json():
                return
            self._handle_google_ads_content_exclusions_add_labels(payload)
        elif path == "/api/google-ads/content-exclusions/add-app-category":
            if not self._require_auth_json():
                return
            self._handle_google_ads_content_exclusions_add_app_category(payload)
        elif path == "/api/google-ads/content-exclusions/remove":
            if not self._require_auth_json():
                return
            self._handle_google_ads_content_exclusions_remove(payload)
        elif path == "/api/google-ads/keyword-planner/ideas":
            if not self._require_auth_json():
                return
            self._handle_keyword_planner_ideas(payload)
        elif path == "/api/google-ads/keyword-planner/historical":
            if not self._require_auth_json():
                return
            self._handle_keyword_planner_historical(payload)
        elif path == "/api/google-ads/keyword-planner/forecast":
            if not self._require_auth_json():
                return
            self._handle_keyword_planner_forecast(payload)
        elif path == "/api/google-ads/recommendations/apply":
            if not self._require_auth_json():
                return
            self._handle_google_ads_recommendation_apply(payload)
        elif path == "/api/google-ads/recommendations/dismiss":
            if not self._require_auth_json():
                return
            self._handle_google_ads_recommendation_dismiss(payload)
        elif path == "/api/google-ads/audit":
            if not self._require_auth_json():
                return
            self._handle_google_ads_audit(payload)
        elif path == "/api/ai/analizar-auditoria":
            # Abierto a todos los usuarios con sesión desde 2026-11-01 (antes: solo admins).
            # El costo se acota con AI_RATE_LIMIT, por usuario.
            if not self._require_auth_json():
                return
            self._handle_ai_analizar_auditoria(payload)
        elif path == "/api/ai/analizar-rendimiento":
            # Igual que el de la auditoría: todos los usuarios con sesión, con el mismo tope por hora.
            if not self._require_auth_json():
                return
            self._handle_ai_analizar_rendimiento(payload)
        elif path == "/api/ai/analizar-negativos":
            # En afinado (2026-11-05): solo super admin, como Hoteles. Luego se abre con _require_auth_json.
            if not self._require_super_admin_json():
                return
            self._handle_ai_analizar_negativos(payload)
        elif path == "/api/ai/analizar-hotel":
            # Sección Hoteles en afinado: solo super admin, como el resto de Hoteles.
            if not self._require_super_admin_json():
                return
            self._handle_ai_analizar_hotel(payload)
        elif path == "/api/ai/nota-hotel":
            if not self._require_super_admin_json():
                return
            self._handle_ai_nota_hotel(payload)
        elif path == "/api/negativos/palabras":
            # Sin IA ni costo; en afinado (2026-11-05): solo super admin, como la pestaña "Con IA".
            if not self._require_super_admin_json():
                return
            self._handle_negativos_palabras(payload)
        elif path == "/api/ai/generar-copys":
            # Solo administradores mientras se afinan los textos (2026-11-01); luego se abre con _require_auth_json.
            if not self._require_admin_json():
                return
            self._handle_ai_generar_copys(payload)
        elif path == "/api/admin/users/delete":
            if not self._require_admin_json():
                return
            self._handle_admin_delete_user(payload)
        elif path == "/api/admin/users/set-admin":
            if not self._require_admin_json():
                return
            self._handle_admin_set_admin(payload)
        elif path == "/api/admin/access/grant":
            if not self._require_admin_json():
                return
            self._handle_admin_access_grant(payload)
        elif path == "/api/admin/access/revoke":
            if not self._require_admin_json():
                return
            self._handle_admin_access_revoke(payload)
        elif path == "/api/admin/access/grant-mcc":
            if not self._require_admin_json():
                return
            self._handle_admin_access_grant_mcc(payload)
        elif path == "/api/admin/access/revoke-mcc":
            if not self._require_admin_json():
                return
            self._handle_admin_access_revoke_mcc(payload)
        elif path == "/api/admin/users/reset-password":
            if not self._require_admin_json():
                return
            self._handle_admin_reset_password(payload)
        elif path == "/api/change-password":
            if not self._require_auth_json():
                return
            self._handle_change_password(payload)
        else:
            self.send_error(404, "No encontrado")

    # --------------------------------------------------------- estáticos ---
    # Segunda capa de defensa además de escapeHtml() en el JS: aunque algún
    # render se le olvidara escapar un valor, esta CSP bloquea <script>,
    # atributos onerror=/onclick=, y javascript: URLs igual (no permite
    # 'unsafe-inline' en script-src). style-src sí necesita 'unsafe-inline'
    # por el <style> embebido de login.html. frame-ancestors 'none' impide
    # que otra página te meta en un iframe (clickjacking).
    def _send_security_headers(self):
        csp = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'none'; "
            "form-action 'self'"
        )
        self.send_header("Content-Security-Policy", csp)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

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
        if filename.startswith("vendor/"):
            # Versiones fijas de librerías: el navegador las guarda una semana y no las vuelve a pedir.
            self.send_header("Cache-Control", "private, max-age=604800")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(content)

    # Railway (y cualquier proxy/balanceador delante del proceso) hace que
    # self.client_address sea la IP del proxy, no la del visitante real —
    # X-Forwarded-For trae la IP real como primer valor de la lista.
    def _client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

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
                "SELECT users.id AS id, users.username AS username, users.is_admin AS is_admin, "
                "users.must_change_password AS must_change_password, "
                "sessions.expires_at AS expires_at "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token = ?",
                (token,),
            ).fetchone()
        finally:
            conn.close()
        if not row or row["expires_at"] < time.time():
            return None
        return {
            "id": row["id"], "username": row["username"], "is_admin": bool(row["is_admin"]),
            "must_change_password": bool(row["must_change_password"]),
        }

    # Un usuario admin (PMH_ADMIN_USERNAMES) puede tocar cualquier cuenta;
    # el resto solo las que tenga en user_account_access. Sin filas ahí,
    # no puede tocar ninguna — fail-secure.
    def _user_can_access_account(self, user, customer_id):
        if user["is_admin"]:
            return True
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM user_account_access WHERE user_id = ? AND customer_id = ?",
                (user["id"], customer_id),
            ).fetchone()
        finally:
            conn.close()
        if row is not None:
            return True
        # Sin acceso directo: probar los MCC a los que el usuario está ligado.
        for mcc_id in self._get_user_mcc_ids(user["id"]):
            members = get_mcc_member_ids(mcc_id)
            if members is not None and customer_id in members:
                return True
        return False

    def _get_user_mcc_ids(self, user_id):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT mcc_customer_id FROM user_mcc_access WHERE user_id = ?", (user_id,)
            ).fetchall()
        finally:
            conn.close()
        return [r["mcc_customer_id"] for r in rows]

    def _get_user_account_ids(self, user_id):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT customer_id FROM user_account_access WHERE user_id = ?", (user_id,)
            ).fetchall()
        finally:
            conn.close()
        ids = {r["customer_id"] for r in rows}
        for mcc_id in self._get_user_mcc_ids(user_id):
            members = get_mcc_member_ids(mcc_id)
            if members:
                ids |= members
        return ids

    # Como _require_auth_json, pero además exige is_admin — para los
    # endpoints de administración (usuarios, permisos de cuenta). Devuelve
    # el usuario si pasa, o None (y ya mandó la respuesta de error) si no.
    def _require_admin_json(self):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return None
        if not user["is_admin"]:
            self._send_json(403, {"error": "Esta acción requiere permisos de administrador."})
            return None
        return user

    # Funciones en afinado (p. ej. Hoteles): solo las ve y usa un super admin.
    # El menú oculto en el navegador no basta — el servidor también lo exige.
    def _require_super_admin_json(self):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return None
        if user["username"].lower() not in SUPER_ADMIN_USERNAMES:
            self._send_json(403, {"error": "Esta sección todavía no está disponible para tu usuario."})
            return None
        return user

    def _require_auth_redirect(self):
        if self._get_current_user():
            return True
        self.send_response(302)
        self.send_header("Location", "/login")
        self._send_security_headers()
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
            self._send_json(200, {
                "authenticated": True, "username": user["username"], "is_admin": user["is_admin"],
                "is_super_admin": user["username"].lower() in SUPER_ADMIN_USERNAMES,
                "must_change_password": user["must_change_password"],
            })
        else:
            self._send_json(200, {"authenticated": False})

    def _handle_admin_ai_usage(self, query):
        try:
            days = max(1, min(120, int((query.get("days") or ["30"])[0])))
        except ValueError:
            days = 30
        since = (datetime.datetime.now(_COLOMBIA_TZ) - datetime.timedelta(days=days - 1)).strftime("%Y-%m-%d")
        conn = get_db()
        try:
            rows = conn.execute(
                """
                SELECT a.day, a.user_id, COALESCE(u.username, '(usuario borrado)') AS username, a.feature,
                       a.calls, a.input_tokens, a.output_tokens, a.cost_usd
                FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
                WHERE a.day >= ?
                ORDER BY a.day DESC, username, a.feature
                """,
                (since,),
            ).fetchall()
        finally:
            conn.close()
        price_in, price_out = claude_client.PRICES_PER_MILLION.get(claude_client.MODEL, (0.0, 0.0))
        self._send_json(200, {
            "days": days, "since": since, "model": claude_client.MODEL,
            "price_input_per_million": price_in, "price_output_per_million": price_out,
            "timezone": "America/Bogota (UTC-5)",
            "rows": [dict(r) for r in rows],
        })

    def _handle_admin_users(self):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT id, username, created_at, last_login_at, is_admin FROM users ORDER BY created_at"
            ).fetchall()
        finally:
            conn.close()
        users = [
            {
                "id": r["id"], "username": r["username"], "created_at": r["created_at"],
                "last_login_at": r["last_login_at"],
                "is_admin": bool(r["is_admin"]), "is_super_admin": r["username"].lower() in SUPER_ADMIN_USERNAMES,
            }
            for r in rows
        ]
        self._send_json(200, {"users": users})

    # Borra una cuenta y cualquier sesión activa que tenga — sin la fila en
    # `users`, _get_current_user() ya no puede resolver esa sesión (el JOIN
    # con sessions deja de matchear), así que el logout es inmediato aunque
    # tenga el navegador abierto. Con el registro cerrado (PMH_REGISTRATION_CODE),
    # la única forma de volver a entrar es que alguien la registre de nuevo
    # con el código de invitación.
    def _handle_admin_delete_user(self, payload):
        username = (payload.get("username") or "").strip().lower()
        if not username:
            self._send_json(400, {"error": "Falta el username a borrar."})
            return
        if username in SUPER_ADMIN_USERNAMES:
            self._send_json(403, {"error": "Esta cuenta es super administrador y no se puede borrar."})
            return
        conn = get_db()
        try:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if not row:
                self._send_json(404, {"error": "No existe esa cuenta."})
                return
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
            conn.execute("DELETE FROM user_account_access WHERE user_id = ?", (row["id"],))
            conn.execute("DELETE FROM user_mcc_access WHERE user_id = ?", (row["id"],))
            conn.execute("DELETE FROM users WHERE id = ?", (row["id"],))
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True, "deleted": username})

    # Da o quita permisos de administrador a un usuario desde el panel.
    # PMH_SUPER_ADMIN_USERNAMES nunca se puede bajar acá (siempre debe poder
    # administrar) y nadie puede quitarse sus propios permisos por accidente
    # — en ambos casos pedimos que lo haga otro administrador.
    def _handle_admin_set_admin(self, payload):
        requester = self._get_current_user()
        user_id = payload.get("user_id")
        make_admin = bool(payload.get("is_admin"))
        if not user_id:
            self._send_json(400, {"error": "Falta user_id."})
            return
        conn = get_db()
        try:
            target = conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
            if not target:
                self._send_json(404, {"error": "No existe ese usuario."})
                return
            if not make_admin and target["username"].lower() in SUPER_ADMIN_USERNAMES:
                self._send_json(403, {"error": "Esta cuenta es super administrador y no se le puede quitar el permiso de administrador."})
                return
            if not make_admin and target["id"] == requester["id"]:
                self._send_json(403, {"error": "No puedes quitarte tus propios permisos de administrador — pide a otro administrador que lo haga."})
                return
            conn.execute("UPDATE users SET is_admin = ? WHERE id = ?", (1 if make_admin else 0, target["id"]))
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True, "username": target["username"], "is_admin": make_admin})

    # Lista los grants de acceso a cuentas de Google Ads — de un usuario si
    # se pasa user_id, o todos los grants de todos los usuarios si no (para
    # tener una vista completa de "quién puede tocar qué" de un vistazo).
    def _handle_admin_access(self, query):
        user_id = (query.get("user_id") or [""])[0].strip()
        conn = get_db()
        try:
            if user_id:
                rows = conn.execute(
                    "SELECT user_account_access.user_id, users.username, user_account_access.customer_id, "
                    "user_account_access.account_name, user_account_access.created_at "
                    "FROM user_account_access JOIN users ON users.id = user_account_access.user_id "
                    "WHERE user_account_access.user_id = ? ORDER BY user_account_access.created_at",
                    (user_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT user_account_access.user_id, users.username, user_account_access.customer_id, "
                    "user_account_access.account_name, user_account_access.created_at "
                    "FROM user_account_access JOIN users ON users.id = user_account_access.user_id "
                    "ORDER BY users.username, user_account_access.created_at"
                ).fetchall()
            mcc_sql = (
                "SELECT user_mcc_access.user_id, users.username, user_mcc_access.mcc_customer_id, "
                "user_mcc_access.mcc_name, user_mcc_access.created_at "
                "FROM user_mcc_access JOIN users ON users.id = user_mcc_access.user_id "
            )
            if user_id:
                mcc_rows = conn.execute(mcc_sql + "WHERE user_mcc_access.user_id = ? ORDER BY user_mcc_access.created_at", (user_id,)).fetchall()
            else:
                mcc_rows = conn.execute(mcc_sql + "ORDER BY users.username, user_mcc_access.created_at").fetchall()
        finally:
            conn.close()
        access = [
            {
                "user_id": r["user_id"], "username": r["username"],
                "customer_id": r["customer_id"], "account_name": r["account_name"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        mcc_access = [
            {
                "user_id": r["user_id"], "username": r["username"],
                "mcc_customer_id": r["mcc_customer_id"], "mcc_name": r["mcc_name"],
                "created_at": r["created_at"],
            }
            for r in mcc_rows
        ]
        self._send_json(200, {"access": access, "mcc_access": mcc_access})

    # Le da a un usuario acceso a una cuenta de Google Ads puntual —
    # account_name es opcional, solo para que la lista de arriba sea legible
    # sin tener que volver a consultar la API por el nombre.
    def _handle_admin_access_grant(self, payload):
        user_id = payload.get("user_id")
        customer_id = str(payload.get("customer_id") or "").strip()
        account_name = payload.get("account_name")
        if not user_id or not customer_id.isdigit():
            self._send_json(400, {"error": "Faltan user_id o customer_id (customer_id debe ser numérico)."})
            return
        conn = get_db()
        try:
            exists = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
            if not exists:
                self._send_json(404, {"error": "No existe ese usuario."})
                return
            conn.execute(
                "INSERT OR IGNORE INTO user_account_access (user_id, customer_id, account_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, customer_id, account_name, time.time()),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    # Liga a un usuario a un sub-MCC completo (una marca de hotel): ve y toca
    # todas las cuentas que cuelguen de él, también las futuras. Solo se
    # aceptan sub-MCCs (nunca el MCC raíz, que daría acceso a las 1100+
    # cuentas) y, con la API configurada, el ID debe existir de verdad.
    def _handle_admin_access_grant_mcc(self, payload):
        user_id = payload.get("user_id")
        mcc_id = str(payload.get("mcc_customer_id") or "").strip()
        mcc_name = payload.get("mcc_name")
        if not user_id or not mcc_id.isdigit():
            self._send_json(400, {"error": "Faltan user_id o mcc_customer_id (debe ser numérico)."})
            return
        if google_ads_client.is_configured():
            try:
                groups = {g["id"]: g["name"] for g in google_ads_client.list_mcc_groups()}
            except Exception as e:  # noqa: BLE001
                self._send_google_ads_error(e)
                return
            if mcc_id not in groups:
                self._send_json(400, {"error": "Ese ID no es un sub-MCC de la cuenta administradora."})
                return
            mcc_name = mcc_name or groups[mcc_id]
        conn = get_db()
        try:
            target = conn.execute("SELECT id, is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
            if not target:
                self._send_json(404, {"error": "No existe ese usuario."})
                return
            conn.execute(
                "INSERT OR IGNORE INTO user_mcc_access (user_id, mcc_customer_id, mcc_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, mcc_id, mcc_name, time.time()),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_admin_access_revoke_mcc(self, payload):
        user_id = payload.get("user_id")
        mcc_id = str(payload.get("mcc_customer_id") or "").strip()
        if not user_id or not mcc_id:
            self._send_json(400, {"error": "Faltan user_id o mcc_customer_id."})
            return
        conn = get_db()
        try:
            conn.execute(
                "DELETE FROM user_mcc_access WHERE user_id = ? AND mcc_customer_id = ?",
                (user_id, mcc_id),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_admin_access_revoke(self, payload):
        user_id = payload.get("user_id")
        customer_id = str(payload.get("customer_id") or "").strip()
        if not user_id or not customer_id:
            self._send_json(400, {"error": "Faltan user_id o customer_id."})
            return
        conn = get_db()
        try:
            conn.execute(
                "DELETE FROM user_account_access WHERE user_id = ? AND customer_id = ?",
                (user_id, customer_id),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    # Genera una contraseña temporal para otro usuario (ej. la olvidó y no
    # hay forma de recuperarla — se guarda con hash, nadie puede leerla). El
    # admin debe pasársela por fuera de la plataforma (Slack, en persona,
    # etc.); la app la muestra una sola vez en esta respuesta y nunca vuelve
    # a quedar accesible. must_change_password fuerza a que la primera acción
    # tras iniciar sesión con la temporal sea definir una propia — ver
    # _handle_change_password y el gate en app.js. También cierra cualquier
    # sesión abierta que tuviera esa cuenta y le quita el bloqueo por
    # intentos fallidos, si lo tenía.
    #
    # Restablecer la contraseña de un super admin exige que quien lo pide
    # también lo sea — un admin normal no puede tomar el control de una
    # cuenta con más privilegios que la suya reseteándole la contraseña.
    def _handle_admin_reset_password(self, payload):
        requester = self._get_current_user()
        user_id = payload.get("user_id")
        if not user_id:
            self._send_json(400, {"error": "Falta user_id."})
            return
        conn = get_db()
        try:
            target = conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
            if not target:
                self._send_json(404, {"error": "No existe ese usuario."})
                return
            target_is_super_admin = target["username"].lower() in SUPER_ADMIN_USERNAMES
            requester_is_super_admin = requester["username"].lower() in SUPER_ADMIN_USERNAMES
            if target_is_super_admin and not requester_is_super_admin:
                self._send_json(403, {"error": "Solo un super administrador puede restablecer la contraseña de otro super administrador."})
                return

            temp_password = secrets.token_urlsafe(12)
            salt_hex, pw_hash = hash_password(temp_password)
            conn.execute(
                "UPDATE users SET salt = ?, password_hash = ?, must_change_password = 1, "
                "failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
                (salt_hex, pw_hash, target["id"]),
            )
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (target["id"],))
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True, "username": target["username"], "temp_password": temp_password})

    # Cambio de contraseña por el propio usuario — lo usa tanto el flujo
    # forzado tras un reset de admin (ver arriba) como un cambio voluntario
    # en cualquier momento. Exige la contraseña actual para no permitir que
    # una sesión robada (ej. una pestaña abierta) cambie la contraseña sin
    # saberla.
    def _handle_change_password(self, payload):
        user = self._get_current_user()
        if not _change_password_limiter.allow(f"user:{user['id']}", *CHANGE_PASSWORD_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiados intentos. Espera unos minutos y vuelve a intentar."})
            return
        current_password = payload.get("current_password") or ""
        new_password = payload.get("new_password") or ""
        if len(new_password) < MIN_PASSWORD_LENGTH:
            self._send_json(400, {"error": f"La nueva contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres."})
            return
        conn = get_db()
        try:
            row = conn.execute("SELECT salt, password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
            if not row or not verify_password(current_password, row["salt"], row["password_hash"]):
                self._send_json(401, {"error": "La contraseña actual no es correcta."})
                return
            salt_hex, pw_hash = hash_password(new_password)
            conn.execute(
                "UPDATE users SET salt = ?, password_hash = ?, must_change_password = 0 WHERE id = ?",
                (salt_hex, pw_hash, user["id"]),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_register(self, payload):
        if not _register_limiter.allow(self._client_ip(), *REGISTER_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiados intentos de registro. Espera unos minutos y vuelve a intentar."})
            return
        username = (payload.get("username") or "").strip().lower()
        password = payload.get("password") or ""
        code = str(payload.get("code") or "")
        # secrets.compare_digest evita filtrar por temporización si el código
        # es correcto o no (aunque acá el impacto es menor, es el mismo
        # criterio que ya se usa para comparar contraseñas).
        if not REGISTRATION_CODE or not secrets.compare_digest(code, REGISTRATION_CODE):
            self._send_json(403, {"error": "Código de invitación inválido o registro cerrado. Pide el código a quien administra la plataforma."})
            return
        if not USERNAME_RE.match(username):
            self._send_json(400, {"error": "El usuario debe tener entre 3 y 100 caracteres, y solo letras, números, o . _ @ + -"})
            return
        if len(password) < MIN_PASSWORD_LENGTH:
            self._send_json(400, {"error": f"La contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres."})
            return

        conn = get_db()
        try:
            existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if existing:
                self._send_json(409, {"error": "Ese usuario ya existe. Prueba iniciar sesión."})
                return
            salt_hex, pw_hash = hash_password(password)
            now = time.time()
            cur = conn.execute(
                "INSERT INTO users (username, salt, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
                (username, salt_hex, pw_hash, now, now),
            )
            conn.commit()
            user_id = cur.lastrowid
        finally:
            conn.close()
        self._start_session(user_id, username)

    def _handle_login(self, payload):
        if not _login_limiter.allow(self._client_ip(), *LOGIN_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiados intentos. Espera unos minutos y vuelve a intentar."})
            return
        username = (payload.get("username") or "").strip().lower()
        password = payload.get("password") or ""
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT id, salt, password_hash, failed_login_attempts, locked_until, must_change_password "
                "FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            now = time.time()
            locked = bool(row and row["locked_until"] and row["locked_until"] > now)
            # verify_password corre siempre que el usuario existe, esté
            # bloqueado o no — si se saltara la verificación solo cuando está
            # bloqueado, el tiempo de respuesta (PBKDF2 es la parte lenta)
            # delataría qué cuentas existen y cuáles están bloqueadas, el
            # mismo problema de enumeración que el mensaje genérico de abajo
            # ya evita.
            verified = bool(row) and verify_password(password, row["salt"], row["password_hash"])
            ok = verified and not locked
            if row and not locked:
                if verified:
                    conn.execute(
                        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
                        (now, row["id"]),
                    )
                else:
                    attempts = row["failed_login_attempts"] + 1
                    if attempts >= LOGIN_LOCKOUT_THRESHOLD:
                        conn.execute(
                            "UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?",
                            (now + LOGIN_LOCKOUT_SECONDS, row["id"]),
                        )
                    else:
                        conn.execute(
                            "UPDATE users SET failed_login_attempts = ? WHERE id = ?", (attempts, row["id"])
                        )
                conn.commit()
        finally:
            conn.close()
        # Mismo mensaje si el usuario no existe, la contraseña está mal, o la
        # cuenta está bloqueada por intentos fallidos — para no filtrar ni
        # qué usuarios existen ni cuáles están bloqueados ahora mismo.
        if not ok:
            self._send_json(401, {"error": "Usuario o contraseña incorrectos."})
            return
        self._start_session(row["id"], username, must_change_password=bool(row["must_change_password"]))

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

    def _start_session(self, user_id, username, must_change_password=False):
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
            {"ok": True, "username": username, "must_change_password": must_change_password},
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
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        try:
            accounts = google_ads_client.list_client_accounts()
            # Un usuario no-admin solo ve, en el selector, las cuentas que ya
            # tiene asignadas — evita que navegue/descubra IDs de cuentas de
            # clientes a las que no tiene acceso, aunque igual no podría usarlos
            # (los demás endpoints los rechazan por separado).
            if not user["is_admin"]:
                allowed_ids = self._get_user_account_ids(user["id"])
                accounts = [a for a in accounts if a["id"] in allowed_ids]
            self._send_json(200, {"accounts": accounts, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # ---- Ritmo de consumo ---------------------------------------------
    # Qué cuentas vigila cada usuario vive en user_pacing_watchlist, aparte
    # de user_account_access (permiso de lectura/escritura) — ver el
    # comentario en init_db. El flujo de "a cuáles tengo acceso para poder
    # agregarlas" sigue siendo /api/google-ads/accounts de siempre.

    def _handle_pacing_watchlist(self):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT customer_id, account_name FROM user_pacing_watchlist WHERE user_id = ? ORDER BY created_at",
                (user["id"],),
            ).fetchall()
            # MCCs completos agregados, con cuántas de sus cuentas siguen vigiladas.
            groups = conn.execute(
                """
                SELECT g.group_customer_id, g.group_name,
                       (SELECT COUNT(*) FROM user_pacing_mcc_group_accounts ga
                         JOIN user_pacing_watchlist w
                           ON w.user_id = ga.user_id AND w.customer_id = ga.customer_id
                        WHERE ga.user_id = g.user_id AND ga.group_customer_id = g.group_customer_id) AS watched
                FROM user_pacing_mcc_groups g
                WHERE g.user_id = ? ORDER BY g.created_at
                """,
                (user["id"],),
            ).fetchall()
            # Cuentas de cada MCC que siguen vigiladas (sirve para filtrar Campañas por MCC).
            group_accounts = {}
            for r in conn.execute(
                """
                SELECT ga.group_customer_id, ga.customer_id
                FROM user_pacing_mcc_group_accounts ga
                JOIN user_pacing_watchlist w ON w.user_id = ga.user_id AND w.customer_id = ga.customer_id
                WHERE ga.user_id = ?
                """,
                (user["id"],),
            ).fetchall():
                group_accounts.setdefault(r["group_customer_id"], []).append(r["customer_id"])
        finally:
            conn.close()
        self._send_json(200, {
            "watchlist": [{"customer_id": r["customer_id"], "account_name": r["account_name"]} for r in rows],
            "mcc_groups": [
                {
                    "group_customer_id": g["group_customer_id"], "group_name": g["group_name"], "watched": g["watched"],
                    "account_ids": group_accounts.get(g["group_customer_id"], []),
                }
                for g in groups
            ],
        })

    def _handle_pacing_watchlist_add(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        account_name = payload.get("account_name")
        if not customer_id.isdigit():
            self._send_json(400, {"error": "customer_id debe ser numérico."})
            return
        # Mismo criterio fail-secure que el resto de los endpoints: aunque
        # esto es de solo lectura, no dejamos vigilar una cuenta a la que no
        # se tiene acceso — pero solo aplica con la API real conectada; en
        # modo simulado (is_configured() False) ninguna otra pantalla
        # restringe las 2 cuentas de ejemplo, así que esta tampoco debería.
        if google_ads_client.is_configured() and not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        conn = get_db()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO user_pacing_watchlist (user_id, customer_id, account_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user["id"], customer_id, account_name, time.time()),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_pacing_watchlist_remove(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        if not customer_id:
            self._send_json(400, {"error": "Falta customer_id."})
            return
        conn = get_db()
        try:
            conn.execute(
                "DELETE FROM user_pacing_watchlist WHERE user_id = ? AND customer_id = ?",
                (user["id"], customer_id),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_pacing_watchlist_clear(self):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        conn = get_db()
        try:
            conn.execute("DELETE FROM user_pacing_watchlist WHERE user_id = ?", (user["id"],))
            conn.execute("DELETE FROM user_pacing_mcc_groups WHERE user_id = ?", (user["id"],))
            conn.execute("DELETE FROM user_pacing_mcc_group_accounts WHERE user_id = ?", (user["id"],))
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def _handle_google_ads_pacing(self, query=None):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        # month_from / month_to (AAAA-MM) para ver un mes ya cerrado, o la
        # suma de varios meses seguidos; sin ellos (o con el mes en curso en
        # ambos) es el ritmo de hoy de siempre.
        month_from = month_to = None
        q = query or {}
        raw_from = (q.get("month_from") or [""])[0].strip()
        raw_to = (q.get("month_to") or [""])[0].strip()
        if raw_from or raw_to:
            parsed_months = []
            for raw in (raw_from, raw_to):
                m = re.match(r"^(\d{4})-(\d{2})$", raw)
                if not m or not 1 <= int(m.group(2)) <= 12:
                    self._send_json(400, {"error": "month_from y month_to deben tener formato AAAA-MM."})
                    return
                parsed_months.append((int(m.group(1)), int(m.group(2))))
            month_from, month_to = parsed_months
            today = datetime.date.today()
            if month_to > (today.year, today.month):
                self._send_json(400, {"error": "No se puede consultar un mes futuro."})
                return
            if month_from > month_to:
                self._send_json(400, {"error": "month_from no puede ser posterior a month_to."})
                return
            span = (month_to[0] - month_from[0]) * 12 + month_to[1] - month_from[1] + 1
            if span > 24:
                self._send_json(400, {"error": "El rango máximo es de 24 meses."})
                return
        conn = get_db()
        try:
            watched = conn.execute(
                "SELECT customer_id, account_name FROM user_pacing_watchlist WHERE user_id = ? ORDER BY created_at",
                (user["id"],),
            ).fetchall()
        finally:
            conn.close()

        simulated = not google_ads_client.is_configured()
        rows = []
        for w in watched:
            customer_id = w["customer_id"]
            name = w["account_name"] or f"Cuenta {customer_id}"
            try:
                if simulated:
                    pacing = google_ads_client.simulated_account_pacing(customer_id, month_from, month_to)
                elif not self._user_can_access_account(user, customer_id):
                    # Pudo haber perdido el acceso después de agregarla a vigilar.
                    rows.append({
                        "customer_id": customer_id, "account_name": name,
                        "error": "Ya no tienes acceso a esta cuenta.",
                    })
                    continue
                else:
                    pacing = google_ads_client.fetch_account_pacing(customer_id, month_from, month_to)
                rows.append({"customer_id": customer_id, "account_name": name, "error": None, **pacing,
                             "currency": "USD" if simulated else google_ads_client.fetch_customer_currency(customer_id)})
            except Exception as e:  # noqa: BLE001 — una cuenta con error no debe tumbar el resto del tablero
                print(f"[pacing-error] customer_id={customer_id} {' '.join(str(e).split())}", flush=True)
                rows.append({
                    "customer_id": customer_id, "account_name": name,
                    "error": "No se pudo traer el ritmo de esta cuenta.",
                })
        self._send_json(200, {"rows": rows, "simulated": simulated})

    # Campañas activas de una cuenta vigilada, con KPIs del mes en curso y
    # su presupuesto diario — para poder ajustarlo sin salir de Ritmo de
    # consumo. Lectura: cualquier usuario con acceso a la cuenta. El ajuste
    # en sí (POST más abajo) es la única escritura real de esta sección.
    def _handle_pacing_account_campaigns(self, query):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = (query.get("customer_id") or [""])[0].strip()
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_account_campaigns_budget(customer_id), "simulated": True, "currency": "USD"})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            rows = google_ads_client.fetch_account_campaigns_budget(customer_id)
            self._send_json(200, {"rows": rows, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    def _handle_pacing_campaign_budget_adjust(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        budget_resource_name = str(payload.get("budget_resource_name") or "").strip()
        validate_only = payload.get("validate_only", True) is not False
        try:
            new_daily_budget = float(payload.get("new_daily_budget"))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "new_daily_budget debe ser un número."})
            return

        if not customer_id or not budget_resource_name:
            self._send_json(400, {"error": "Faltan customer_id o budget_resource_name."})
            return

        if not google_ads_client.is_configured():
            try:
                result = google_ads_client.simulated_update_campaign_daily_budget(new_daily_budget, validate_only)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.update_campaign_daily_budget(customer_id, budget_resource_name, new_daily_budget, validate_only)
            self._send_json(200, result)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    # Diagnóstico de BigQuery (solo administradores): sin parámetros prueba la
    # conexión y lista datasets; con `dataset` lista sus tablas; con `dataset`
    # y `table` devuelve el esquema. Sirve para descubrir dónde están las
    # reservas antes de construir consultas. Solo lectura.
    def _handle_bigquery_explore(self, query):
        user = self._require_admin_json()
        if not user:
            return
        if not bigquery_client.is_configured():
            self._send_json(200, {
                "configured": False,
                "error": "BigQuery no está configurado: faltan BIGQUERY_PROJECT_ID y/o BIGQUERY_REFRESH_TOKEN.",
            })
            return
        dataset = (query.get("dataset") or [""])[0].strip()
        table = (query.get("table") or [""])[0].strip()
        project = (query.get("project") or [""])[0].strip() or None
        try:
            if dataset and table:
                result = bigquery_client.get_table_schema(dataset, table, project)
            elif dataset:
                result = {"tables": bigquery_client.list_tables(dataset, project)}
            else:
                result = bigquery_client.check_connection()
            self._send_json(200, {"configured": True, **result})
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_json(502, {"error": str(e)})

    # Sub-MCCs del MCC — usado tanto por Ritmo de consumo (agregar todas sus
    # cuentas a la vez) como por el selector de cuenta de ROAS (filtrar la
    # lista a solo las cuentas de una marca, en vez de buscar entre miles).
    # Solo para administradores: ver los nombres de TODAS las agrupaciones
    # de clientes del MCC no es algo que cualquier usuario no-admin deba
    # poder explorar (mismo criterio que "Buscar en las cuentas del MCC" en
    # Administración).
    def _handle_mcc_groups(self):
        user = self._require_admin_json()
        if not user:
            return
        if not google_ads_client.is_configured():
            self._send_json(200, {"groups": [], "simulated": True})
            return
        try:
            groups = google_ads_client.list_mcc_groups()
            self._send_json(200, {"groups": groups, "simulated": False})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    def _handle_pacing_mcc_groups(self):
        """MCCs que se pueden agregar de un jalón a Ritmo de consumo: un admin ve todos
        los sub-MCCs; un usuario común solo los que tiene asignados en Administración."""
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not google_ads_client.is_configured():
            self._send_json(200, {"groups": [], "simulated": True})
            return
        if user["is_admin"]:
            try:
                groups = google_ads_client.list_mcc_groups()
            except Exception as e:  # noqa: BLE001
                self._send_google_ads_error(e)
                return
            self._send_json(200, {"groups": groups, "simulated": False})
            return
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT mcc_customer_id, mcc_name FROM user_mcc_access WHERE user_id = ? ORDER BY mcc_name",
                (user["id"],),
            ).fetchall()
        finally:
            conn.close()
        self._send_json(200, {
            "groups": [{"id": r["mcc_customer_id"], "name": r["mcc_name"] or r["mcc_customer_id"]} for r in rows],
            "simulated": False,
        })

    def _handle_mcc_group_accounts(self, query):
        user = self._require_admin_json()
        if not user:
            return
        group_customer_id = (query.get("group_customer_id") or [""])[0].strip()
        if not group_customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro group_customer_id."})
            return
        if not google_ads_client.is_configured():
            self._send_json(200, {"accounts": [], "simulated": True})
            return
        try:
            accounts = google_ads_client.list_mcc_group_accounts(group_customer_id)
            self._send_json(200, {"accounts": accounts, "simulated": False})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    def _handle_pacing_watchlist_add_mcc_group(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        group_customer_id = str(payload.get("group_customer_id") or "").strip()
        if not group_customer_id.isdigit():
            self._send_json(400, {"error": "group_customer_id debe ser numérico."})
            return
        # Un usuario común solo puede agregar los MCCs que tiene asignados (fail-secure).
        if not user["is_admin"] and group_customer_id not in self._get_user_mcc_ids(user["id"]):
            self._send_json(403, {"error": "No tienes acceso a este MCC."})
            return
        if not google_ads_client.is_configured():
            self._send_json(400, {"error": "La API de Google Ads no está configurada."})
            return
        try:
            accounts = google_ads_client.list_mcc_group_accounts(group_customer_id)
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)
            return
        group_name = str(payload.get("group_name") or "").strip()[:200] or None
        conn = get_db()
        try:
            added = 0
            for acc in accounts:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO user_pacing_watchlist (user_id, customer_id, account_name, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (user["id"], acc["id"], acc["name"], time.time()),
                )
                if cur.rowcount:
                    added += 1
                conn.execute(
                    "INSERT OR IGNORE INTO user_pacing_mcc_group_accounts (user_id, group_customer_id, customer_id) "
                    "VALUES (?, ?, ?)",
                    (user["id"], group_customer_id, acc["id"]),
                )
            # Si el MCC ya estaba en la lista solo se actualiza el nombre.
            conn.execute(
                "INSERT INTO user_pacing_mcc_groups (user_id, group_customer_id, group_name, created_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, group_customer_id) DO UPDATE SET group_name = COALESCE(excluded.group_name, group_name)",
                (user["id"], group_customer_id, group_name, time.time()),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True, "found": len(accounts), "added": added})

    def _handle_pacing_watchlist_remove_mcc_group(self, payload):
        """Quita un MCC de la lista y deja de vigilar sus cuentas, salvo las que
        otro MCC de la lista también trae. No toca nada en Google Ads."""
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        group_customer_id = str(payload.get("group_customer_id") or "").strip()
        if not group_customer_id.isdigit():
            self._send_json(400, {"error": "group_customer_id debe ser numérico."})
            return
        conn = get_db()
        try:
            # Qué cuentas se van (las del MCC que ningún otro MCC de la lista trae y que
            # siguen vigiladas): se devuelven para que la pantalla las quite sin recargar todo.
            removed_ids = [
                r["customer_id"] for r in conn.execute(
                    """
                    SELECT w.customer_id FROM user_pacing_watchlist w
                    WHERE w.user_id = ?
                      AND w.customer_id IN (
                          SELECT customer_id FROM user_pacing_mcc_group_accounts
                          WHERE user_id = ? AND group_customer_id = ?
                      )
                      AND w.customer_id NOT IN (
                          SELECT customer_id FROM user_pacing_mcc_group_accounts
                          WHERE user_id = ? AND group_customer_id <> ?
                      )
                    """,
                    (user["id"], user["id"], group_customer_id, user["id"], group_customer_id),
                ).fetchall()
            ]
            for cid in removed_ids:
                conn.execute(
                    "DELETE FROM user_pacing_watchlist WHERE user_id = ? AND customer_id = ?",
                    (user["id"], cid),
                )
            removed = len(removed_ids)
            conn.execute(
                "DELETE FROM user_pacing_mcc_group_accounts WHERE user_id = ? AND group_customer_id = ?",
                (user["id"], group_customer_id),
            )
            conn.execute(
                "DELETE FROM user_pacing_mcc_groups WHERE user_id = ? AND group_customer_id = ?",
                (user["id"], group_customer_id),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True, "removed": removed, "removed_ids": removed_ids})

    def _handle_google_ads_campaigns(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        only_active = (query.get("only_active") or [""])[0].strip() == "1"
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_campaign_rows(only_active), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_campaign_rows(customer_id, date_from, date_to, only_active)
            # La moneda se manda para que la comparación de varias cuentas no mezcle euros con pesos.
            self._send_json(200, {"rows": rows, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_search_terms(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        # pmax_terms=1 (pestaña "Con IA"): términos reales de Performance Max con costo, en vez de categorías.
        pmax_terms = (query.get("pmax_terms") or [""])[0].strip() == "1"

        if not google_ads_client.is_configured():
            pmax_rows = google_ads_client.simulated_pmax_search_terms() if pmax_terms else google_ads_client.simulated_pmax_search_term_insights()
            rows = google_ads_client.simulated_search_terms() + pmax_rows
            self._send_json(200, {"rows": rows, "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_search_terms(customer_id, date_from, date_to)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)
            return

        # Categorías de Performance Max — recurso distinto (ver
        # fetch_pmax_search_term_insights), no cuentas sin campañas PMax lo
        # necesitan; si falla, no debe tumbar el reporte de términos Search
        # que sí funcionó.
        pmax_fallback = False
        if pmax_terms:
            try:
                rows = rows + google_ads_client.fetch_pmax_search_terms(customer_id, date_from, date_to)
            except Exception as e:  # noqa: BLE001 — si falla la vista de términos, se cae a las categorías de siempre
                print(f"[pmax-terms] {' '.join(str(e).split())[:200]}", flush=True)
                pmax_fallback = True
        if not pmax_terms or pmax_fallback:
            try:
                rows = rows + google_ads_client.fetch_pmax_search_term_insights(customer_id, date_from, date_to)
            except Exception:
                pass

        self._send_json(200, {"rows": rows, "simulated": False, "pmax_fallback": pmax_fallback, "currency": google_ads_client.fetch_customer_currency(customer_id)})

    def _handle_google_ads_campaigns_overview(self, query):
        # Sección Campañas: todas las campañas de una cuenta (activas y pausadas) con sus KPIs del rango.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not google_ads_client.is_configured():
            self._send_json(200, {"campaigns": google_ads_client.simulated_campaigns_overview(), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            campaigns = google_ads_client.fetch_campaigns_overview(customer_id, date_from, date_to)
            self._send_json(200, {"campaigns": campaigns, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_campaign_daily(self, query):
        # Detalle de una campaña en Campañas: la serie día a día para sus gráficas.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return
        try:
            span = (datetime.date.fromisoformat(date_to) - datetime.date.fromisoformat(date_from)).days
        except ValueError:
            self._send_json(400, {"error": "Fechas inválidas."})
            return
        if span < 0 or span > 366:
            self._send_json(400, {"error": "El rango debe ir de 1 a 366 días."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, {"days": google_ads_client.simulated_campaign_daily(campaign_id, date_from, date_to), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            days = google_ads_client.fetch_campaign_daily(customer_id, campaign_id, date_from, date_to)
            self._send_json(200, {"days": days, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_campaign_breakdown(self, query):
        # Detalle de una campaña en Campañas: sus grupos activos y a dónde se dirige, con KPIs del rango.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        channel_type = (query.get("channel_type") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return

        if not google_ads_client.is_configured():
            data = google_ads_client.simulated_campaign_breakdown(campaign_id) or {"groups": {"kind": "ad_group", "groups": []}, "targeting": {"locations": [], "radii": [], "languages": [], "geo_target_type": None}}
            self._send_json(200, {**data, **google_ads_client.simulated_breakdown_previous(campaign_id), "errors": {}, "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        out = {"groups": None, "targeting": None, "errors": {}, "simulated": False,
               "currency": google_ads_client.fetch_customer_currency(customer_id)}
        # Periodo anterior (opcional) para mostrar la variación de cada grupo y de cada ubicación.
        prev_from = (query.get("prev_from") or [""])[0].strip()
        prev_to = (query.get("prev_to") or [""])[0].strip()
        if date_pattern.match(prev_from) and date_pattern.match(prev_to):
            try:
                prev = google_ads_client.fetch_campaign_groups(customer_id, campaign_id, channel_type, prev_from, prev_to)
                out["prev_groups"] = {g["id"]: g for g in prev["groups"]}
            except Exception:  # noqa: BLE001 — sin comparación las tablas se ven igual
                out["prev_groups"] = {}
            try:
                out["prev_locations"] = google_ads_client.fetch_campaign_location_metrics(customer_id, campaign_id, prev_from, prev_to)
            except Exception:  # noqa: BLE001
                out["prev_locations"] = {}
        failures = []
        try:
            out["groups"] = google_ads_client.fetch_campaign_groups(customer_id, campaign_id, channel_type, date_from, date_to)
        except Exception as e:  # noqa: BLE001
            failures.append(("groups", e))
        try:
            out["targeting"] = google_ads_client.fetch_campaign_targeting(customer_id, campaign_id, date_from, date_to)
        except Exception as e:  # noqa: BLE001
            failures.append(("targeting", e))
        if len(failures) == 2:
            # Si fallaron las dos, es un problema general de la API: se responde igual que el resto de reportes.
            self._send_google_ads_error(failures[0][1])
            return
        for name, exc in failures:
            out["errors"][name] = " ".join(str(exc).split())[:300]
        self._send_json(200, out)

    def _handle_google_ads_campaign_insight(self, query):
        # Pestañas del detalle de una campaña (resumen y comparación, segmentos, palabras clave, posición).
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        view = (query.get("view") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        prev_from = (query.get("prev_from") or [""])[0].strip()
        prev_to = (query.get("prev_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if view not in ("context", "segments", "keywords", "position"):
            self._send_json(400, {"error": "Vista desconocida."})
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return
        has_prev = bool(date_pattern.match(prev_from) and date_pattern.match(prev_to))

        if not google_ads_client.is_configured():
            data = google_ads_client.simulated_campaign_insight(view, campaign_id)
            self._send_json(200, {"data": data, "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            if view == "context":
                data = google_ads_client.fetch_campaign_context(customer_id, campaign_id, date_from, date_to, prev_from if has_prev else None, prev_to if has_prev else None)
            elif view == "segments":
                data = google_ads_client.fetch_campaign_segments(customer_id, campaign_id, date_from, date_to)
            elif view == "keywords":
                data = google_ads_client.fetch_campaign_keywords(customer_id, campaign_id, date_from, date_to)
            else:
                data = google_ads_client.fetch_campaign_position(customer_id, campaign_id, date_from, date_to, prev_from if has_prev else None, prev_to if has_prev else None)
            self._send_json(200, {"data": data, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_account_changes(self, query):
        # Historial de cambios de una cuenta (change_event, últimos 30 días como máximo). Solo lectura.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        days_raw = (query.get("days") or ["30"])[0].strip()
        if not days_raw.isdigit() or not 1 <= int(days_raw) <= 30:
            self._send_json(400, {"error": "days debe ser un número entre 1 y 30 (Google solo guarda 30 días de cambios)."})
            return
        days = int(days_raw)

        if not google_ads_client.is_configured():
            self._send_json(200, {**google_ads_client.simulated_account_changes(days), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            data = google_ads_client.fetch_account_changes(customer_id, days)
            self._send_json(200, {**data, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_audiences(self, query):
        # Sección Audiencias (solo lectura): listas, dónde se usa cada audiencia y su rendimiento en el rango.
        customer_id = (query.get("customer_id") or [""])[0].strip()
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")

        if not google_ads_client.is_configured():
            self._send_json(200, {**google_ads_client.simulated_account_audiences(date_from, date_to), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not date_pattern.match(date_from) or not date_pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return
        user = self._get_current_user()
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            data = google_ads_client.fetch_account_audiences(customer_id, date_from, date_to)
            self._send_json(200, {**data, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_campaign_status(self, payload):
        # Pausa o activa una campaña. Escribe de verdad en Google Ads cuando validate_only es false.
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        status = str(payload.get("status") or "").strip()
        old_status = str(payload.get("old_status") or "").strip()[:20]
        campaign_name = str(payload.get("campaign_name") or "")
        validate_only = payload.get("validate_only", True) is not False

        if status not in google_ads_client.CAMPAIGN_STATUS_VALUES:
            self._send_json(400, {"error": "El estado debe ser ENABLED o PAUSED."})
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_update_campaign_status(campaign_id, status, validate_only))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.update_campaign_status(customer_id, campaign_id, status, validate_only)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)
            return
        if not validate_only:
            try:
                store_campaign_status_change(user["id"], customer_id, campaign_id, campaign_name, old_status, status)
            except Exception as e:  # noqa: BLE001 — el cambio ya quedó en Google Ads; un fallo del registro no debe ocultarlo
                print(f"[campaign-status-log] {e}", flush=True)
        self._send_json(200, result)

    def _handle_recommendation_subscriptions(self, payload):
        # Pausa o reactiva recomendaciones automáticas de una cuenta. Escribe de verdad en Google Ads cuando validate_only es false.
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        status = str(payload.get("status") or "").strip()
        raw_types = payload.get("types") if isinstance(payload.get("types"), list) else []
        types = [t for t in dict.fromkeys(str(x).strip() for x in raw_types) if t]
        validate_only = payload.get("validate_only", True) is not False
        if status not in google_ads_client.RECOMMENDATION_SUBSCRIPTION_STATUS_VALUES:
            self._send_json(400, {"error": "El estado debe ser ENABLED o PAUSED."})
            return
        if not types or len(types) > 20:
            self._send_json(400, {"error": "Elige entre 1 y 20 tipos de recomendación."})
            return
        # Solo los tipos que la auditoría conoce (los que puede aplicar Google solo); nada arbitrario llega a la API.
        unknown = [t for t in types if t not in account_audit.AUTO_APPLY_LABELS]
        if unknown:
            self._send_json(400, {"error": "Tipo de recomendación no reconocido: " + ", ".join(unknown[:3])})
            return
        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_update_recommendation_subscriptions(types, status, validate_only))
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            result = google_ads_client.update_recommendation_subscriptions(customer_id, types, status, validate_only)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)
            return
        if not validate_only:
            try:
                store_recommendation_subscription_change(user["id"], customer_id, types, status)
            except Exception as e:  # noqa: BLE001 — el cambio ya quedó en Google Ads; un fallo del registro no debe ocultarlo
                print(f"[recommendation-subscription-log] {e}", flush=True)
        self._send_json(200, result)

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

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            campaigns = google_ads_client.fetch_account_campaigns(customer_id)
            self._send_json(200, {"campaigns": campaigns, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

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

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_impression_share_daily(customer_id, date_from, date_to)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

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

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_roas_by_campaign(customer_id, date_from, date_to, only_active)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # Recomendaciones propias de Google Ads (RecommendationService) + el
    # puntaje de optimización de la cuenta — de solo lectura, no el "Ask
    # Advisor" conversacional (ese no tiene API pública). No depende de un
    # rango de fechas, a diferencia del resto de /api/google-ads/*.
    def _handle_google_ads_recommendations(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()

        if not google_ads_client.is_configured():
            self._send_json(200, {
                "rows": google_ads_client.simulated_recommendations(),
                "score": google_ads_client.simulated_optimization_score(),
                "simulated": True, "currency": "USD",
            })
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_recommendations(customer_id)
            score = google_ads_client.fetch_optimization_score(customer_id)
            self._send_json(200, {"rows": rows, "score": score, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # Aplica/descarta una recomendación de Google Ads. A diferencia de
    # negative-keywords y roas-adjust, la API de recomendaciones NO soporta
    # validateOnly (confirmado contra el .proto real) — cada llamada aplica
    # o descarta de inmediato, sin vista previa posible del lado del
    # servidor. La confirmación por lo tanto corre del lado del cliente
    # (app.js pide confirmación explícita antes de llamar acá).
    def _handle_google_ads_recommendation_apply(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        resource_name = str(payload.get("resource_name") or "").strip()
        if not resource_name:
            self._send_json(400, {"error": "Falta resource_name."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_apply_recommendation(resource_name))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.apply_recommendation(customer_id, resource_name)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_recommendation_dismiss(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        resource_name = str(payload.get("resource_name") or "").strip()
        if not resource_name:
            self._send_json(400, {"error": "Falta resource_name."})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_dismiss_recommendation(resource_name))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.dismiss_recommendation(customer_id, resource_name)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # Prueba interna de integración con Claude — el cliente manda el resumen
    # y los hallazgos que ya calculó localmente (engine.js) y recibe de
    # vuelta una lectura priorizada en prosa. No toca Google Ads ni datos de
    # cuenta reales, así que no necesita _user_can_access_account.
    # Auditoría de cuenta: solo lectura. Trae los datos con ~12 consultas,
    # corre las reglas de account_audit.py y devuelve hallazgos + puntaje.
    def _handle_google_ads_audit(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if payload.get("batch") is True:
            # La auditoría de varias cuentas es solo para administradores (consume mucha cuota compartida de Google Ads).
            if not user["is_admin"]:
                self._send_json(403, {"error": "La auditoría de varias cuentas es solo para administradores."})
                return
            if not _audit_batch_limiter.allow(f"user:{user['id']}", *AUDIT_BATCH_RATE_LIMIT):
                self._send_json(429, {"error": f"Alcanzaste el límite de {AUDIT_BATCH_RATE_LIMIT[0]} auditorías por hora en lotes."})
                return
        elif not _audit_limiter.allow(f"user:{user['id']}", *AUDIT_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de auditorías por esta hora. Intenta más tarde."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        try:
            days = int(payload.get("days") or 30)
        except (TypeError, ValueError):
            days = 30
        days = days if days in (30, 60, 90) else 30
        raw_ctx = payload.get("context") if isinstance(payload.get("context"), dict) else {}
        ctx = {k: str(raw_ctx.get(k) or "").strip()[:300] for k in
               ("hotel_name", "brand_campaign_words", "brand_terms", "hotel_feed")}
        ctx["goal"] = raw_ctx.get("goal") if raw_ctx.get("goal") in ("roas", "cpa", "volumen") else "volumen"
        try:
            ctx["target"] = float(raw_ctx.get("target") or 0)
        except (TypeError, ValueError):
            ctx["target"] = 0.0

        date_to = datetime.date.today() - datetime.timedelta(days=1)
        date_from = date_to - datetime.timedelta(days=days - 1)

        if not google_ads_client.is_configured():
            data, simulated = google_ads_client.simulated_audit_data(), True
        else:
            if not customer_id.isdigit():
                self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
                return
            if not self._user_can_access_account(user, customer_id):
                self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
                return
            try:
                data, simulated = google_ads_client.fetch_audit_data(customer_id, date_from.isoformat(), date_to.isoformat()), False
            except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
                self._send_google_ads_error(e)
                return

        report = account_audit.run_audit(data, ctx, days)
        report["meta"] = {
            "account_name": data.get("account_name") or "", "customer_id": customer_id,
            "date_from": date_from.isoformat(), "date_to": date_to.isoformat(),
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"), "context": ctx,
            "unavailable": data.get("unavailable") or {},
            "excluded_experiments": data.get("excluded_experiments") or [],
        }
        # Historial: se guarda esta auditoría y se devuelve la serie de la cuenta junto con el informe.
        # Si falla el guardado, el informe se entrega igual, solo sin tendencia.
        history_id = customer_id or "simulada"
        try:
            save_audit_history(user["id"], history_id, simulated, report, ctx, days)
            report["history"] = load_audit_history(history_id, simulated)
        except Exception as e:  # noqa: BLE001
            print(f"[audit-history-error] {e}", flush=True)
            report["history"] = []
        report["rules_version"] = account_audit.RULES_VERSION
        self._send_json(200, {"report": report, "simulated": simulated})

    def _handle_audit_history(self, query):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = (query.get("customer_id") or [""])[0].strip()
        if not google_ads_client.is_configured():
            self._send_json(200, {"history": load_audit_history(customer_id or "simulada", True), "simulated": True})
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        self._send_json(200, {"history": load_audit_history(customer_id, False), "simulated": False})

    def _handle_ai_analizar_auditoria(self, payload):
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        if not _ai_limiter.allow(f"user:{user['id']}", *AI_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de análisis con IA por esta hora. Intenta más tarde."})
            return
        resumen, findings = payload.get("resumen"), payload.get("findings")
        if not isinstance(resumen, dict) or not isinstance(findings, list):
            self._send_json(400, {"error": "Faltan los datos de la auditoría (resumen/findings) para analizar."})
            return
        no_verificables = payload.get("no_verificables") if isinstance(payload.get("no_verificables"), list) else []
        contexto = payload.get("contexto") if isinstance(payload.get("contexto"), dict) else {}
        try:
            with track_ai_usage(user["id"], "auditoria"):
                narrativa = claude_client.analizar_auditoria(resumen, findings, no_verificables, contexto)
            self._send_json(200, {"narrativa": narrativa})
        except Exception as e:  # noqa: BLE001
            print(f"[claude-error] {e}", flush=True)
            self._send_json(502, {"error": "No se pudo generar el análisis con IA. Intenta de nuevo en unos minutos."})

    def _handle_ai_analizar_rendimiento(self, payload):
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        if not _ai_limiter.allow(f"user:{user['id']}", *AI_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de análisis con IA por esta hora. Intenta más tarde."})
            return

        resumen = payload.get("resumen")
        recs = payload.get("recs")
        if not isinstance(resumen, dict) or not isinstance(recs, list):
            self._send_json(400, {"error": "Faltan datos de rendimiento (resumen/recs) para analizar."})
            return

        try:
            with track_ai_usage(user["id"], "rendimiento"):
                narrativa = claude_client.analizar_rendimiento(resumen, recs)
            self._send_json(200, {"narrativa": narrativa})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            print(f"[claude-error] {e}", flush=True)
            self._send_json(502, {"error": "No se pudo generar el análisis con IA. Intenta de nuevo en unos minutos."})

    def _handle_negativos_palabras(self, payload):
        user = self._get_current_user()
        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            self._send_json(400, {"error": "Primero trae los términos de búsqueda: no hay nada que analizar."})
            return
        if len(rows) > negativos_ia.MAX_ROWS_ACCEPTED:
            self._send_json(400, {"error": f"Demasiados términos ({len(rows)}). Acorta el rango de fechas o elige una campaña."})
            return
        raw_ctx = payload.get("contexto") if isinstance(payload.get("contexto"), dict) else {}
        ctx = {k: str(raw_ctx.get(k) or "")[:600] for k in ("marca", "destino")}
        if not negativos_ia.split_lines(ctx["marca"]):
            self._send_json(400, {"error": "Escribe el nombre del hotel o la marca: se usa para que ninguna palabra sugerida la incluya."})
            return
        existing = negativos_ia.ExistingNegatives()
        positives = None
        customer_id = str(payload.get("customer_id") or "").strip()
        if google_ads_client.is_configured() and customer_id.isdigit() and self._user_can_access_account(user, customer_id):
            try:
                existing = negativos_ia.ExistingNegatives.from_sources(google_ads_client.fetch_negative_keyword_sources(customer_id))
            except Exception as e:  # noqa: BLE001
                print(f"[neg-palabras] no se pudieron leer las negativas existentes: {' '.join(str(e).split())[:200]}", flush=True)
            try:
                positives = negativos_ia.PositiveKeywords.from_rows(google_ads_client.fetch_positive_keywords(customer_id))
            except Exception as e:  # noqa: BLE001
                print(f"[neg-palabras] no se pudieron leer las palabras clave positivas: {' '.join(str(e).split())[:200]}", flush=True)
        try:
            kept, dropped_rows = negativos_ia.drop_blocked(rows, existing)
            terms = negativos_ia.aggregate_terms(kept)
        except (TypeError, ValueError):
            self._send_json(400, {"error": "Los términos traen valores inválidos (clics, costo o conversiones)."})
            return
        if not terms:
            self._send_json(400, {"error": "No hay términos de búsqueda reales para analizar."})
            return
        result = negativos_ia.ngram_report(terms, ctx, existing, positives)
        result["negativas_existentes"] = existing.total()
        result["negativas_fuentes"] = {**existing.counts, "errores": 0}
        result["ya_bloqueados"] = negativos_ia.summarize_dropped(dropped_rows)
        self._send_json(200, result)

    def _handle_ai_analizar_negativos(self, payload):
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            self._send_json(400, {"error": "Primero trae los términos de búsqueda: no hay nada que analizar."})
            return
        if len(rows) > negativos_ia.MAX_ROWS_ACCEPTED:
            self._send_json(400, {"error": f"Demasiados términos ({len(rows)}). Acorta el rango de fechas o elige una campaña."})
            return
        raw_ctx = payload.get("contexto") if isinstance(payload.get("contexto"), dict) else {}
        ctx = {k: str(raw_ctx.get(k) or "")[:600] for k in ("marca", "destino", "ofrece", "no_ofrece")}
        if not negativos_ia.split_lines(ctx["marca"]):
            self._send_json(400, {"error": "Escribe el nombre del hotel o la marca: se usa para que la IA nunca niegue búsquedas de tu propia marca."})
            return
        # Las negativas que la cuenta ya tiene (solo con Google Ads real y acceso a la cuenta): la IA no las repite,
        # el resultado omite las que ya existen en cada campaña y los términos que ya bloquean se sacan de la lista.
        existing = negativos_ia.ExistingNegatives()
        positives = None
        neg_errors = []
        customer_id = str(payload.get("customer_id") or "").strip()
        if google_ads_client.is_configured() and customer_id.isdigit() and self._user_can_access_account(user, customer_id):
            try:
                sources = google_ads_client.fetch_negative_keyword_sources(customer_id)
                existing = negativos_ia.ExistingNegatives.from_sources(sources)
                neg_errors = sources.get("errores", [])
            except Exception as e:  # noqa: BLE001 — sin esto el análisis igual sirve
                print(f"[neg-ia] no se pudieron leer las negativas existentes: {' '.join(str(e).split())[:200]}", flush=True)
                neg_errors = ["no se pudieron leer las negativas existentes"]
            for msg in neg_errors:
                print(f"[neg-ia] {msg}", flush=True)
            # Palabras clave positivas activas: para avisar si una negativa bloquearía alguna de las tuyas.
            try:
                positives = negativos_ia.PositiveKeywords.from_rows(google_ads_client.fetch_positive_keywords(customer_id))
            except Exception as e:  # noqa: BLE001 — sin esto el análisis igual sirve, pero sin esta comprobación
                print(f"[neg-ia] no se pudieron leer las palabras clave positivas: {' '.join(str(e).split())[:200]}", flush=True)
                positives = None
        try:
            rows, dropped_rows = negativos_ia.drop_blocked(rows, existing)
            terms = negativos_ia.aggregate_terms(rows)
        except (TypeError, ValueError):
            self._send_json(400, {"error": "Los términos traen valores inválidos (clics, costo o conversiones)."})
            return
        if not terms:
            if dropped_rows:
                self._send_json(400, {"error": "Todos los términos de este periodo ya están bloqueados por negativas que la cuenta tiene: no hay nada nuevo que analizar."})
            else:
                self._send_json(400, {"error": "No hay términos de búsqueda reales para analizar (las categorías de Performance Max no se analizan)."})
            return
        if not _ai_limiter.allow(f"user:{user['id']}", *AI_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de análisis con IA por esta hora. Intenta más tarde."})
            return
        try:
            chosen = negativos_ia.select_for_ai(terms)
            user_content = negativos_ia.build_user_content(ctx, chosen, existing.texts())
            with track_ai_usage(user["id"], "negativizacion"):
                ai = claude_client.analizar_negativos(user_content)
            result = negativos_ia.build_result(ai, terms, chosen, ctx, existing, positives)
            result["negativas_existentes"] = existing.total()
            result["negativas_fuentes"] = {**existing.counts, "errores": len(neg_errors)}
            result["ya_bloqueados"] = negativos_ia.summarize_dropped(dropped_rows)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            print(f"[claude-error] neg-ia: {' '.join(str(e).split())[:300]}", flush=True)
            self._send_json(502, {"error": "No se pudo generar el análisis con IA. Intenta de nuevo en unos minutos."})

    def _handle_ai_analizar_hotel(self, payload):
        """Diagnóstico y propuesta de modificadores de una campaña de hotel. Solo lee y propone: aplicar pasa
        por el editor de tramos (vista previa de Google y confirmar)."""
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        date_from, date_to = str(payload.get("date_from") or "").strip(), str(payload.get("date_to") or "").strip()
        pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        if not pattern.match(date_from) or not pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return
        moneda = str(payload.get("moneda") or "")[:8]
        simulated = not google_ads_client.is_configured()
        try:
            if simulated:
                modifiers = google_ads_client.simulated_hotel_campaign_modifiers(campaign_id, date_from, date_to)
                price = google_ads_client.simulated_hotel_price(campaign_id, date_from, date_to)
            else:
                if not self._hotel_account_access(customer_id):
                    return
                modifiers = google_ads_client.fetch_hotel_campaign_modifiers(customer_id, campaign_id, date_from, date_to)
                try:
                    price = google_ads_client.fetch_hotel_price(customer_id, campaign_id, date_from, date_to)
                except Exception as e:  # noqa: BLE001 — sin el precio el análisis igual sirve
                    print(f"[hotel-ia] no se pudo leer el precio: {' '.join(str(e).split())[:200]}", flush=True)
                    price = None
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)
            return
        if not _ai_limiter.allow(f"user:{user['id']}", *AI_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de análisis con IA por esta hora. Intenta más tarde."})
            return
        try:
            user_content, by_id = hoteles_ia.build_input(modifiers, price, moneda, date_from, date_to)
            if not by_id:
                self._send_json(400, {"error": "Esta campaña no tiene modificadores editables que analizar."})
                return
            with track_ai_usage(user["id"], "hoteles"):
                ai = claude_client.analizar_hotel(user_content)
            locked = bool(modifiers.get("template_locked"))
            result = hoteles_ia.build_result(ai, modifiers, price, by_id, locked)
            result["campaign_id"] = campaign_id
            result["simulated"] = simulated
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            print(f"[claude-error] hotel-ia: {' '.join(str(e).split())[:300]}", flush=True)
            self._send_json(502, {"error": "No se pudo generar el análisis con IA. Intenta de nuevo en unos minutos."})

    def _handle_ai_nota_hotel(self, payload):
        """Borrador de nota para el revenue manager del hotel cuando el precio sale caro. Solo lee y redacta."""
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        date_from, date_to = str(payload.get("date_from") or "").strip(), str(payload.get("date_to") or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_from) or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return
        simulated = not google_ads_client.is_configured()
        try:
            if simulated:
                price = google_ads_client.simulated_hotel_price(campaign_id, date_from, date_to)
            else:
                if not self._hotel_account_access(customer_id):
                    return
                price = google_ads_client.fetch_hotel_price(customer_id, campaign_id, date_from, date_to)
            user_content, allowed = hoteles_ia.build_note_input(price, payload.get("campaign_name"), date_from, date_to)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)
            return
        if not _ai_limiter.allow(f"user:{user['id']}", *AI_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de análisis con IA por esta hora. Intenta más tarde."})
            return
        try:
            with track_ai_usage(user["id"], "hoteles"):
                ai = claude_client.redactar_nota_hotel(user_content)
            result = hoteles_ia.build_note_result(ai, allowed)
            result["campaign_id"] = campaign_id
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            print(f"[claude-error] hotel-nota: {' '.join(str(e).split())[:300]}", flush=True)
            self._send_json(502, {"error": "No se pudo redactar la nota con IA. Intenta de nuevo en unos minutos."})

    def _handle_ai_generar_copys(self, payload):
        user = self._get_current_user()
        if not claude_client.is_configured():
            self._send_json(503, {"error": "La integración con Claude no está configurada en el servidor (falta ANTHROPIC_API_KEY)."})
            return
        formato = payload.get("formato")
        if formato not in claude_client.COPY_FORMATS:
            self._send_json(400, {"error": "Elige un formato: Search, Performance Max, Demand Gen, YouTube o Meta."})
            return
        signals = payload.get("signals")
        if not isinstance(signals, dict) or not (signals.get("title") or signals.get("h1") or signals.get("meta_description")):
            self._send_json(400, {"error": "Primero analiza una página: faltan los datos de la página (título, encabezado o descripción)."})
            return
        if not _copy_limiter.allow(f"user:{user['id']}", *COPY_RATE_LIMIT):
            self._send_json(429, {"error": "Alcanzaste el límite de generaciones con IA por esta hora. Intenta más tarde."})
            return
        idioma = payload.get("idioma") if payload.get("idioma") in claude_client.COPY_LANGUAGES else "es"
        keywords = str(payload.get("keywords") or "")[:300]
        # Recorta lo que se manda a Claude: listas largas del sitio no aportan y cuestan tokens.
        trimmed = {
            "title": str(signals.get("title") or "")[:200], "meta_description": str(signals.get("meta_description") or "")[:400],
            "h1": str(signals.get("h1") or "")[:200], "brand": str(signals.get("brand") or "")[:100],
            "keyword": str(signals.get("keyword") or "")[:150], "domain": str(signals.get("domain") or "")[:100],
        }
        for key, n, width in (("h2s", 10, 150), ("li_texts", 30, 120), ("cta_texts", 15, 60), ("offers", 10, 80)):
            raw = signals.get(key)
            trimmed[key] = [str(x)[:width] for x in raw[:n]] if isinstance(raw, list) else []
        try:
            with track_ai_usage(user["id"], "copys"):
                result = claude_client.generar_copys(formato, trimmed, idioma, keywords)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001
            print(f"[claude-error] copys: {e}", flush=True)
            self._send_json(502, {"error": "No se pudo generar el copy con IA. Intenta de nuevo en unos minutos."})

    # Escritura real sobre la cuenta del cliente — a diferencia de todos los
    # demás endpoints de /api/google-ads/, este modifica Google Ads. Por
    # default (validate_only ausente o true) SIEMPRE valida sin aplicar; el
    # llamador tiene que pedir explícitamente validate_only=false para que
    # el cambio quede escrito de verdad.
    def _handle_google_ads_negative_keywords(self, payload):
        user = self._get_current_user()
        if not user:  # la sesión se venció justo entre el chequeo de auth y acá — caso raro
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
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
            if item.get("match_type", "EXACT") not in ("EXACT", "PHRASE"):
                self._send_json(400, {"error": "match_type debe ser EXACT o PHRASE."})
                return

        if not google_ads_client.is_configured():
            result = google_ads_client.simulated_push_negative_keywords(items, validate_only)
            self._record_neg_upload(user, customer_id, payload, result)
            self._send_json(200, result)
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.push_negative_keywords(customer_id, items, validate_only)
            self._record_neg_upload(user, customer_id, payload, result)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # Guarda en el historial lo que acaba de subir (solo subidas reales). Un fallo al guardar no debe tumbar la
    # respuesta: las negativas ya están en Google Ads. Siempre se retira created_items de lo que se manda al navegador.
    def _record_neg_upload(self, user, customer_id, payload, result):
        created_items = result.pop("created_items", None)
        if result.get("validate_only") or not created_items:
            return
        origen = payload.get("origen") if payload.get("origen") in ("ia", "reglas") else "reglas"
        try:
            store_neg_upload(user["id"], customer_id or "simulada", origen, created_items)
        except Exception as e:  # noqa: BLE001
            print(f"[neg-historial] no se pudo guardar la subida: {' '.join(str(e).split())[:200]}", flush=True)

    # Escritura real sobre la cuenta del cliente — ajusta el ROAS objetivo de
    # una campaña. Igual que negative-keywords, por default (validate_only
    # ausente o true) SIEMPRE valida sin aplicar.
    def _handle_google_ads_roas_adjust(self, payload):
        user = self._get_current_user()
        if not user:  # la sesión se venció justo entre el chequeo de auth y acá — caso raro
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
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
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.update_campaign_target_roas(customer_id, campaign_id, bidding_strategy_type, target_roas, validate_only)
            self._send_json(200, result)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # ------------------------------------------------ Historial de negativas ---
    def _handle_negative_uploads(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip() or "simulada"
        if google_ads_client.is_configured():
            if not customer_id.isdigit():
                self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
                return
            user = self._get_current_user()
            if not self._user_can_access_account(user, customer_id):
                self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
                return
        conn = get_db()
        try:
            ups = conn.execute(
                """
                SELECT u.id, u.created_at, u.origen, u.created, u.undone_at, COALESCE(us.username, '(usuario borrado)') AS username
                FROM neg_uploads u LEFT JOIN users us ON us.id = u.user_id
                WHERE u.customer_id = ? ORDER BY u.created_at DESC LIMIT 40
                """,
                (customer_id,),
            ).fetchall()
            out = []
            for u in ups:
                items = conn.execute(
                    "SELECT campaign_name, campaign_id, text, match_type, removed_at FROM neg_upload_items WHERE upload_id = ? ORDER BY id LIMIT 300",
                    (u["id"],),
                ).fetchall()
                out.append({
                    "id": u["id"], "created_at": u["created_at"], "username": u["username"], "origen": u["origen"],
                    "created": u["created"], "undone_at": u["undone_at"],
                    "activas": sum(1 for i in items if i["removed_at"] is None),
                    "items": [{"campaign_name": i["campaign_name"], "campaign_id": i["campaign_id"], "text": i["text"],
                               "match_type": i["match_type"], "removed": i["removed_at"] is not None} for i in items],
                })
        finally:
            conn.close()
        self._send_json(200, {"uploads": out, "simulated": not google_ads_client.is_configured()})

    def _handle_negative_uploads_undo(self, payload):
        user = self._get_current_user()
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip() or "simulada"
        validate_only = payload.get("validate_only", True) is not False
        try:
            upload_id = int(payload.get("upload_id"))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "Falta el upload_id."})
            return
        configured = google_ads_client.is_configured()
        if configured:
            if not customer_id.isdigit():
                self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
                return
            if not self._user_can_access_account(user, customer_id):
                self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
                return
        conn = get_db()
        try:
            up = conn.execute("SELECT id FROM neg_uploads WHERE id = ? AND customer_id = ?", (upload_id, customer_id)).fetchone()
            if not up:
                self._send_json(404, {"error": "No se encontró esa subida en esta cuenta."})
                return
            items = conn.execute(
                "SELECT id, resource_name FROM neg_upload_items WHERE upload_id = ? AND removed_at IS NULL", (upload_id,)
            ).fetchall()
        finally:
            conn.close()
        if not items:
            self._send_json(400, {"error": "Esa subida ya no tiene negativas activas que deshacer."})
            return
        try:
            if configured:
                result = google_ads_client.remove_campaign_negative_keywords(customer_id, [i["resource_name"] for i in items], validate_only)
            else:
                result = {"removed": len(items), "removed_names": [i["resource_name"] for i in items], "failed": [], "validate_only": validate_only, "simulated": True}
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)
            return
        if not validate_only and result["removed_names"]:
            gone = set(result["removed_names"])
            conn = get_db()
            try:
                conn.executemany("UPDATE neg_upload_items SET removed_at = ? WHERE id = ?", [(time.time(), i["id"]) for i in items if i["resource_name"] in gone])
                left = conn.execute("SELECT COUNT(*) FROM neg_upload_items WHERE upload_id = ? AND removed_at IS NULL", (upload_id,)).fetchone()[0]
                if left == 0:
                    conn.execute("UPDATE neg_uploads SET undone_at = ?, undone_by = ? WHERE id = ?", (time.time(), user["id"], upload_id))
                conn.commit()
            finally:
                conn.close()
            print(f"[neg-historial] user={user['id']} customer={customer_id} upload={upload_id} removed={result['removed']} failed={len(result['failed'])}", flush=True)
        result.pop("removed_names", None)
        self._send_json(200, result)

    # ------------------------------------------------------- Hoteles ---
    # Modificadores de oferta de campañas de hotel (AdGroupBidModifier). La
    # lectura devuelve el perfil actual por campaña con el rendimiento de cada
    # tramo; la escritura sigue el mismo patrón que ROAS/IA Max (vista previa
    # validada por Google y luego confirmar) y se rechaza en las cuentas con
    # plantilla externa de modificadores.
    def _hotel_dates(self, query):
        date_from = (query.get("date_from") or [""])[0].strip()
        date_to = (query.get("date_to") or [""])[0].strip()
        pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        if not pattern.match(date_from) or not pattern.match(date_to):
            self._send_json(400, {"error": "date_from y date_to deben tener formato AAAA-MM-DD."})
            return None
        return date_from, date_to

    def _hotel_account_access(self, customer_id):
        """Devuelve el usuario si puede tocar la cuenta; si no, responde el error y devuelve None."""
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return None
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return None
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return None
        return user

    def _handle_google_ads_hotel_campaigns(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        dates = self._hotel_dates(query)
        if not dates:
            return
        if not google_ads_client.is_configured():
            self._send_json(200, {**google_ads_client.simulated_hotel_campaigns(*dates), "simulated": True})
            return
        if not self._hotel_account_access(customer_id):
            return
        try:
            self._send_json(200, {**google_ads_client.fetch_hotel_campaigns(customer_id, *dates), "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_hotel_modifiers(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        dates = self._hotel_dates(query)
        if not dates:
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro campaign_id."})
            return
        if not google_ads_client.is_configured():
            try:
                self._send_json(200, {**google_ads_client.simulated_hotel_campaign_modifiers(campaign_id, *dates), "simulated": True})
            except ValueError as e:
                self._send_json(404, {"error": str(e)})
            return
        if not self._hotel_account_access(customer_id):
            return
        try:
            self._send_json(200, {**google_ads_client.fetch_hotel_campaign_modifiers(customer_id, campaign_id, *dates), "simulated": False})
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    def _handle_google_ads_hotel_price(self, query):
        """Precio de una campaña de hotel frente a la competencia (solo lectura)."""
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        dates = self._hotel_dates(query)
        if not dates:
            return
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro campaign_id."})
            return
        if not google_ads_client.is_configured():
            try:
                self._send_json(200, {**google_ads_client.simulated_hotel_price(campaign_id, *dates), "simulated": True})
            except ValueError as e:
                self._send_json(404, {"error": str(e)})
            return
        if not self._hotel_account_access(customer_id):
            return
        try:
            self._send_json(200, {**google_ads_client.fetch_hotel_price(customer_id, campaign_id, *dates), "simulated": False})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    def _handle_google_ads_hotel_modifiers_apply(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        changes = payload.get("changes")
        validate_only = payload.get("validate_only", True) is not False
        if not campaign_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido campaign_id."})
            return

        if not google_ads_client.is_configured():
            try:
                self._send_json(200, google_ads_client.simulated_update_hotel_campaign_modifiers(campaign_id, changes, validate_only))
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            result = google_ads_client.update_hotel_campaign_modifiers(customer_id, campaign_id, changes, validate_only)
            if not validate_only:
                print(
                    f"[hotel-modifiers] user={user['id']} customer={customer_id} campaign={campaign_id} "
                    f"updated={result['updated']} created={result['created']} failed={result['failed_count']}",
                    flush=True,
                )
            self._send_json(200, result)
        except PermissionError as e:
            self._send_json(403, {"error": str(e), "template_locked": True})
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_google_ads_error(e)

    # ------------------------------------------------------- IA Max ---
    # Estado de AI Max por campaña Search. Sin rango de fechas — es
    # configuración de campaña, no una métrica de un periodo.
    def _handle_google_ads_ai_max(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        only_active = (query.get("only_active") or [""])[0].strip() == "1"

        if not google_ads_client.is_configured():
            self._send_json(200, {"rows": google_ads_client.simulated_ai_max_status(only_active), "simulated": True})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_ai_max_status(customer_id, only_active)
            self._send_json(200, {"rows": rows, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_ai_max_toggle(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        campaign_id = str(payload.get("campaign_id") or "").strip()
        enable = bool(payload.get("enable"))
        validate_only = payload.get("validate_only", True) is not False

        if not campaign_id:
            self._send_json(400, {"error": "Falta campaign_id."})
            return

        if not google_ads_client.is_configured():
            result = google_ads_client.simulated_update_campaign_ai_max(campaign_id, enable, validate_only)
            self._send_json(200, result)
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.update_campaign_ai_max(customer_id, campaign_id, enable, validate_only)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # Trae, en una sola llamada, lo que AI Max sirvió de verdad (término +
    # landing page + titular) y los negativos reales ya escritos en la
    # cuenta — el cruce entre ambos se hace en el cliente
    # (engine.crossReferenceAiMaxServed), mismo criterio de "traer una vez,
    # cruzar/filtrar en el cliente" que ya usa el resto de la plataforma.
    def _handle_google_ads_ai_max_served(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()

        if not google_ads_client.is_configured():
            self._send_json(200, {
                "rows": google_ads_client.simulated_ai_max_served(campaign_id or None),
                "negatives": google_ads_client.simulated_account_negative_keywords(),
                "simulated": True, "currency": "USD",
            })
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            rows = google_ads_client.fetch_ai_max_served_combinations(customer_id, campaign_id or None)
            negatives = google_ads_client.fetch_account_negative_keywords(customer_id)
            self._send_json(200, {"rows": rows, "negatives": negatives, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_ai_max_created(self, query):
        """Lo que creó IA Max: recursos automáticos, combinaciones término + página + titular, y páginas a las
        que mandó el tráfico. Solo lectura; cada reporte falla por separado para que uno caído no tumbe los otros."""
        customer_id = (query.get("customer_id") or [""])[0].strip()
        campaign_id = (query.get("campaign_id") or [""])[0].strip()
        try:
            days = int((query.get("days") or ["30"])[0])
        except ValueError:
            days = 30
        if days not in (7, 14, 30):
            days = 30

        if not google_ads_client.is_configured():
            data = google_ads_client.simulated_ai_max_created(campaign_id or None)
            data.update({"simulated": True, "days": days, "errors": {}, "currency": "USD"})
            self._send_json(200, data)
            return

        if not customer_id.isdigit() or (campaign_id and not campaign_id.isdigit()):
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        out = {"assets": [], "combinations": [], "combinations_total": 0, "pages": [], "pages_total": 0,
               "simulated": False, "days": days, "errors": {}, "currency": google_ads_client.fetch_customer_currency(customer_id)}
        failures = []
        try:
            out["assets"] = google_ads_client.fetch_ai_max_created_assets(customer_id, campaign_id or None, days)
        except Exception as e:  # noqa: BLE001
            failures.append(("assets", e))
        try:
            out["combinations"], out["combinations_total"] = google_ads_client.fetch_ai_max_combinations(customer_id, campaign_id or None, days)
        except Exception as e:  # noqa: BLE001
            failures.append(("combinations", e))
        try:
            out["pages"], out["pages_total"] = google_ads_client.fetch_ai_max_landing_pages(customer_id, campaign_id or None, days)
        except Exception as e:  # noqa: BLE001
            failures.append(("pages", e))
        if len(failures) == 3:
            # Si fallaron los tres, es un problema general de la API: se responde igual que el resto de reportes.
            self._send_google_ads_error(failures[0][1])
            return
        for name, exc in failures:
            out["errors"][name] = str(exc)[:300]
        self._send_json(200, out)

    @staticmethod
    def _ai_max_campaign_eligibility(status_rows):
        """Qué campañas aceptan exclusiones de página: necesitan AI Max, textos automáticos y expansión de URL prendidos."""
        out = []
        for r in status_rows:
            if not r.get("enabled"):
                reason = "AI Max está apagado"
            elif r.get("text_customization") != "OPTED_IN":
                reason = "los textos automáticos están apagados"
            elif r.get("final_url_expansion") != "OPTED_IN":
                reason = "la expansión de URL está apagada"
            else:
                reason = None
            out.append({"campaign_id": r["campaign_id"], "campaign_name": r["campaign_name"], "eligible": reason is None, "reason": reason})
        return out

    def _handle_google_ads_ai_max_url_exclusions(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        if not google_ads_client.is_configured():
            self._send_json(200, {
                "rows": google_ads_client.simulated_ai_max_url_exclusions(),
                "campaigns": self._ai_max_campaign_eligibility(google_ads_client.simulated_ai_max_status(True)),
                "simulated": True,
            })
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            rows = google_ads_client.fetch_ai_max_url_exclusions(customer_id)
            campaigns = self._ai_max_campaign_eligibility(google_ads_client.fetch_ai_max_status(customer_id, only_active=True))
            self._send_json(200, {"rows": rows, "campaigns": campaigns, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_ai_max_url_exclusions_apply(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        validate_only = payload.get("validate_only", True) is not False
        raw_items = payload.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            self._send_json(400, {"error": "No hay páginas para excluir."})
            return
        if len(raw_items) > 100:
            self._send_json(400, {"error": "Máximo 100 páginas por envío."})
            return

        items, invalid = [], []
        for i, it in enumerate(raw_items):
            campaign_id = str((it or {}).get("campaign_id") or "").strip()
            try:
                if not campaign_id.isdigit():
                    raise ValueError("Falta la campaña.")
                mode, value = google_ads_client.normalize_url_exclusion((it or {}).get("mode"), (it or {}).get("value"))
                items.append({"campaign_id": campaign_id, "campaign_name": str((it or {}).get("campaign_name") or ""), "mode": mode, "value": value})
            except ValueError as e:
                invalid.append({"index": i, "value": str((it or {}).get("value") or "")[:120], "error": str(e)})
        if invalid:
            self._send_json(400, {"error": f"{len(invalid)} página(s) no son válidas; corrígelas o quítalas de la lista.", "invalid": invalid})
            return

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_push_ai_max_url_exclusions(items, validate_only))
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            eligibility = {c["campaign_id"]: c for c in self._ai_max_campaign_eligibility(google_ads_client.fetch_ai_max_status(customer_id, only_active=True))}
            blocked = sorted({f"{eligibility[it['campaign_id']]['campaign_name']} ({eligibility[it['campaign_id']]['reason']})" if it["campaign_id"] in eligibility and not eligibility[it["campaign_id"]]["eligible"] else f"campaña {it['campaign_id']} (no es una campaña Search activa)" for it in items if it["campaign_id"] not in eligibility or not eligibility[it["campaign_id"]]["eligible"]})
            if blocked:
                self._send_json(400, {"error": "Estas campañas no aceptan exclusiones de página: " + "; ".join(blocked) + ". Las exclusiones solo funcionan con AI Max, textos automáticos y expansión de URL prendidos."})
                return
            existing = {(r["campaign_id"], r["mode"], r["value"]) for r in google_ads_client.fetch_ai_max_url_exclusions(customer_id)}
            fresh, skipped, seen = [], [], set()
            for it in items:
                key = (it["campaign_id"], it["mode"], it["value"])
                if key in existing or key in seen:
                    skipped.append(it["value"])
                else:
                    seen.add(key)
                    fresh.append(it)
            result = google_ads_client.push_ai_max_url_exclusions(customer_id, fresh, validate_only)
            result["skipped_duplicates"] = skipped
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_ai_max_url_exclusions_remove(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        validate_only = payload.get("validate_only", False) is not False
        resource_names = payload.get("resource_names")
        if not isinstance(resource_names, list) or not resource_names or len(resource_names) > 100:
            self._send_json(400, {"error": "Indica entre 1 y 100 exclusiones para quitar."})
            return
        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_remove_ai_max_url_exclusions(resource_names, validate_only))
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            self._send_json(200, google_ads_client.remove_ai_max_url_exclusions(customer_id, resource_names, validate_only))
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_content_exclusions(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()

        if not google_ads_client.is_configured():
            exclusions = google_ads_client.simulated_content_exclusions()
            self._send_json(200, {
                "content_labels": exclusions["content_labels"],
                "app_categories": exclusions["app_categories"],
                "app_categories_catalog": google_ads_client.simulated_mobile_app_categories(),
                "simulated": True,
            })
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return

        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            exclusions = google_ads_client.fetch_content_exclusions(customer_id)
            catalog = google_ads_client.fetch_mobile_app_categories(customer_id)
            catalog_by_resource = {c["resource_name"]: c["name"] for c in catalog}
            app_categories = [
                {**a, "name": catalog_by_resource.get(a["category_constant"], a["category_constant"])}
                for a in exclusions["app_categories"]
            ]
            self._send_json(200, {
                "content_labels": exclusions["content_labels"],
                "app_categories": app_categories,
                "app_categories_catalog": catalog,
                "simulated": False,
            })
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_content_exclusions_add_labels(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return

        customer_id = str(payload.get("customer_id") or "").strip()
        content_label_types = payload.get("content_label_types") or []
        validate_only = bool(payload.get("validate_only", True))

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_add_content_label_exclusions(content_label_types, validate_only))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.add_content_label_exclusions(customer_id, content_label_types, validate_only)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_content_exclusions_add_app_category(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return

        customer_id = str(payload.get("customer_id") or "").strip()
        category_resource_names = payload.get("category_resource_names") or []
        validate_only = bool(payload.get("validate_only", True))

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_add_app_category_exclusions(category_resource_names, validate_only))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not category_resource_names:
            self._send_json(400, {"error": "Falta el parámetro category_resource_names."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.add_app_category_exclusions(customer_id, category_resource_names, validate_only)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_google_ads_content_exclusions_remove(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not _write_limiter.allow(f"user:{user['id']}", *WRITE_RATE_LIMIT):
            self._send_json(429, {"error": "Demasiadas escrituras seguidas. Espera un minuto y vuelve a intentar."})
            return

        customer_id = str(payload.get("customer_id") or "").strip()
        resource_name = str(payload.get("resource_name") or "").strip()
        validate_only = bool(payload.get("validate_only", True))

        if not google_ads_client.is_configured():
            self._send_json(200, google_ads_client.simulated_remove_customer_negative_criterion(resource_name, validate_only))
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not resource_name:
            self._send_json(400, {"error": "Falta el parámetro resource_name."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.remove_customer_negative_criterion(customer_id, resource_name, validate_only)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    # ---------------------------------------- Planificador de palabras clave ---
    # Todos de solo lectura — ninguno escribe en la cuenta, así que no llevan
    # validate_only ni _write_limiter (a diferencia de ROAS/Negativización/
    # IA Max/Exclusiones de contenido, que sí mutan algo real).
    def _handle_keyword_planner_geo_search(self, query):
        q = (query.get("q") or [""])[0].strip()
        if not google_ads_client.is_configured():
            self._send_json(200, {"results": google_ads_client.simulated_geo_target_suggestions(q), "simulated": True})
            return
        if not q:
            self._send_json(200, {"results": [], "simulated": False})
            return
        try:
            results = google_ads_client.fetch_geo_target_suggestions(q)
            self._send_json(200, {"results": results, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_keyword_planner_languages(self, query):
        customer_id = (query.get("customer_id") or [""])[0].strip()
        if not google_ads_client.is_configured():
            self._send_json(200, {"languages": google_ads_client.simulated_targetable_languages(), "simulated": True})
            return
        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return
        try:
            languages = google_ads_client.fetch_targetable_languages(customer_id)
            self._send_json(200, {"languages": languages, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_keyword_planner_ideas(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        seed_keywords = [str(k).strip() for k in (payload.get("seed_keywords") or []) if str(k).strip()]
        seed_url = str(payload.get("seed_url") or "").strip() or None
        geo_resource_names = payload.get("geo_resource_names") or []
        language_resource_name = str(payload.get("language_resource_name") or "").strip() or None
        network = str(payload.get("network") or "GOOGLE_SEARCH_AND_PARTNERS")
        include_adult = bool(payload.get("include_adult", False))

        if not google_ads_client.is_configured():
            self._send_json(200, {**google_ads_client.simulated_keyword_ideas(seed_keywords, seed_url), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not seed_keywords and not seed_url:
            self._send_json(400, {"error": "Escribe al menos una keyword semilla o una URL."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.fetch_keyword_ideas(
                customer_id, seed_keywords=seed_keywords or None, seed_url=seed_url,
                geo_resource_names=geo_resource_names or None, language_resource_name=language_resource_name,
                network=network, include_adult=include_adult,
            )
            self._send_json(200, {**result, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_keyword_planner_historical(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        keywords = [str(k).strip() for k in (payload.get("keywords") or []) if str(k).strip()]
        geo_resource_names = payload.get("geo_resource_names") or []
        language_resource_name = str(payload.get("language_resource_name") or "").strip() or None
        network = str(payload.get("network") or "GOOGLE_SEARCH_AND_PARTNERS")
        include_adult = bool(payload.get("include_adult", False))

        if not google_ads_client.is_configured():
            self._send_json(200, {**google_ads_client.simulated_keyword_historical_metrics(keywords), "simulated": True, "currency": "USD"})
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not keywords:
            self._send_json(400, {"error": "Escribe al menos una keyword."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.fetch_keyword_historical_metrics(
                customer_id, keywords, geo_resource_names=geo_resource_names or None,
                language_resource_name=language_resource_name, network=network, include_adult=include_adult,
            )
            self._send_json(200, {**result, "simulated": False, "currency": google_ads_client.fetch_customer_currency(customer_id)})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            self._send_google_ads_error(e)

    def _handle_keyword_planner_forecast(self, payload):
        user = self._get_current_user()
        if not user:
            self._send_json(401, {"error": "No autenticado."})
            return
        customer_id = str(payload.get("customer_id") or "").strip()
        keywords = [str(k).strip() for k in (payload.get("keywords") or []) if str(k).strip()]
        match_type = str(payload.get("match_type") or "BROAD")
        geo_resource_names = payload.get("geo_resource_names") or []
        language_resource_names = payload.get("language_resource_names") or []
        bidding_mode = str(payload.get("bidding_mode") or "")
        start_date = str(payload.get("start_date") or "")
        end_date = str(payload.get("end_date") or "")
        daily_budget = payload.get("daily_budget")
        max_cpc_bid = payload.get("max_cpc_bid")
        daily_target_spend = payload.get("daily_target_spend")
        max_cpc_bid_ceiling = payload.get("max_cpc_bid_ceiling")
        # Google Ads exige el código en mayúsculas (ISO 4217, ej. "COP") — en
        # minúsculas Google lo rechaza con un 400 INVALID_ARGUMENT genérico
        # ("The input has an invalid value.", sin decir qué campo), confirmado
        # contra una cuenta real. Normalizamos acá para no depender de que el
        # usuario lo escriba bien.
        currency_code = str(payload.get("currency_code") or "").strip().upper() or None

        if not google_ads_client.is_configured():
            self._send_json(200, {
                **google_ads_client.simulated_keyword_forecast(
                    keywords, bidding_mode, start_date, end_date,
                    daily_budget=daily_budget, max_cpc_bid=max_cpc_bid,
                    daily_target_spend=daily_target_spend, max_cpc_bid_ceiling=max_cpc_bid_ceiling,
                ),
                "simulated": True,
            })
            return

        if not customer_id.isdigit():
            self._send_json(400, {"error": "Falta o es inválido el parámetro customer_id."})
            return
        if not keywords:
            self._send_json(400, {"error": "Escribe al menos una keyword."})
            return
        if not start_date or not end_date:
            self._send_json(400, {"error": "Falta el rango de fechas del pronóstico."})
            return
        if bidding_mode not in ("MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"):
            self._send_json(400, {"error": "Estrategia de puja inválida."})
            return
        if not self._user_can_access_account(user, customer_id):
            self._send_json(403, {"error": "No tienes acceso a esta cuenta de Google Ads."})
            return

        try:
            result = google_ads_client.fetch_keyword_forecast(
                customer_id, keywords, match_type, geo_resource_names or [], language_resource_names or [],
                bidding_mode, start_date, end_date,
                daily_budget=daily_budget, max_cpc_bid=max_cpc_bid,
                daily_target_spend=daily_target_spend, max_cpc_bid_ceiling=max_cpc_bid_ceiling,
                currency_code=currency_code,
            )
            self._send_json(200, {**result, "simulated": False})
        except Exception as e:  # noqa: BLE001 — nunca tumbar el server por un error de la API externa
            # El error de Google (ver _send_google_ads_error) casi nunca dice
            # qué campo es inválido — loguear los parámetros de la solicitud
            # es la única forma de diagnosticarlo sin tener que reproducirlo
            # a ciegas.
            print(
                f"[keyword-planner-forecast-params] customer_id={customer_id} keywords={keywords} "
                f"match_type={match_type} geo={geo_resource_names} lang={language_resource_names} "
                f"bidding_mode={bidding_mode} start={start_date} end={end_date} "
                f"daily_budget={daily_budget!r} max_cpc_bid={max_cpc_bid!r} "
                f"daily_target_spend={daily_target_spend!r} max_cpc_bid_ceiling={max_cpc_bid_ceiling!r} "
                f"currency_code={currency_code!r}",
                flush=True,
            )
            self._send_google_ads_error(e)

    # ------------------------------------------------- Generador de copys ---
    def _handle_fetch(self, query):
        url = (query.get("url") or [""])[0].strip()
        if not url:
            self._send_json(400, {"error": "Falta el parámetro url."})
            return
        if not url.lower().startswith(("http://", "https://")):
            self._send_json(400, {"error": "La URL debe empezar con http:// o https://."})
            return

        if not _url_is_public(url):
            self._send_json(400, {"error": "Esa dirección no está permitida: solo se pueden analizar páginas públicas de internet."})
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
            with _PUBLIC_ONLY_OPENER.open(req, timeout=TIMEOUT_SECONDS) as resp:
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

    # El error crudo que devuelve google_ads_client.py (RuntimeError con el
    # cuerpo completo de la respuesta de Google) puede traer texto de la
    # consulta GAQL, nombres de recursos internos, IDs de campaña, etc. —
    # nunca se le manda tal cual al navegador. Se imprime completo acá (queda
    # en los logs del servidor — `railway logs` en producción, la consola en
    # local) y al cliente se le manda un mensaje genérico, categorizado por
    # el código de estado HTTP de Google cuando se puede identificar en el
    # texto de la excepción (ver el formato "Google Ads API respondió {code}:
    # ..." en google_ads_client.py).
    def _send_google_ads_error(self, exc):
        detail = str(exc)
        # Railway (y otros recolectores de logs) parten un solo print() con
        # saltos de línea en una entrada POR LÍNEA, y no garantizan que lleguen
        # en orden cuando hay requests concurrentes — un JSON multilínea queda
        # imposible de leer (o reconstruir) en `railway logs`. Una sola línea
        # evita el problema de raíz.
        print(f"[google-ads-error] {' '.join(detail.split())}", flush=True)
        match = re.search(r"respondió (\d{3})", detail)
        status = match.group(1) if match else None
        if status == "400":
            message = "Google Ads rechazó la solicitud — revisa el ID de la cuenta y el rango de fechas."
        elif status in ("401", "403"):
            message = "La cuenta de Google Ads no tiene permiso para esta operación, o la conexión con Google expiró."
        elif status == "404":
            message = "No se encontró la cuenta o campaña indicada."
        elif status == "429":
            message = "Google Ads está limitando las solicitudes ahora mismo — espera un momento e intenta de nuevo."
        elif status and status.startswith("5"):
            message = "Google Ads tuvo un problema temporal — intenta de nuevo en unos minutos."
        else:
            message = "No se pudo completar la operación con Google Ads. Si el problema sigue, revisa los logs del servidor."
        self._send_json(502, {"error": message})

    # --------------------------------------------------------------- json ---
    def _send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_security_headers()
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
