# Plataforma de Análisis de Google Ads — Resumen del proyecto

## Qué es

Una herramienta interna para que cualquier persona del equipo suba archivos de una cuenta de Google Ads y reciba sin intervención manual: (1) gráficas de rendimiento y recomendaciones de optimización, (2) una lista de candidatos a palabra clave negativa, y (3) análisis de reservas reales para cuentas de hotel. Pensada para cubrir 100+ cuentas de forma self-serve.

Hay una cuarta función ya construida — generador de copys de anuncio desde una URL — pero **está oculta del menú a pedido de cesar**: tras probarla con cuentas reales, el resultado no lo convenció lo suficiente para quedar en v1. Queda pendiente para v2 (ver "Función 3" más abajo y `roadmap.md`).

Ya no es solo un prototipo de Streamlit: existe una implementación web completa (`webapp/`, HTML/CSS/JS + un servidor Python sin dependencias externas) con login por usuario/contraseña, que reproduce el diseño hecho en Claude Design. Corre local (`python3 webapp/server.py` → `http://localhost:8642`) — ver "Cómo corre la plataforma" más abajo.

## Estado: cuatro funciones construidas, tres activas en el menú (la cuarta en pausa para v2)

### Función 1 — Análisis de rendimiento

Sube un CSV/Excel de campañas → calcula CPA, CTR, share de gasto e impression share perdido, genera gráficas y recomendaciones priorizadas por gasto. Probado con datos sintéticos de 10 campañas.

Umbral de CTR segmentado por tipo de campaña (Fase 1, ya construido): Search se divide en marca (20% mínimo) y genérica (8% mínimo) — quien busca el nombre de la marca casi siempre hace clic, así que un umbral único generaba falsas alertas en marca. Display 1%, Performance Max 3%. Marca se detecta por palabras clave en el nombre de la campaña, configurables por el usuario (por defecto: "marca", "brand", "branded", "brnd" — cubre la convención BRND/GNR del equipo); sin match, o sin la columna "Campaign type" en el archivo, se trata como Search genérica.

El resumen ejecutivo ahora muestra el CPA promedio de cuenta en dos versiones diferenciadas: ponderado por gasto y simple entre campañas (este último es el que usa la alerta de "CPA alto"), para que no se confundan como un solo número.

**Validada con la primera cuenta real** (Click Clack Bogotá): esa primera carga encontró un bug real — el export nativo de campañas de Google Ads trae 2-3 líneas de título (informe, cuenta, rango de fechas) antes del encabezado real, y la app asumía que la línea 1 ya era el encabezado. El `sample_data.csv` sintético usado hasta entonces no tenía ese preámbulo, así que el caso nunca se había probado. Ya corregido: la app busca la fila de encabezado entre las primeras líneas, igual que ya hacía la Función 2. Pendiente: repetir la carga con esta cuenta y anotar si las recomendaciones coinciden con el criterio de cesar, y seguir con el resto de las 3-5 cuentas objetivo de Fase 1.

### Función 2 — Negativización de términos de búsqueda

Sube el reporte de términos de búsqueda → el usuario define términos núcleo y excepciones conocidas → la plataforma clasifica cada término en Mantener / Revisar / Candidato a negativo, y ahora también muestra el ahorro estimado en gasto si se negativizan los candidatos (con aviso si esos términos ya traían conversiones, para no negativizar a ciegas algo que sí convierte).

Se validó con el reporte real de la cuenta Estelar Playa Manzanillo (934 términos, 12 de julio de 2026):

| Categoría | Términos | Costo | Clics |
|---|---|---|---|
| Mantener | 96 | $674.47 | 629 |
| Revisar (ambiguos) | 14 | $5.83 | 8 |
| Candidatos a negativo | 824 | $121.43 | 151 |

El caso que validó el mecanismo: "Manzanillo del Mar" es una zona real de Cartagena distinta de la playa donde está el hotel. Un match de texto simple habría mantenido esos 14 términos por error; con la excepción configurada, quedaron separados en "revisar" para que alguien decida.

### Función 3 — Generador de copys desde URL (construida, oculta del menú — pendiente para v2)

**Estado actual: fuera del menú de v1.** Se construyó por completo y se corrigieron varios bugs reales encontrados al probarla con datos reales (ver detalle abajo), pero al revisarla de nuevo cesar decidió que el resultado no lo convence lo suficiente para dejarla activa en v1 ("definitivamente no me convence, dejemos esta parte para la versión 2" — 2026-07-13). El código sigue completo en `webapp/engine.js` (`extractSignals`, `generateHeadlines`, `generateDescriptions`) y `webapp/app.js` (`renderCopyPage`) — solo se quitó el botón de navegación en `webapp/index.html`, no se borró nada. Reactivarla en v2 es tan simple como devolver ese botón al sidebar, o retomarla con generación vía modelo de lenguaje (ver "Por qué ninguna de las funciones..." más abajo, y el backlog en `roadmap.md`).

