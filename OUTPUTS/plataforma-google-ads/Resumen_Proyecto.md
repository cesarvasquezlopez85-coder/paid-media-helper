# Plataforma de Análisis de Google Ads — Resumen del proyecto

## Qué es

Una herramienta interna para que cualquier persona del equipo suba archivos de una cuenta de Google Ads (o del PMS del hotel) y reciba sin intervención manual: (1) gráficas de rendimiento y recomendaciones de optimización, (2) comparación de rendimiento entre dos periodos con recomendaciones por tendencia, (3) una lista de candidatos a palabra clave negativa, (4) análisis de reservas reales para cuentas de hotel (con modo de comparación entre dos periodos), (5) una estimación de ingresos adicionales perdidos por campañas limitadas por presupuesto, y (6) una proyección de ventas futuras combinando tendencia y temporada alta/baja. Pensada para cubrir 100+ cuentas de forma self-serve.

Hay una función más ya construida — generador de copys de anuncio desde una URL — pero **está oculta del menú a pedido de cesar**: tras probarla con cuentas reales, el resultado no lo convenció lo suficiente para quedar en v1. Queda pendiente para v2 (ver "Función 3" más abajo y `roadmap.md`).

Ya no es solo un prototipo de Streamlit, y ya no corre solo local: existe una implementación web completa (`webapp/`, HTML/CSS/JS + un servidor Python sin dependencias externas) con login por usuario/contraseña, que reproduce el diseño hecho en Claude Design. **Vive en producción en [Railway](https://railway.app)**, en `https://paid-media-helper.up.railway.app`, con auto-deploy desde la rama `main` del repo de GitHub — cualquier cambio que se suba se despliega solo, sin pasos manuales. También se puede correr local con `python3 webapp/server.py` → `http://localhost:8642` — ver "Cómo corre la plataforma" más abajo.

## Versión V2 (2026-07-29)

El sidebar de la app ya lo muestra así. El salto de V1 a V2 marca el paso de "solo archivos subidos a mano" a **conexión real con la API de Google Ads**, tanto de lectura como de escritura:

- **Lectura**, en Rendimiento y Negativización: un toggle "Subir archivo" / "Conectar Google Ads" reemplaza la carga manual — se elige la cuenta (con buscador por ID para no perderse entre las 1105 cuentas reales del MCC), el rango de fechas y, en Rendimiento, un checkbox para traer solo campañas activas.
- **Escritura**, solo en Negativización por ahora: subir palabras clave negativas de verdad a la cuenta, por campaña específica y concordancia exacta — siempre con una vista previa que Google Ads valida sin aplicar el cambio, antes de que el botón de confirmar quede disponible.
- **Conectada de verdad desde el 2026-07-28** (no solo en modo simulado): la primera prueba contra una cuenta real de la agencia encontró y corrigió varios bugs reales (versión de API retirada, un parámetro no soportado, un nombre de campo equivocado, un filtro que dejaba fuera la mayoría de las cuentas del MCC) — ver el detalle completo en la sección de Función 1 más abajo y en `roadmap.md`.
- Mientras las credenciales de Google no estén configuradas (o para cualquier cuenta de prueba), todo sigue funcionando en **modo simulado** — mismos botones, mismo flujo, datos de ejemplo en vez de reales.

## Estado: V2 — siete funciones construidas, seis activas en el menú (Función 3, copys, en pausa para v2)

### Función 1 — Análisis de rendimiento

Sube un CSV/Excel de campañas → calcula CPA, CTR, share de gasto e impression share perdido, genera gráficas y recomendaciones priorizadas por gasto. Probado con datos sintéticos de 10 campañas.

Umbral de CTR segmentado por tipo de campaña (Fase 1, ya construido): Search se divide en marca (20% mínimo) y genérica (8% mínimo) — quien busca el nombre de la marca casi siempre hace clic, así que un umbral único generaba falsas alertas en marca. Display 1%, Performance Max 3%. Marca se detecta por palabras clave en el nombre de la campaña, configurables por el usuario (por defecto: "marca", "brand", "branded", "brnd" — cubre la convención BRND/GNR del equipo); sin match, o sin la columna "Campaign type" en el archivo, se trata como Search genérica.

El resumen ejecutivo muestra el CPA promedio de cuenta en dos versiones diferenciadas: ponderado por gasto y simple entre campañas, para que no se confundan como un solo número. **Nota:** hasta el 2026-07-28 el simple era el que usaba la alerta de "CPA alto" — ver más abajo el rediseño que cambió esto por CPA %.

**Validada con la primera cuenta real** (Click Clack Bogotá): esa primera carga encontró un bug real — el export nativo de campañas de Google Ads trae 2-3 líneas de título (informe, cuenta, rango de fechas) antes del encabezado real, y la app asumía que la línea 1 ya era el encabezado. El `sample_data.csv` sintético usado hasta entonces no tenía ese preámbulo, así que el caso nunca se había probado. Ya corregido: la app busca la fila de encabezado entre las primeras líneas, igual que ya hacía la Función 2.

**Segunda cuenta real** (Estelar, 2026-07-13) encontró y corrigió 4 bugs más:
1. El archivo venía en **UTF-16 con BOM** en vez de UTF-8 — rompía no solo los acentos, sino cualquier comparación de texto exacto (como detectar filas de total). Corregido detectando la codificación real por el BOM.
2. La fila "Total: Campañas" traía la etiqueta en la columna "Estado de la campaña", no en "Campaña" (que quedaba como `"--"`) — se colaba como una campaña más con los totales ya agregados, **duplicando cada número del resumen ejecutivo**. Corregido revisando todas las columnas de la fila, no solo la de campaña — mismo fix aplicado también a la Función 2 (Negativización), que tenía el mismo riesgo.
3. Las columnas reales de "Impression share perdido" venían en español con un nombre distinto al reconocido, así que ese dato salía siempre en cero. Corregido agregando los alias reales y soporte para el formato `"< 10%"` que Google Ads usa en vez de un número exacto.
4. El archivo trae una columna literal "CPA" en % (distinta de "Costo/conv.", el CPA real en $). Se agregó como pestaña/panel aparte ("CPA %"), sin tocar el CPA en $ que ya existía.

**Nuevas tarjetas y filtros (2026-07-13/14):** la tarjeta "Campañas con gasto" se reemplazó por **ROAS** (valor de conversión ÷ gasto, en %, "N/D" si el archivo no trae "Valor de conv."); la tarjeta "CPA promedio · ponderado por gasto" se reemplazó por **Valor de conversión** total; se agregó un **filtro por campaña** para ver el resumen, los gráficos y las recomendaciones de una sola campaña sin volver a subir el archivo.

**Tarjeta CPA % y alerta de "CPA alto" rediseñada por tipo de campaña (2026-07-28):** nueva tarjeta **CPA %** (gasto ÷ valor de conversión, el inverso de ROAS) junto a ROAS, en Vista estándar y Vista densa. A pedido de cesar, esta tarjeta pasó a ser la que determina la alerta de "CPA alto" — que dejó de comparar el CPA en $ contra el promedio simple de la cuenta (un umbral único, sin distinguir tipo de campaña) y ahora usa el CPA %, con un óptimo distinto por tipo de campaña — mismo criterio que ya usaba el umbral de CTR. Óptimos: Search marca 11%, Performance Max 20%, Demand Gen 30%, Display 30%, Search genérica 30%. Solo se evalúa si el archivo trae "Valor de conv."; sin ese dato, la campaña simplemente no se marca. De paso se agregó "Demand Gen" como tipo de campaña reconocido — antes esas campañas caían mal clasificadas como Search por defecto. La tarjeta de CPA en $ pasó a ser solo informativa, ya no dispara la alerta.

**Conexión directa con la API de Google Ads (2026-07-22 en adelante, ver "Versión V2" arriba):** toggle "Subir archivo" / "Conectar Google Ads" en el panel de control — elige la cuenta (selector con buscador, o escribir el ID a mano), el rango de fechas, y un checkbox opcional "Solo campañas activas". El campo de palabras de marca se oculta en este modo (se sigue usando el valor ya guardado, sin pedírselo al usuario en esa pantalla) — sigue siendo necesario para la clasificación marca/genérica, solo que no hace falta mostrarlo cada vez.

Conectada de verdad a una cuenta real desde el 2026-07-28, después de que cesar completara la parte administrativa con Google (proyecto de Cloud, developer token con Basic access aprobado). La primera prueba real encontró y corrigió 4 bugs, ninguno detectable sin una cuenta real:
1. La versión de la API que se usó al construir (`v18`) ya había sido retirada por Google — actualizada a `v25`.
2. La consulta de campañas no acepta el parámetro `pageSize` (a diferencia de otras APIs de Google) — corregido.
3. El nombre de campo `campaign.descriptive_name` no existe para campañas (solo para cuentas) — el correcto es `campaign.name`.
4. El listado de cuentas solo traía las hijas directas del MCC (nivel 1) — la agencia organiza sus cuentas en sub-MCCs por marca de hotel, así que la mayoría quedaban fuera. Corregido para traer toda la jerarquía: pasó de listar 37 cuentas a **1105**.

Verificado de punta a punta contra la cuenta real de Hotel Neptuno: cuentas, campañas, gasto, conversiones, ROAS y recomendaciones — todo igual que con un CSV subido a mano.

**Bug real: solo aparecían campañas Search al conectar la API (2026-07-29).** cesar probó contra una cuenta real y reportó que faltaban Performance Max, Demand Gen y Display. Causa: `fetch_campaign_rows` traía las métricas de Impression Share (exclusivas de Search) en la misma consulta GAQL que el resto de campos — comportamiento documentado de Google Ads, combinar esos campos con otros restringe **todo** el resultado a campañas Search, sin avisar. Corregido separando en dos consultas: la principal (sin campos de Impression Share) trae todos los tipos de campaña; la de Impression Share se usa solo como diccionario auxiliar por `campaign.id`, quedando en `None` para las campañas que no aplican.

Pendiente: repetir la carga de ambas cuentas y anotar explícitamente si las recomendaciones coinciden con el criterio de cesar, y seguir con el resto de las 3-5 cuentas objetivo de Fase 1.

### Función 2 — Negativización de términos de búsqueda

Sube el reporte de términos de búsqueda → el usuario define términos núcleo y excepciones conocidas → la plataforma clasifica cada término en Mantener / Revisar / Candidato a negativo, y ahora también muestra el ahorro estimado en gasto si se negativizan los candidatos (con aviso si esos términos ya traían conversiones, para no negativizar a ciegas algo que sí convierte).

Se validó con el reporte real de la cuenta Estelar Playa Manzanillo (934 términos, 12 de julio de 2026):

| Categoría | Términos | Costo | Clics |
|---|---|---|---|
| Mantener | 96 | $674.47 | 629 |
| Revisar (ambiguos) | 14 | $5.83 | 8 |
| Candidatos a negativo | 824 | $121.43 | 151 |

El caso que validó el mecanismo: "Manzanillo del Mar" es una zona real de Cartagena distinta de la playa donde está el hotel. Un match de texto simple habría mantenido esos 14 términos por error; con la excepción configurada, quedaron separados en "revisar" para que alguien decida.

**Fix aplicado 2026-07-14:** tenía el mismo riesgo que se encontró en la Función 1 con filas de total — solo revisaba la columna del término de búsqueda para descartarlas. Corregido para revisar todas las columnas de la fila, igual que Función 1.

**Primera función con escritura real hacia Google Ads (2026-07-29):** hasta ahora toda la integración con la API era de solo lectura. A pedido de cesar, Negativización fue el punto de partida para escribir de vuelta — porque ya tenía la cultura de "revisar antes de publicar" integrada en el diseño. Decisiones acordadas antes de construir: los negativos se suben por campaña específica (no como lista compartida), con concordancia exacta, y el reporte de términos también se puede traer directo de la API (mismo toggle "Subir archivo" / "Conectar Google Ads" que ya tiene Rendimiento).

En modo API, la tabla de candidatos trae una columna "Campaña" y un checkbox por término. El flujo de subida **siempre** pasa primero por una vista previa que Google Ads valida sin aplicar el cambio (`validateOnly`) — el botón "Confirmar y subir" solo se habilita después de una vista previa exitosa, para que nunca haya un solo clic entre seleccionar términos y escribir en la cuenta real. En modo "Subir archivo" (CSV) nada de esto aparece, ese flujo sigue exactamente igual que antes.

Verificado de punta a punta en modo simulado (traer términos → clasificar → seleccionar → vista previa → confirmar). Pendiente: la primera prueba contra una cuenta real, que — como pasó con el resto de la integración — probablemente encuentre algún nombre de campo a ajustar en la consulta de términos o en la subida.

**Filtro "Ver solo esta campaña" en modo API (2026-07-29):** para poder ser específico sobre en qué campaña negativizar en vez de trabajar siempre con toda la cuenta a la vez — filtra los términos, el resumen y la selección de negativos por campaña antes de decidir qué subir. Solo aparece en modo "Conectar Google Ads"; se resetea a "Todas" cada vez que se trae un nuevo reporte.

**Bug real: el filtro solo listaba campañas Search (2026-07-29).** cesar probó con una cuenta real y reportó que, igual que en Rendimiento, solo aparecían campañas Search. La causa acá es distinta a la de Rendimiento (ver Función 1): `search_term_view` es un recurso Search-only por diseño de Google — Performance Max/Demand Gen/Display no generan términos de búsqueda, así que no hay consulta que separar. Se le preguntó a cesar qué esperaba ver en vez de asumir; pidió que el filtro listara **todas** las campañas activas de la cuenta, no solo las que tienen términos. Se agregó un endpoint liviano (`GET /api/google-ads/campaign-list`, función `fetch_account_campaigns()`) que trae `campaign.id`/`campaign.name` de todos los tipos, sin pasar por `search_term_view` — el filtro ahora se arma con ese listado completo. Elegir una campaña sin términos (ej. una PMax) muestra "0 términos" correctamente, sin error. Verificado en modo simulado con 4 campañas activas (2 Search, 1 PMax, 1 Display): las 4 aparecen en el filtro.

**Corrección: sí existen términos de búsqueda para Performance Max, en un recurso distinto (2026-07-29).** cesar compartió un screenshot real de la UI de Google Ads mostrando el reporte "Search terms" de una campaña PMax (`Spiwak Chipechape - CO:es - PMAX`) con términos e impresiones reales — lo que contradecía la explicación anterior. Se validó contra esa cuenta real: `search_term_view` sigue en 0 filas para esa campaña (confirmado con consulta cruda), pero existe `campaign_search_term_insight`, que sí trae datos reales — 10 categorías con impresiones/clics que coinciden conceptualmente con la UI. Son **categorías** (Google agrupa búsquedas parecidas), no el término literal exacto — para búsquedas comunes suele coincidir 1:1, pero long-tail queda en un balde "(otros)" sin desglosar (en la prueba real: 530 impr/83 clics sin etiqueta, descartado por no ser un texto accionable). Tampoco trae costo (campo no soportado por ese recurso). Se agregó `fetch_pmax_search_term_insights()`, fusionado automáticamente en el reporte de términos cuando la cuenta tiene campañas PMax; en la tabla, estas filas se marcan "categoría PMax" con costo "N/D", y el ahorro estimado no las cuenta.

**Escritura de negativos confirmada también para PMax, contra la cuenta real (2026-07-29).** No estaba garantizado que Google aceptara un negativo de concordancia exacta sobre una campaña Performance Max — hay restricciones documentadas para este tipo de campaña. Con autorización explícita de cesar: vista previa (`validateOnly`) sin error, y luego una escritura real de un solo término de bajo riesgo (`"dann carlton cali"`, nombre de un hotel competidor) sobre esa misma campaña PMax — confirmado con una consulta a `campaign_criterion` que el negativo quedó `ENABLED` de verdad en la cuenta. Mismo `push_negative_keywords()` que ya existía, sin cambios de código.

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

**Comparar periodos (agregado 2026-07-14):** toggle "Análisis único" / "Comparar periodos" arriba de los filtros, mismo patrón visual que la Función 1. En este modo se suben dos exports de reservas (periodo actual y periodo anterior) y la app muestra, uno junto al otro: reservas totales, noches, promedio de noches por reserva y antelación promedio (con el cambio %), la tabla por mercado, la tabla de antelación por rangos, y dos heatmaps y dos distribuciones por día de semana — uno por periodo, reutilizando exactamente las mismas piezas visuales del modo único. Los filtros por mercado y hotel se aplican a ambos archivos antes de comparar. El modo "Análisis único" no cambió.

Pendiente: seguir validando el modo único con más cuentas de hotel reales, y probar el modo "Comparar periodos" con dos exports reales del mismo hotel (por ahora solo se probó con datos sintéticos).

### Función 5 — Comparar periodos (nueva, 2026-07-14)

Sección para ver tendencia, no solo la foto de un momento. Se suben dos exports de campañas (mismo formato de la Función 1) — periodo actual y periodo anterior, cualquier rango de fechas que el usuario quiera — y la app empareja las campañas por nombre exacto, mostrando el cambio % en gasto, CPA, CTR, conversiones, ROAS y valor de conversión, tanto por campaña como a nivel de cuenta.

Incluye recomendaciones por tendencia (distintas de las de umbral fijo de la Función 1): CPA subió más de 20%, CTR bajó más de 20%, conversiones cayeron más de 20%, o el gasto subió más de 30% sin que las conversiones acompañaran — pensadas para detectar una campaña que está empeorando rápido, antes de que cruce el umbral fijo de "CPA alto".

Campañas que solo existen en uno de los dos periodos (nuevas, pausadas, renombradas) se listan aparte en vez de forzar una comparación sin sentido. Se movió a segundo lugar en el menú, justo después de Rendimiento. También tiene **filtro por campaña** ("Ver solo esta campaña", 2026-07-14) — mismo patrón que el de Rendimiento — para ver el resumen, las recomendaciones y la tabla de una sola campaña sin volver a subir los archivos.

Verificada con datos sintéticos de dos periodos (botón "Usar ejemplo"). Pendiente: probarla con dos exports reales del mismo cliente.

**Conexión con la API de Google Ads (2026-07-29):** tercer lugar (después de Rendimiento y Negativización) con el toggle "Subir archivo" / "Conectar Google Ads". A diferencia de las otras dos funciones, acá hay **un solo selector de cuenta** (se compara la misma cuenta en dos rangos de fecha, no dos cuentas distintas) y **dos pares de fecha** — periodo actual y periodo anterior — con el periodo anterior precargado automáticamente al mismo número de días justo antes del periodo actual (ajustable a cualquier rango). Incluye el mismo checkbox "Solo campañas activas" que Rendimiento. Reutiliza `fetch_campaign_rows()` y `loadCampaignReportFromApi()` que ya existían — sin cambios de backend, solo se llama dos veces en paralelo (una por periodo).

**Filtro por tipo de campaña, nuevo para toda la función (2026-07-29):** a pedido de cesar, junto con la conexión a la API se agregó un segundo filtro — "Ver solo este tipo de campaña" (Search marca / Search genérica / Performance Max / Demand Gen / Display) — que agrupa todas las campañas de un mismo tipo y compara ese grupo entre los dos periodos, en vez de una campaña puntual. Usa la misma clasificación (`deriveCampaignType`) que ya alimenta los umbrales de CTR/CPA% de Rendimiento, así que funciona igual con datos de CSV o de API. Se agregó también el campo de palabras de marca (antes ausente en esta función — el CSV se cargaba siempre con la clasificación por defecto), visible solo en modo "Subir archivo", igual que en Rendimiento.

Verificado en modo simulado de punta a punta: selector de cuenta, ambos periodos con fechas por defecto correctas, filtro por campaña y por tipo recalculando correctamente (probado aislando solo Performance Max), y sin regresión en el modo CSV existente.

### Función 6 — Oportunidad de ingresos (nueva, 2026-07-14)

Sección para responder una pregunta concreta que cesar necesitaba llevar a la empresa: ¿cuántos ingresos adicionales se habrían generado si las campañas limitadas por presupuesto no lo hubieran estado? Es un análisis retrospectivo (no una predicción) — asume, para cada campaña, el mismo Ad Auction Win Rate y la misma tasa de conversión que ya tiene, y calcula qué habría pasado con impresiones/clics/conversiones/ingresos sin el límite de presupuesto.

La metodología viene de una referencia externa que trajo cesar (infografía "The Catalyst Tool", en Looker Studio) — antes de programar nada, se verificó fórmula por fórmula contra el ejemplo numérico de esa referencia (inversión $110.62M → $210M de ingresos perdidos / $33M de inversión extra necesaria / ROAS 632%), y el motor reproduce esos mismos números dentro del margen de redondeo del ejemplo.

Incluye:
- **Checkbox "Excluir campañas de marca"** (activado por defecto): el presupuesto extra a invertir se calcula con el ROAS promedio del conjunto de campañas seleccionado, no el de cada campaña por separado — y el ROAS de marca suele ser artificialmente alto, así que dejarlo adentro distorsiona el promedio de todo el cálculo.
- **Filtro por campaña** ("Ver solo esta campaña") y **filtro por hotel** — este último derivado del nombre de la campaña (el export de Google Ads no trae una columna de hotel), tomando el texto antes del primer " - "; solo aparece si el archivo trae más de un hotel.
- Tarjeta con el titular: ingresos perdidos, inversión extra necesaria, ROAS, y conversiones perdidas.
- Diagrama de embudo "de dónde venimos, a dónde podríamos llegar", comparando el escenario actual contra el escenario sin límite de presupuesto con los números reales de la cuenta.
- Gráfica de Impression Share por campaña (Impr. Share actual, % perdido por ranking, % perdido por presupuesto), ordenada de mayor a menor oportunidad.
- Tabla de acción ordenable por cualquier columna, con las columnas de Impression Share / % perdido por ranking / % perdido por presupuesto coloreadas como mapa de calor para ver de un vistazo dónde está la oportunidad más grande.

El parser de campañas (Función 1) ahora reconoce dos columnas nuevas del export de Google Ads: "Search Impr. Share" y "Bid Strategy Type" (esta última solo informativa, no entra en ningún cálculo).

Verificada con datos sintéticos y con el archivo real de Estelar: en ese archivo, solo las campañas Performance Max (que sí traen Search Impr. Share y Search Lost IS) entran al cálculo — la campaña Demand Gen, que no trae esas columnas, queda correctamente excluida en vez de mostrar un número inventado. Pendiente: probar con más cuentas reales, especialmente con más de una campaña limitada por presupuesto a la vez y con más de un hotel.

**Conexión con la API de Google Ads (2026-07-29):** cuarta y última función con el toggle "Subir archivo" / "Conectar Google Ads" — completa la integración iniciada en Rendimiento. Mismo patrón: selector de cuenta, rango de fechas, checkbox "Solo campañas activas". Sin cambios de backend, reutiliza `fetch_campaign_rows()` y `loadCampaignReportFromApi()` que ya existían. Verificado en modo simulado de punta a punta: el embudo, la gráfica de Impression Share y la tabla de acción calculan igual que con un CSV, incluida la campaña Performance Max con sus datos reales de Impression Share.

### Función 7 — Proyección de ventas (nueva, 2026-07-27)

Sección para proyectar ingresos futuros del hotel, a pedido de cesar. A diferencia de las otras seis funciones, no parte de un export de Google Ads — necesita un histórico mensual de ingresos reales del hotel (típicamente del PMS/sistema de reservas), con mínimo 12 meses y, idealmente, 24+.

Antes de construirla se le preguntó a cesar qué método prefería: una regresión lineal simple es fácil de explicar pero ignora la temporada alta/baja, que en hotelería suele pesar más que la tendencia. Se acordó **descomposición clásica multiplicativa** (tendencia + estacionalidad), sin depender de una librería de series de tiempo:
1. Regresión lineal (mínimos cuadrados) de ingresos contra el índice de tiempo → tendencia.
2. Para cada mes real, se calcula cuánto se desvía de la tendencia (ingreso real ÷ tendencia en ese punto).
3. Se promedian esas desviaciones por mes calendario (enero, febrero...) → índice de temporada de cada mes, normalizado para que el promedio de los 12 sea 1.
4. Proyección = tendencia extendida hacia adelante × índice de temporada del mes correspondiente.

Incluye:
- **Filtro por hotel** (si el archivo trae más de uno, con opción de sumarlos todos) y **selector de horizonte** (3 o 6 meses).
- Tarjetas de histórico analizado (cuántos meses y qué rango de fechas), tendencia estimada por año, calidad del ajuste (MAPE — error promedio mes a mes — y R²), y el total proyectado para el horizonte elegido.
- Un gráfico de líneas hecho en SVG puro (sin librería externa, mismo criterio del resto de la plataforma): ingreso real, ajuste del modelo (línea punteada, para validar visualmente qué tan bien el modelo explica el histórico), proyección futura y una banda de rango estimado.
- Tabla de proyección mensual (proyección, rango bajo, rango alto) descargable en CSV.
- Aviso automático cuando el histórico tiene menos de 24 meses o algún mes calendario tiene muy pocas observaciones, para no presentar el número como más preciso de lo que realmente es.

Verificada con un dataset sintético de 30 meses con estacionalidad marcada (temporada alta diciembre-marzo, baja septiembre-octubre, ~8-9% de crecimiento anual): el gráfico reprodujo visualmente la forma estacional y el ajuste dio MAPE 2.2% / R² 0.99 contra ese histórico sintético. Pendiente: probar con histórico real de un hotel, donde los datos rara vez son tan limpios como el sintético.

**Inversión necesaria para la venta proyectada (agregado 2026-07-27):** cesar pidió, además, saber cuánto hay que invertir para sostener esa venta proyectada. Antes de construir se aclaró que la inversión no es solo Google Ads (hay más canales pagados) y que los ingresos tampoco vienen de un solo canal de venta — por eso el cálculo no atribuye ingresos a un canal específico, usa un **ROAS combinado**: toda la inversión pagada ÷ todo el ingreso del hotel en los meses donde hay ambos datos (mínimo 3 meses en común), aplicado a cada mes proyectado. Es el método más simple de los dos evaluados (frente a un modelo de rendimientos decrecientes), elegido a propósito por ser explicable. Se activa con una segunda carga de archivo **opcional** (mes + inversión, cualquier canal, se suma sola) que solo aparece una vez hay una proyección de ventas lista; sin ese archivo, la función se comporta igual que antes. Agrega tarjetas de ROAS combinado histórico e inversión necesaria total, más una columna en la tabla y el CSV. Verificada con un dataset sintético de inversión (~510% de ROAS combinado) — el cálculo reprodujo ese ROAS y cada fila de la tabla es consistente (proyección ÷ inversión necesaria = ROAS combinado).

**Meta de crecimiento del gerente (agregado 2026-07-28):** campo opcional para responder "el gerente quiere crecer 20%, ¿qué significa eso en la data?". Se mide contra el mismo mes real del año anterior (confirmado con cesar antes de construir) — no contra la proyección del modelo, que sigue siendo "si nada cambia". Con el archivo de inversión ya cargado, también calcula cuánto habría que invertir para llegar a esa meta, con el mismo ROAS combinado. Se ve en el gráfico como una tercera línea (punteada, verde) que arranca del mismo punto que la proyección, y en dos columnas nuevas de la tabla/CSV. Si un mes del horizonte no tiene su mismo mes del año anterior en el histórico, queda como N/D en vez de inventar un número. Verificada con +20% sobre el dataset de ejemplo — consistente con el ROAS combinado ya validado.

## Por qué ninguna de las funciones de Google Ads usa un modelo de lenguaje por análisis

A 100+ cuentas, llamar a una API por cada archivo o URL tiene costo y latencia reales, y en el caso de negativización y copys implicaría que cada persona del equipo tenga su propia clave de API. Por eso la Función 2 compara contra términos núcleo/excepciones definidas por el usuario, y la Función 3 combina extracción real de la página con plantillas de copywriting de conversión. El costo de esta decisión: ninguna de las dos "entiende" el contenido como lo haría un modelo — solo detectan lo que ya se les definió o lo que literalmente está escrito en la página. Por eso ambas funciones piden revisión humana antes de publicar nada.

## Cómo corre la plataforma, y el login

**En producción:** `https://paid-media-helper.up.railway.app` — no depende de que la máquina de cesar esté prendida. Corre en [Railway](https://railway.app) con auto-deploy: cualquier cambio que llegue a la rama `main` del repo de GitHub se despliega solo. La base de datos (`data.db`, usuarios y sesiones) vive en un volumen persistente separado del código, así no se pierde en cada redeploy.

**En local (opcional, para desarrollo):**
```
cd webapp
python3 server.py
```
Abre `http://localhost:8642`.

En ambos casos, la app pide iniciar sesión o crear cuenta antes de dejar entrar. El registro es abierto (cualquiera con el link puede crear su cuenta), con contraseñas guardadas con hash + salt (nunca en texto plano), y sesión por cookie de 14 días — con el flag `Secure` activado en producción (solo se envía por HTTPS, que Railway provee automático).

**Ya expuesta en internet, no solo en red local/interna como antes** (2026-07-13/14): eso resuelve la advertencia de HTTPS que tenía esta sección — **sigue pendiente** decidir si el registro abierto continúa así o pasa a altas manuales, ahora que cualquiera con el link (no solo alguien en la red interna) puede crear una cuenta. Además, Rendimiento y Negativización procesan el archivo subido enteramente en el navegador (nunca tocan el servidor) — el login controla quién *entra* a la app, no hay una segunda barrera del lado del servidor para esas dos funciones específicas una vez que alguien ya la tiene abierta.

## Limitaciones conocidas

- El `sample_data.csv` de prueba no trae la columna real "Campaign type" de Google Ads, así que en ese archivo las campañas de Display/Performance Max caen por defecto en Search genérica — hay que confirmar con un export real que sí incluya esa columna.
- Las palabras de marca (Función 1) y los términos núcleo/excepciones (Función 2) se escriben en la pantalla cada vez que se sube un archivo — no se guardan por cuenta todavía (depende de la persistencia de Fase 2).
- "Estelar" como término núcleo (Función 2) es amplio — es una cadena con varias propiedades en Colombia, puede retener búsquedas de otro hotel Estelar.
- La Función 3 no ejecuta JavaScript: páginas que cargan su contenido dinámicamente van a dar poco texto real y el resultado se apoya más en plantillas genéricas.
- La Función 3 no valida las políticas de contenido de Google Ads (mayúsculas, superlativos, marcas de terceros) — solo longitud de caracteres.
- Ninguna de las siete funciones valida que el archivo/URL subido sea reciente ni de la cuenta correcta.
- **Control de acceso y despliegue: ya no están pendientes** (ver "Cómo corre la plataforma, y el login" arriba) — HTTPS resuelto por Railway; sigue pendiente decidir si el registro abierto continúa así ahora que la app es alcanzable por internet.
- No hay persistencia de historial entre cargas todavía para ninguna función (Fase 2) — la base de datos que ya existe solo guarda cuentas de usuario, no resultados de análisis. Las Funciones 4 (modo Comparar periodos) y 5 cubren parte de esta necesidad hoy, pero de forma manual (subiendo dos archivos cada vez).
- Falta comprar y conectar un dominio propio — hoy la app vive en el dominio genérico de Railway (`paid-media-helper.up.railway.app`).
- La Función 5 (Comparar periodos) solo se probó con datos sintéticos — falta validarla con dos exports reales del mismo cliente. Lo mismo aplica al modo "Comparar periodos" de la Función 4 (Bookings).
- La Función 6 (Oportunidad de ingresos) calcula el presupuesto extra necesario con el ROAS promedio del conjunto de campañas seleccionado — un promedio distorsionado (por ejemplo, por no excluir marca) cambia ese número; el checkbox "Excluir campañas de marca" mitiga esto pero depende de que el usuario lo revise.
- La Función 7 (Proyección de ventas) solo se probó con un dataset sintético — el índice de temporada se calcula sobre los datos que traiga el archivo, así que con menos de 24 meses de histórico real (o con meses atípicos, ej. una remodelación o un evento puntual) la proyección puede ser menos confiable de lo que sugiere el MAPE del ajuste histórico. No es un modelo estadístico riguroso (no es ARIMA/Holt-Winters) — es tendencia + estacionalidad simple, elegido a propósito por ser explicable.
- La conexión con la API de Google Ads (Función 1 y 2) solo está construida para Rendimiento y Negativización — Comparar periodos y Oportunidad de ingresos siguen dependiendo de subir un archivo.
- La **escritura** de negativos hacia Google Ads (Función 2) solo se probó en modo simulado — todavía no se probó la primera vez contra una cuenta real (ni siquiera en vista previa), así que es probable que aparezca algún ajuste de nombre de campo, igual que pasó en cada pieza de la integración de solo lectura.

## Próximos pasos

1. Repetir la carga de Función 1 con Click Clack Bogotá y con Estelar (ya corregidos los bugs de encabezado, UTF-16, filas "Total:" y columnas no reconocidas) y seguir con el resto de las 3-5 cuentas reales objetivo, comparando las recomendaciones contra el criterio de cesar como estratega.
2. Revisar a mano los 14 términos en "revisar" y los que solo contienen "estelar" antes de subir cualquier negativo real a la cuenta.
3. Función 3 en pausa: decidir para v2 si se retoma mejorando aún más las plantillas o si se cambia a generación real vía Claude API (con costo por llamada) — el enfoque de reglas ya recibió varias rondas de mejora y cesar decidió que el resultado no alcanza el estándar que necesita para v1.
4. Seguir validando la Función 4 (Bookings) con más cuentas de hotel reales, en ambos modos (único y Comparar periodos).
5. Probar la Función 5 (Comparar periodos) con dos exports reales del mismo cliente.
6. Probar la Función 6 (Oportunidad de ingresos) con más cuentas reales — ya validada con Estelar, falta confirmar con cuentas de más de una campaña limitada por presupuesto y más de un hotel.
7. Probar la Función 7 (Proyección de ventas) con histórico real de un hotel, y validar con cesar si el margen de error (MAPE) es aceptable para planear presupuesto.
8. Probar la escritura de negativos (Función 2) contra una cuenta real por primera vez — empezando por vista previa (`validateOnly`) en una campaña de bajo riesgo antes de confirmar cualquier subida real.
9. ~~Extender la conexión con la API de Google Ads a todas las funciones de campañas~~ — completado 2026-07-29 (Rendimiento, Negativización, Comparar periodos, Oportunidad de ingresos).
10. Decidir si el registro de usuarios sigue abierto o pasa a altas manuales, ahora que la app es alcanzable por internet.
11. Comprar y conectar un dominio propio para reemplazar el de Railway.

## Archivos del proyecto

| Archivo | Para qué sirve |
|---|---|
| `webapp/` | Implementación web completa (HTML/CSS/JS + servidor Python + `Dockerfile`), con login y las siete funciones (seis activas en el menú) — en producción en Railway, o local con `python3 webapp/server.py`. Ver `webapp/README.md` |
| `webapp/google_ads_client.py` | Cliente de la API de Google Ads (lectura de cuentas/campañas/términos de búsqueda, y escritura de negativos) — solo `urllib`, sin la librería oficial, para no agregar dependencias pip al servidor |
| `Especificacion_v1_Plataforma_Google_Ads.docx` | Especificación completa de las tres funciones originales de Google Ads: alcance, formato de archivo, mecanismo, arquitectura, riesgos |
| `app.py` | Interfaz Streamlit con las tres funciones (correr con `streamlit run app.py`) |
| `analysis.py` | Lógica de la Función 1 (rendimiento), reusable sin la interfaz |
| `negative_keywords.py` | Lógica de la Función 2 (negativización), reusable sin la interfaz |
| `copy_generator.py` | Lógica de la Función 3 (copys desde URL), reusable sin la interfaz |
| `sample_data.csv` | Datos de ejemplo para probar la Función 1 |
| `Negativos_Estelar_Playa_Manzanillo.xlsx` | Resultado real de la Función 2 para esa cuenta, listo para revisión |
| `requirements.txt` | Dependencias (`pip install -r requirements.txt`) |
| `Resumen_Proyecto.md` | Este resumen |
