# Paid Media Helper — Plataforma de Google Ads

Implementación del diseño (`OUTPUTS/plataforma-google-ads/Diseño de plataforma-handoff.zip`) como sitio estático — ya no es solo el prototipo original de 3 funciones, ver `OUTPUTS/plataforma-google-ads/Resumen_Proyecto.md` para el detalle completo y actualizado de las 12 funciones activas (Rendimiento, ROAS, Recomendaciones, IA Max, Negativización, Exclusiones de contenido, Planificador de keywords, Ritmo de consumo, Oportunidad de ingresos, Comparar periodos, Bookings, Proyección de ventas — más el Generador de copys, construido pero oculto del menú). Vive en producción en [Railway](https://railway.app) (`https://paid-media-helper.up.railway.app`), con auto-deploy desde `main`.

## Cómo correrla

```bash
cd webapp
python3 server.py
```

Luego abre `http://localhost:8642` — te va a pedir iniciar sesión o crear cuenta antes de dejarte entrar (ver "Login" abajo).

`server.py` sirve los archivos estáticos, expone `/api/fetch` (usado por el Generador de copys para descargar páginas del lado del servidor) y ahora también el login. Ya no sirve usar `python3 -m http.server` como alternativa — sin `server.py` no hay login ni Generador de copys.

## Archivos

- `index.html` — estructura y carga de fuentes/íconos (Lucide), `xlsx` para leer Excel, y Chart.js para las gráficas.
- `login.html` / `login.js` — pantalla de inicio de sesión / creación de cuenta.
- `styles.css` — tokens de diseño (color, tipografía, espaciado) portados del design system del handoff.
- `engine.js` — lógica de negocio de las funciones que procesan un archivo (CSV/Excel) en el navegador, sin dependencias de UI.
- `app.js` — estado de todas las funciones, renderizado y manejo de eventos (un solo archivo, grande — el patrón de cada función nueva se agrega siguiendo el de la anterior).
- `server.py` — servidor + login/registro/sesión/Administración + todos los endpoints `/api/*` (ver notas abajo).
- `google_ads_client.py` — cliente de la API de Google Ads (lectura y escritura) — solo `urllib`, sin la librería oficial, para no agregar dependencias pip al servidor.
- `claude_client.py` — cliente de la API de Claude (análisis con IA en Rendimiento) — mismo criterio que `google_ads_client.py`.
- `data.db` — se crea sola al arrancar el servidor por primera vez. Guarda usuarios, sesiones, a qué cuentas de Google Ads tiene acceso cada quien, y la watchlist de Ritmo de consumo. No se sirve por HTTP. En producción vive en un volumen persistente de Railway, separado del código.

## Login

**Registro cerrado** (desde 2026-07-30) — hace falta un código de invitación exacto (`PMH_REGISTRATION_CODE`) que solo un admin reparte; sin la variable configurada, el registro queda cerrado por default. Contraseñas con hash + salt (PBKDF2-SHA256, 200k iteraciones, nunca en texto plano), mínimo 10 caracteres, rate limiting en login/registro, y bloqueo de cuenta tras 5 intentos fallidos (15 min). La sesión dura 14 días (cookie httpOnly, `Secure` en producción) y se cierra con el botón "Cerrar sesión" del sidebar.

Cada usuario no-admin solo puede leer/escribir en las cuentas de Google Ads que un admin le asigne explícitamente (pantalla de Administración) — sin ninguna asignación, no puede tocar ninguna cuenta real. Los admins pueden además generar una contraseña temporal para otro usuario que perdió acceso (no hay infraestructura de correo para un "olvidé mi contraseña" self-service). Un admin también puede ligar al usuario a un sub-MCC completo (tabla `user_mcc_access`): ve todas sus cuentas, incluidas las futuras (caché de 10 minutos, falla cerrado si Google no responde).

Ver `OUTPUTS/plataforma-google-ads/Resumen_Proyecto.md` → "Seguridad — endurecimiento" para el detalle completo de cada punto.

No hay todavía historial entre cargas (Fase 2 del roadmap sigue pendiente) — la base `data.db` por ahora solo guarda usuarios, sesiones y a qué cuentas de Google Ads tiene acceso cada quien, no el resultado de los análisis.

## Otras notas

- **Generador de copys y CORS:** un `fetch()` hecho desde el navegador a otro dominio es bloqueado por casi todos los sitios (CORS). Por eso `server.py` descarga la página del lado del servidor (igual que hacía `requests` en el prototipo de Streamlit) y se la entrega a la app ya lista. Si aun así falla (el sitio bloquea bots, exige JavaScript para cargar contenido, timeout, etc.), usa el botón "¿No cargó? Pega el HTML": abre la página en el navegador, "Ver código fuente" (Ctrl/Cmd+U), copia y pega.
- Sin la columna "Campaign type" en el archivo de campañas, todo se trata como Search (marca se detecta solo por el nombre) — comportamiento esperado documentado en `spec.md`.