Pegas la URL de una página → la plataforma descarga el HTML, extrae señales de conversión (título, H1/H2, meta description, textos de botones, ofertas mencionadas, marca) y genera 15 títulos (≤30 caracteres) y 10 descripciones (≤90 caracteres) para un anuncio de búsqueda responsivo, listos para descargar en CSV.

Se probó con una página ficticia de hotel todo-incluido (con título, meta description, encabezados, lista de amenidades, CTAs y menciones de descuento) y con una página mínima (solo un `<title>`, sin nada más). En ambos casos entregó exactamente 15 títulos y 10 descripciones, ninguno excede su límite de caracteres, sin duplicados.

**Ya probada también con una URL real** (`estelarplayamanzanillo.com`) en la implementación `webapp/`: la descarga de la página ahora ocurre del lado del servidor (`webapp/server.py`), porque un `fetch()` hecho desde el navegador a otro dominio choca con el bloqueo CORS de casi cualquier sitio. Esa primera prueba real encontró un bug: el extractor tomaba texto de menús de navegación (Login, Idiomas, Habitaciones, Ofertas...) y hasta CSS embebido en íconos SVG como si fuera copy real. Ya corregido — se descarta ese ruido (`<nav>`, `<header>`, `<footer>`, `<style>`, y contenedores con clase tipo `navbar`/`navigator`) antes de generar títulos y descripciones.

Tras ese primer feedback de calidad, se hicieron dos rondas más de mejoras a las plantillas (vocabulario según rubro hospedaje/retail, evitar títulos/descripciones cortados en una preposición suelta, evitar frases duplicadas cuando la oferta ya está en la keyword, corregir una marca inflada cuando el `<title>` no trae separadores, ampliar el filtro de microcopy de UI genérico) — mecánicamente todo quedó correcto, pero el resultado le siguió pareciendo insuficiente a cesar frente al estándar de copy que espera. Eso apunta a un techo real del enfoque basado en reglas/plantillas, no a un bug puntual — ver `roadmap.md` para la alternativa evaluada (generación real vía Claude API).

### Función 4 — Bookings (reservas de hotel)

Sección nueva, fuera del alcance original del proyecto (pensado solo para cuentas de Google Ads) — se agregó a pedido para analizar reservas reales de hoteles. Sube el export de reservas (Excel/CSV, toma siempre la primera hoja del archivo) → la plataforma entrega, sin intervención manual:

- Reservas por mercado (país).
- Distribución de días de antelación entre la reserva y la estadía, en rangos (0-7, 8-14, 15-30, 31-60, 61+ días).
- Un heatmap de reservas y noches por mes de llegada × mercado, con el promedio de noches por reserva de cada mercado.
- Distribución de llegadas (%) por día de la semana.
- Filtro por mercado, y filtro por hotel (este último solo aparece si el archivo trae más de un hotel en el listado) — ambos filtran todas las gráficas a la vez.

Se validó con un export real de reservas de la cuenta Click Clack (columnas `Alta`, `Hotel`, `Canal`, `Pais`, `Afiliado`, `Fecha entrada`, `Fecha salida`). Esa validación encontró y corrigió dos bugs reales de fecha, ambos con la misma causa de fondo — confiar en el texto formateado de la celda en vez del valor real:

1. **Formato de celda con año de 2 dígitos (`DD-MM-YY`).** La app convertía la fecha a texto antes de leerla, y ese formato no calzaba en ningún patrón reconocido — resultado, noches por reserva de cientos de días en vez de 1-4 reales. Corregido leyendo el número de serie real de Excel (el valor interno de la celda, días desde 1900) en vez de su texto formateado — así ya no importa si la celda se ve como "16-03-26", con hora incluida, o cualquier otro formato de visualización.
2. **Orden día/mes decidido por archivo completo, no por reserva.** Si dos fechas de la misma reserva tenían ambas día ≤12, podían interpretarse con el día y el mes invertidos entre sí. Corregido: el orden se detecta primero con la propia evidencia de cada reserva (su fecha de alta/entrada/salida), y solo si esa reserva no trae ninguna pista propia se usa un orden de respaldo calculado con todo el archivo. La interfaz avisa si detecta que el archivo mezcla formatos entre filas.

Pendiente: seguir validando con más cuentas de hotel reales.

## Por qué ninguna de las tres funciones de Google Ads usa un modelo de lenguaje por análisis

A 100+ cuentas, llamar a una API por cada archivo o URL tiene costo y latencia reales, y en el caso de negativización y copys implicaría que cada persona del equipo tenga su propia clave de API. Por eso la Función 2 compara contra términos núcleo/excepciones definidas por el usuario, y la Función 3 combina extracción real de la página con plantillas de copywriting de conversión. El costo de esta decisión: ninguna de las dos "entiende" el contenido como lo haría un modelo — solo detectan lo que ya se les definió o lo que literalmente está escrito en la página. Por eso ambas funciones piden revisión humana antes de publicar nada.

