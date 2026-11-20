# Paid Media Helper — instrucciones para Claude Code

Herramienta interna de una agencia de hoteles para analizar y operar cuentas de Google Ads. Producción: `https://paid-media-helper.up.railway.app` (Railway, auto-deploy desde `main`). Código en `webapp/`; documentación y material del equipo en `OUTPUTS/plataforma-google-ads/`.

**Este repositorio es público.** Nunca escribas en archivos del repo: valores de claves o tokens, códigos de registro, IDs de cuentas de clientes, nombres de usuarios, ni datos reales de campañas. Los secretos viven solo en las variables de entorno de Railway.

## Cómo trabajar con la persona dueña del proyecto

- Responde en español.
- Flujo fijo: implementar → probar en local → reportar qué se probó → **preguntar «¿Hago el commit y el push?»** → solo con un sí explícito, commit y push. Nunca hagas commit ni push sin esa respuesta.
- `git add` siempre con rutas concretas, nunca `-A` ni `.`: en este repo suelen quedar cambios de documentación sin relación pendientes.
- Después de que la persona confirme que probó en producción, agrega una nota «verificado en producción» en `Resumen_Proyecto.md` y vuelve a preguntar antes de hacer commit.
- Decide por reglas, de una en una, y consulta antes de ampliar un permiso o abrir una sección a más usuarios.
- Si la API no puede leer un valor, no digas nada: ni hallazgo inventado ni «no verificable» cuando el dato no está claro.

## Restricción de arquitectura: solo biblioteca estándar de Python

`webapp/Dockerfile` ejecuta `python3 server.py` sin `pip install`. Todo `webapp/*.py` usa solo la biblioteca estándar. Los clientes de Google Ads, Claude y BigQuery llaman a sus APIs con `urllib`, no con SDKs; es deliberado. Una integración nueva sigue el mismo patrón, o primero se cambia el Dockerfile. El frontend es HTML/CSS/JS sin build: las librerías se sirven desde `webapp/vendor/`, no desde CDN.

## Mapa del código (`webapp/`)

- `server.py`: servidor, login, sesiones, roles, Administración y todos los endpoints `/api/*`.
- `google_ads_client.py`: lectura y escritura contra la API de Google Ads (`API_VERSION` en la parte superior, hoy v26; para volver atrás se cambia ese valor). Incluye las funciones `simulated_*` que alimentan el modo simulado.
- `app.js`: estado, render y eventos de todo el frontend, en un solo archivo grande. Cada función nueva sigue el patrón de la anterior. `engine.js` tiene la lógica que procesa archivos CSV/Excel en el navegador.
- `account_audit.py`: motor de 66 reglas de la Auditoría. Si cambian reglas o puntaje, sube `RULES_VERSION`.
- `claude_client.py`, `negativos_ia.py`, `hoteles_ia.py`: llamadas a Claude y validación con código de lo que propone la IA (la IA propone, el código valida).
- `bigquery_client.py`: solo lectura, con tope de bytes por consulta.
- Documentación completa y al día: `OUTPUTS/plataforma-google-ads/Resumen_Proyecto.md` (lee primero «Qué es», «Cómo corre la plataforma, y el login» y la función que vayas a tocar) y `roadmap.md`.

## Roles y secciones restringidas

Hay usuarios normales, administradores (`PMH_ADMIN_USERNAMES`) y super admin (`PMH_SUPER_ADMIN_USERNAMES`). Cada usuario no administrador solo accede a las cuentas de Google Ads que un administrador le asigna. Hoteles, Audiencias, Anuncios nuevos y la pestaña «Con IA» de Negativización son solo para super admin: el servidor responde 403 a cualquiera más, no solo se oculta el menú. Campañas la ve y usa todo usuario con sesión, también pausar, activar y ajustar presupuesto; cada consulta y cada escritura valida el acceso a la cuenta. El rol se sincroniza con las variables de entorno **solo al arrancar el servidor**.

## Escrituras reales en cuentas de clientes

La plataforma modifica cuentas reales (presupuesto diario, ROAS objetivo, AI Max, negativas, pausar y activar campañas, modificadores de hotel, recomendaciones). Ya están probadas en producción. Reglas que no se rompen:

