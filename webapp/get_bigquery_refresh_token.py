"""Genera un refresh token de OAuth con scope de BigQuery (solo lectura).

Uso (una sola vez, en tu computadora — NO en Railway):

    GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... python3 get_bigquery_refresh_token.py

Requisitos previos:
  - En Google Cloud Console → APIs y servicios → Credenciales, el cliente OAuth
    debe ser de tipo "Aplicación de escritorio" (o tener como URI de redirección
    http://localhost:8765/).
  - La API "BigQuery API" debe estar habilitada en el proyecto.
  - Inicia sesión con la cuenta de Google que tiene acceso a los datasets.

Imprime el refresh token; guárdalo como BIGQUERY_REFRESH_TOKEN en Railway.
"""

import http.server
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/bigquery.readonly"
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/"


def main():
    client_id = os.environ.get("BIGQUERY_CLIENT_ID") or os.environ.get("GOOGLE_ADS_CLIENT_ID")
    client_secret = os.environ.get("BIGQUERY_CLIENT_SECRET") or os.environ.get("GOOGLE_ADS_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.exit("Faltan GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET en el entorno.")

    state = secrets.token_urlsafe(16)
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    received = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            received["code"] = (qs.get("code") or [None])[0]
            received["state"] = (qs.get("state") or [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Listo, ya puedes cerrar esta pestaña y volver a la terminal.".encode("utf-8"))

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("localhost", PORT), Handler)
    print("Abriendo el navegador para autorizar el acceso de solo lectura a BigQuery...")
    print(auth_url)
    webbrowser.open(auth_url)
    server.handle_request()

    if not received.get("code") or received.get("state") != state:
        sys.exit("No se recibió un código de autorización válido.")

    data = urllib.parse.urlencode({
        "code": received["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode("utf-8")
    with urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=data)) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    token = payload.get("refresh_token")
    if not token:
        sys.exit("Google no devolvió refresh_token; revoca el acceso previo de la app y reintenta.")
    print("\nBIGQUERY_REFRESH_TOKEN=" + token)


if __name__ == "__main__":
    main()