## Cómo corre la plataforma, y el login

```
cd webapp
python3 server.py
```

Abre `http://localhost:8642` — pide iniciar sesión o crear cuenta antes de dejar entrar. El registro es abierto (cualquiera con el link puede crear su cuenta), con contraseñas guardadas con hash + salt (nunca en texto plano) en una base SQLite local (`webapp/data.db`), y sesión por cookie de 14 días.

**Esto es apropiado mientras la app corra local o en una red interna de confianza, como hoy.** Antes de exponerla en una red compartida o en internet hace falta: HTTPS + cookie de sesión marcada `Secure`, y decidir si el registro sigue abierto o pasa a altas manuales. Además, Rendimiento y Negativización procesan el archivo subido enteramente en el navegador (nunca tocan el servidor) — el login controla quién *entra* a la app, no hay una segunda barrera del lado del servidor para esas dos funciones específicas una vez que alguien ya la tiene abierta.

## Limitaciones conocidas

- El `sample_data.csv` de prueba no trae la columna real "Campaign type" de Google Ads, así que en ese archivo las campañas de Display/Performance Max caen por defecto en Search genérica — hay que confirmar con un export real que sí incluya esa columna.
- Las palabras de marca (Función 1) y los términos núcleo/excepciones (Función 2) se escriben en la pantalla cada vez que se sube un archivo — no se guardan por cuenta todavía (depende de la persistencia de Fase 2).
- "Estelar" como término núcleo (Función 2) es amplio — es una cadena con varias propiedades en Colombia, puede retener búsquedas de otro hotel Estelar.
- La Función 3 no ejecuta JavaScript: páginas que cargan su contenido dinámicamente van a dar poco texto real y el resultado se apoya más en plantillas genéricas.
- La Función 3 no valida las políticas de contenido de Google Ads (mayúsculas, superlativos, marcas de terceros) — solo longitud de caracteres.
- Ninguna de las cuatro funciones valida que el archivo/URL subido sea reciente ni de la cuenta correcta.
- **Control de acceso: ya no está pendiente** (ver "Cómo corre la plataforma, y el login" arriba) — pero el registro abierto y la ausencia de HTTPS solo son apropiados corriendo local/red interna, no listos para exponer más ampliamente.
- No hay persistencia de historial entre cargas todavía para ninguna de las cuatro funciones (Fase 2) — la base de datos que ya existe solo guarda cuentas de usuario, no resultados de análisis.

## Próximos pasos

1. Repetir la carga de Función 1 con Click Clack Bogotá (ya corregido el bug de encabezado) y seguir con el resto de las 3-5 cuentas reales objetivo, comparando las recomendaciones contra el criterio de cesar como estratega.
2. Revisar a mano los 14 términos en "revisar" y los que solo contienen "estelar" antes de subir cualquier negativo real a la cuenta.
3. Función 3 en pausa: decidir para v2 si se retoma mejorando aún más las plantillas o si se cambia a generación real vía Claude API (con costo por llamada) — el enfoque de reglas ya recibió varias rondas de mejora y cesar decidió que el resultado no alcanza el estándar que necesita para v1.
4. Seguir validando la Función 4 (Bookings) con más cuentas de hotel reales.
5. Antes de exponer la app fuera de una red de confianza: HTTPS + cookie de sesión `Secure`, y decidir si el registro de usuarios sigue abierto.
6. Decidir dónde va a vivir la app para que el equipo la use sin depender de una máquina local.

## Archivos del proyecto

| Archivo | Para qué sirve |
|---|---|
| `webapp/` | Implementación web completa (HTML/CSS/JS + servidor Python), con login y las cuatro funciones — correr con `python3 webapp/server.py`. Ver `webapp/README.md` |
| `Especificacion_v1_Plataforma_Google_Ads.docx` | Especificación completa de las tres funciones originales de Google Ads: alcance, formato de archivo, mecanismo, arquitectura, riesgos |
| `app.py` | Interfaz Streamlit con las tres funciones (correr con `streamlit run app.py`) |
| `analysis.py` | Lógica de la Función 1 (rendimiento), reusable sin la interfaz |
| `negative_keywords.py` | Lógica de la Función 2 (negativización), reusable sin la interfaz |
| `copy_generator.py` | Lógica de la Función 3 (copys desde URL), reusable sin la interfaz |
| `sample_data.csv` | Datos de ejemplo para probar la Función 1 |
| `Negativos_Estelar_Playa_Manzanillo.xlsx` | Resultado real de la Función 2 para esa cuenta, listo para revisión |
| `requirements.txt` | Dependencias (`pip install -r requirements.txt`) |
| `Resumen_Proyecto.md` | Este resumen |