- Toda escritura tiene vista previa (validación de Google sin aplicar) antes de aplicar.
- Anuncios nuevos (`ads-create`): siempre pausados, solo en grupos activos de campañas Search que el servidor relee en vivo, la URL debe ser de un dominio que ya usen los anuncios de esa cuenta, todas las cuentas del mismo MCC, máximo 40 cuentas por tanda y registro en `ad_creation_log`. La pantalla crea solo por plantilla (`ads-create-bulk`; desde 2026-11-20 ya no hay modo «un grupo por cuenta» en la interfaz, aunque `ads-create` sigue disponible en la API): exige la URL de los anuncios activos del propio grupo, o, si la persona escribe una **URL de destino** opcional (`custom_url`), un dominio que ya usen los anuncios activos de la cuenta (sin anuncios de referencia se rechaza), y además una etiqueta; salta grupos con 3 RSA activos o ya etiquetados. Los anuncios nuevos se crean siempre pausados. Activarlos o pausarlos por etiqueta (`label-ads-status`) solo se hace a mano, con vista previa (validación de Google) y confirmación, sobre anuncios que el servidor vuelve a encontrar con la etiqueta, con el grupo y la campaña activos y Search y sin pasar de 3 anuncios adaptables activos por grupo, con registro en `ad_status_log`. Decisión de la persona dueña (2026-11-20): la activación o la pausa por etiqueta también se puede **programar dentro de la plataforma** (`POST /api/ad-schedules`, solo super admin): fecha y hora locales de cada cuenta (zona horaria leída de Google Ads), hasta 40 cuentas y 100 programaciones pendientes; una tarea de fondo del servidor (`_scheduler_loop`) la ejecuta, **vuelve a validar con Google justo antes de aplicar** y solo cambia lo aplicable en ese momento (mismas reglas que a mano); si el servidor no pudo ejecutarla a tiempo la reintenta hasta 6 h después y pasado ese margen no se ejecuta; quien la creó debe seguir siendo super admin; cada cambio queda en `ad_status_log` con `source='programado'`; tablas `ad_schedules` y `ad_schedule_runs`. **Eliminar por etiqueta** (`POST /api/google-ads/label-ads-remove`, solo super admin, decisión de la persona dueña 2026-11-20): elimina únicamente anuncios adaptables **PAUSADOS** que el servidor vuelve a encontrar con la etiqueta (creados por la plataforma o no), con vista previa (validación de Google), confirmación explícita, registro en `ad_status_log` con `new_status='REMOVED'`, **sin programación**; después elimina la etiqueta de la cuenta solo si ya nada la usa (`delete_label_if_unused`; ante cualquier duda la deja). Anuncios nuevos tiene su propio tope de escrituras (`AD_WRITE_RATE_LIMIT`). Los títulos y las descripciones de la plantilla se pueden redactar con IA a partir de las indicaciones de la persona (`POST /api/ai/anuncios-textos`, solo super admin, `generar_textos_anuncio` en `claude_client.py`): la IA solo propone texto y el código valida (largo, duplicados, emojis, cifras y afirmaciones que no estén en las indicaciones, variables permitidas); no crea nada en Google Ads.
- Presupuesto: el servidor relee el valor vivo, limita el cambio a ±30 % (`BUDGET_MAX_CHANGE`), rechaza presupuestos compartidos, exige `expected_current_budget` y deja registro en `campaign_budget_log`.
- Hay límite de escrituras por usuario (`WRITE_RATE_LIMIT`) y registro de cada cambio.
- No hagas pruebas de escritura reales sin el visto bueno explícito de la persona dueña, y vuelve la cuenta a su estado original al terminar.

## Cómo probar antes de publicar

1. Revisa la sintaxis: `python3 -c "import ast; ast.parse(open('server.py').read())"` para cada `.py` tocado, y `node --input-type=module --check < app.js` para el JS.
2. Levanta el servidor con un `DATA_DIR` aislado (nunca la base de producción) y créalo antes con `mkdir -p`:
   `PORT=8651 DATA_DIR=<carpeta-temporal> PMH_REGISTRATION_CODE=testcode123 PMH_ADMIN_USERNAMES=testadmin PMH_SUPER_ADMIN_USERNAMES=testadmin python3 server.py`
