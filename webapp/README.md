# Paid Media Helper — Plataforma de Google Ads

Implementación del diseño (`OUTPUTS/plataforma-google-ads/Diseño de plataforma-handoff.zip`) como sitio estático, con la lógica de las tres funciones ya operativa:

1. **Rendimiento** — sube un export de campañas (CSV/Excel), calcula CPA ponderado/simple y CTR segmentado por tipo de campaña (Search marca/genérica, Display, Performance Max), y genera recomendaciones priorizadas por gasto.
2. **Negativización** — sube el export de "Términos de búsqueda", clasifica cada término en Mantener / Revisar / Candidato a negativo según términos núcleo y excepciones.
3. **Generador de copys** — pega una URL (o pega el HTML si el sitio bloquea CORS) y genera 15 títulos y 10 descripciones para un anuncio de búsqueda responsivo.

## Cómo correrla

```bash
cd webapp
python3 server.py
```

Luego abre `http://localhost:8642` — te va a pedir iniciar sesión o crear cuenta antes de dejarte entrar (ver "Login" abajo).

`server.py` sirve los archivos estáticos, expone `/api/fetch` (usado por el Generador de copys para descargar páginas del lado del servidor) y ahora también el login. Ya no sirve usar `python3 -m http.server` como alternativa — sin `server.py` no hay login ni Generador de copys.

## Archivos

- `index.html` — estructura y carga de fuentes/íconos (Lucide) y la librería `xlsx` para leer Excel.
- `login.html` — pantalla de inicio de sesión / creación de cuenta.
- `styles.css` — tokens de diseño (color, tipografía, espaciado) portados del design system del handoff.
- `engine.js` — lógica de negocio (puerto de `analysis.py`, `negative_keywords.py`, `copy_generator.py`), sin dependencias de UI.
- `app.js` — estado de la app, renderizado y manejo de eventos.
- `server.py` — servidor estático + login/registro/sesión + endpoint `/api/fetch` (ver notas abajo).
- `data.db` — se crea sola al arrancar el servidor por primera vez. Guarda usuarios (contraseña con hash + salt, nunca en texto plano) y sesiones activas. No se sirve por HTTP; bórrala si quieres reiniciar los usuarios desde cero.

## Login

Registro abierto: cualquiera con el link de la app puede crear su cuenta desde `/login` — no hay invitación ni aprobación previa. La sesión dura 14 días (cookie httpOnly, no accesible desde JS) y se cierra con el botón "Cerrar sesión" del sidebar.

**Esto es apropiado mientras la app corra local o en una red interna de confianza, como hoy.** Si en algún momento se expone en una red compartida o en internet, hace falta antes de eso:
- Servir con HTTPS y marcar la cookie de sesión como `Secure`.
- Cerrar el registro abierto (dar de alta cuentas a mano, o agregar aprobación).
- Ojo: Rendimiento y Negativización procesan el archivo subido enteramente en el navegador (nunca tocan el servidor) — el login controla quién puede *cargar la app*, no hay una segunda barrera del lado del servidor para esas dos funciones una vez que alguien ya tiene la página abierta.

No hay todavía historial entre cargas (Fase 2.1 del roadmap sigue pendiente) — la base `data.db` por ahora solo guarda cuentas de usuario, no el resultado de los análisis.

## Otras notas

- **Generador de copys y CORS:** un `fetch()` hecho desde el navegador a otro dominio es bloqueado por casi todos los sitios (CORS). Por eso `server.py` descarga la página del lado del servidor (igual que hacía `requests` en el prototipo de Streamlit) y se la entrega a la app ya lista. Si aun así falla (el sitio bloquea bots, exige JavaScript para cargar contenido, timeout, etc.), usa el botón "¿No cargó? Pega el HTML": abre la página en el navegador, "Ver código fuente" (Ctrl/Cmd+U), copia y pega.
- Sin la columna "Campaign type" en el archivo de campañas, todo se trata como Search (marca se detecta solo por el nombre) — comportamiento esperado documentado en `spec.md`.