3. Registra el usuario con `POST /api/register` (campos `username`, `password`, `code`; la contraseña necesita complejidad). Como el rol se sincroniza al arrancar, reinicia el servidor o ajusta `is_admin` en la base de prueba antes de entrar.
4. Sin credenciales se usa el modo simulado. Para probar con datos reales de solo lectura, ejecuta el servidor con `railway run env PORT=... DATA_DIR=... python3 server.py`: inyecta las credenciales reales sin copiarlas a ningún archivo.
5. Prueba la pantalla en el navegador, no solo con curl, y revisa la consola y las peticiones de red. `window.confirm()` se cancela solo en el navegador automatizado.
6. Al terminar, apaga el servidor (`lsof -ti :8651 | xargs kill`) y borra la carpeta temporal.

## Despliegue

- `railway.json` hace que **solo los cambios bajo `/webapp/**` redespliegan**. Un commit solo de documentación (`OUTPUTS/`, `CLAUDE.md`) no despliega y es seguro a cualquier hora.
- Un push que toca `webapp/` provoca un corte de 1 a 3 minutos. Avisa antes y evita horas pico.
- Después del push, `railway status` debe pasar a `Online`. Haz una prueba de humo sin sesión: el endpoint nuevo debe responder 401 o 403, no 500.

## Convenciones del producto que ya se decidieron

- **Idioma (español/inglés):** por ahora solo para super admin (el servidor responde 403 a los demás); consulta antes de abrirlo a más usuarios. El código se escribe en español y `webapp/i18n.js` lo traduce al dibujarlo con el diccionario `webapp/i18n-en.js` (la clave es el texto en español exacto; las frases con datos usan marcadores `{0}` o `{n0}` solo numérico). Al agregar o cambiar un texto visible, agrega o ajusta su entrada en el diccionario; sin entrada se ve en español. No uses texto de pantalla como condición en el código (`textContent === '…'`), porque en inglés cambia. Fases 1 a 4: todas las secciones, los errores del servidor (el JSON sigue en español; se traducen en el navegador) y las descargas HTML/Markdown/CSV ya están traducidas (`downloadTextFile` → `translateDownload`; el CSV, con `setCsvCellTransform` en `engine.js`); fase 5: la IA responde en el idioma elegido (`_ai_language` en `server.py` y `_con_idioma` en `claude_client.py`; inglés solo para super admin; una función nueva con IA debe recibir `lang` y envolver su instrucción con `_con_idioma`) y el inglés del diccionario ya se revisó. Los textos que genera `engine.js` también van en el diccionario. Para revisar una pantalla: `localStorage.pmh_i18n_debug = '1'` y `window.__i18n.missing()`. El texto de las gráficas (Chart.js) no pasa por el traductor del DOM: envuelve sus etiquetas con `t()`. Si un texto mezcla piezas con datos en un solo nodo, sepáralas en `<span>` para que cada una se traduzca.

- Las descargas HTML de la sección Campañas nunca llevan la parte de «Cambios»: respeta la bandera `campanaExportMode` en `app.js`.
- Con datos de Google Ads los importes muestran el código de moneda de la cuenta; con archivos se mantiene «$».
- Las cuentas de hoteles se reconocen por el nombre `GHA-CPC` o `GHA - CPC` (`hotelIsHotelAccount`); Hoteles y el filtro de Ritmo de consumo usan el mismo criterio.
- La Auditoría, Rendimiento y Ritmo de consumo están abiertas a todos los usuarios; el análisis con IA tiene límite por usuario y por hora, y su consumo se registra en la tabla `ai_usage`.

## Seguridad

- Variables de entorno que usa el servidor (solo los nombres; los valores están en Railway): `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `ANTHROPIC_API_KEY`, `PMH_REGISTRATION_CODE`, `PMH_ADMIN_USERNAMES`, `PMH_SUPER_ADMIN_USERNAMES`, `PMH_SECURE_COOKIES`, `DATA_DIR`, y las de BigQuery (`BIGQUERY_PROJECT_ID`, `BIGQUERY_REFRESH_TOKEN`).
- Nunca pegues un secreto en el chat, en un commit, en un archivo del repo ni en una carpeta temporal. Pásalo en línea como variable de entorno solo en el comando que lo necesita.
- En octubre de 2026 hubo un incidente de seguridad de Railway y se rotaron todas las credenciales. Ante cualquier sospecha de filtración, rota primero y pregunta después.
- La base de datos (SQLite) vive en el volumen `/data` de Railway. No la copies ni la subas.

## Lo que queda pendiente

Consulta `roadmap.md`. Cuando termines una función, actualiza `Resumen_Proyecto.md` (una entrada en las novedades y el detalle en la función correspondiente).
