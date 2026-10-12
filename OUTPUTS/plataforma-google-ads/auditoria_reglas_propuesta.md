# Auditoría de cuenta — propuesta de reglas para hoteles

Estado: **construida la primera versión (2026-10-11)**, ver la sección 8 al final. El resto del documento es la propuesta original con tus ajustes. Basada en la lista de revisiones de `AUDIT-TOOL.md`, pero adaptada a hoteles. Los umbrales son puntos de partida: cambia lo que no encaje con tu criterio de estratega y lo dejo así en la herramienta.

Cómo ajustar: edita la columna **Umbral** o **Severidad**, tacha las reglas que no quieras (o escribe "quitar"), y agrega las que falten.

Severidades: **Crítico** (pierde dinero o rompe la medición), **Advertencia** (conviene corregir), **Info** (se muestra, no resta puntos).

## 1. Cuestionario previo (se llena antes de auditar)

Solo quedan los campos que cambian el resultado de alguna regla (se quitaron tipo de propiedad, mercados e idiomas, cómo se reserva y la conversión que cuenta como reserva el 2026-10-12: ninguna regla los usaba o se podían deducir; la conversión de reserva se detecta sola).

1. Nombre del hotel (solo para el título del informe).
2. Términos de marca en las búsquedas, es decir el nombre del hotel (regla C2).
3. Palabras que marcan una campaña de marca en su nombre; por defecto `marca, brand, branded, brnd`, igual que en Rendimiento (reglas C1 y G2).
4. Meta principal: ROAS objetivo, CPA objetivo o volumen de reservas, con su valor (reglas A7, A8, C5 y G1).

## 2. Reglas

### A. Conversiones

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| A1 | No hay ninguna conversión primaria activa que sea la reserva | Crítico | — | `conversion_action` | Seguro |
| A2 | Cuenta con gasto y 0 conversiones en el periodo | Crítico | 30 días | métricas de campaña | Seguro |
| A3 | La conversión de reserva primaria no registra datos o tiene estado de seguimiento con problemas | Crítico | — | `conversion_action.status` y estado de seguimiento | Verificar campo |
| A4 | Más de una conversión primaria que cuenta lo mismo (por ejemplo, etiqueta propia + importación de GA4 para la misma reserva) | Crítico | misma categoría, más de 1 primaria | `conversion_action` | Seguro |
| A5 | Importación de GA4 o Universal Analytics marcada como primaria cuando ya hay etiqueta de Google Ads para la reserva | Crítico | — | `conversion_action.type` | Seguro |
| A6 | Microconversiones (clic en teléfono, WhatsApp, "ver disponibilidad") marcadas como primarias junto con la reserva: inflan las conversiones y bajan el CPA aparente | Crítico | — | `conversion_action.category`, `primary_for_goal` | Seguro |
| A7 | La reserva no trae valor y hay campañas con puja por ROAS o por valor de conversión | Crítico | — | `value_settings` | Seguro |
| A8 | La reserva no trae valor y las campañas pujan por conversiones | Advertencia | — | `value_settings` | Seguro |
| A9 | Conversiones mejoradas no activadas | Crítico | — | configuración de cliente | Verificar campo |
| A10 | Ventana de conversión menor a 30 días (la decisión de reserva suele ser larga) | Info | 30 días | `conversion_action` | Seguro |

### B. Segmentación y redes

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| B1 | **Segmentación geográfica "presencia o interés": solo informar, no penalizar.** En hoteles suele ser lo deseado (personas interesadas en el destino). El documento original la trata como error; aquí se invierte | Info | — | `campaign.geo_target_type_setting` | Seguro |
| B2 | Red de socios de búsqueda activa y con peor CPA que Google Search | Advertencia | socios > 10% del gasto y CPA > 1,3× el de Google Search | `segments.ad_network_type` | Seguro |
| B3 | Red de display activada dentro de una campaña Search | Crítico | — | `campaign.network_settings` | Seguro |
| B4 | Campaña sin idioma configurado o con idiomas que no coinciden con los mercados del cuestionario | Info | — | `campaign_criterion` de idioma | Seguro |

### C. Estructura y puja

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| C1 | No existe campaña de marca | Crítico | — | nombre de campaña + palabras de marca | Seguro |
| C2 | Búsquedas de la marca consumen gasto en campañas genéricas (se solapan con la de marca) | Advertencia | > 10% del gasto de las genéricas | `search_term_view` | Seguro |
| C3 | Campañas activas con puja "Maximizar clics" | Advertencia | — | `campaign.bidding_strategy_type` | Seguro |
| C4 | Puja inteligente en campañas con muy pocas conversiones | Info | < 15 conversiones al mes por campaña | métricas | Seguro |
| C5 | Campaña rentable que pierde impresiones por presupuesto (cruza con "Oportunidad de ingresos") | Advertencia | pierde > 15% por presupuesto y ROAS ≥ meta | `search_budget_lost_impression_share` | Seguro |
| C6 | Campañas activas sin impresiones en el periodo | Crítico | — | métricas | Seguro |
| C7 | Grupos de anuncios con muchas palabras clave | Info (no resta puntos) | > 20 palabras | `ad_group_criterion` | Seguro |

### D. Palabras clave y términos

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| D1 | Concordancia amplia con puja manual o sin puja inteligente (la amplia con puja inteligente no se penaliza) | Advertencia | > 30% del gasto en amplia | `keyword.match_type` + estrategia | Seguro |
| D2 | Porcentaje de gasto en concordancia exacta (informativo) | Info | — | `keyword.match_type` | Seguro |
| D3 | Gasto en términos que no convirtieron | Advertencia | > 15% del gasto de Search | `search_term_view` | Seguro |
| D4 | Faltan negativos de temas típicos de hotel: empleo y trabajo, gratis, alquiler a largo plazo, otros servicios que no ofreces. **Lista inicial editable** (abajo) | Advertencia | gasto en esos temas sin conversión > 3% del gasto | `search_term_view` + `campaign_criterion` | Seguro |
| D5 | Palabras clave con índice de calidad bajo y con gasto | Advertencia | QS ≤ 4 y gasto > 30 | `ad_group_criterion.quality_info` | Seguro |

Lista inicial de temas negativos (ajusta según mercado e idioma):
- Empleo: empleo, trabajo, vacantes, hoja de vida, convocatoria, job, jobs, career.
- Gratis: gratis, free, sin costo.
- Alquiler o vivienda de largo plazo: arriendo, alquiler de casa, apartamento en venta.
- Servicios que no ofrece el hotel (restaurante, spa, eventos) si no son parte de la campaña.

### E. Anuncios y activos

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| E3 | Falta el activo de ubicación (perfil de empresa), llamadas o enlaces de sitio | Advertencia | sitelinks < 4 | `campaign_asset`, `customer_asset` | Verificar |

### F. Automatización

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| F1 | Recomendaciones que se aplican solas y pueden subir presupuesto, pujas o añadir palabras amplias | Crítico | — | `recommendation_subscription` | Verificar recurso |
| F2 | Puntaje de optimización de Google (informativo) | Info | — | ya existe en la sección Recomendaciones | Seguro |

### G. Rendimiento contra la meta

| # | Regla | Severidad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| G1 | ROAS logrado por debajo de la meta del cuestionario | Advertencia | < 90% de la meta | métricas | Seguro |
| G2 | CPA % por encima del óptimo por tipo de campaña (mismos valores que Rendimiento: Search marca 11%, PMax 20%, Demand Gen 30%, Display 30%, Search genérica 30%) | Advertencia | > óptimo | métricas | Seguro |

## 3. Puntaje de salud

Se parte de 100: Crítico resta 10 por hallazgo, Advertencia resta 5, Info no resta. Mínimo 0. Si hay algún Crítico, el puntaje nunca se muestra como "sano" aunque dé alto. También se muestra el puntaje por área (conversiones, redes, estructura, palabras clave, anuncios, automatización), para ver dónde está el problema. Los pesos son propuestos: ajústalos.

## 4. Lectura con IA

Igual que en Rendimiento: la plataforma calcula los hallazgos y la IA los interpreta, no los reemplaza. Solo para administradores al inicio, con el mismo límite de uso por hora. Entrega 3 a 5 párrafos: qué corregir primero, qué hallazgos comparten una causa, y qué dejaría para después. No inventa datos que no vengan de la cuenta.

## 5. Informe descargable

- **HTML autocontenido**: un solo archivo que se abre en cualquier navegador y se guarda como PDF con Ctrl+P. Con nombre del hotel, fecha, periodo, puntaje, hallazgos por gravedad, tablas y la lectura de la IA.
- **Markdown**: el mismo contenido en texto, para pegar en un documento.
- No habría PDF generado en el servidor, porque necesitaría una librería externa y la plataforma usa solo la librería estándar de Python.

## 6. Fuera de la primera versión

- Hotel Ads y feeds de Hotel Center (otra API distinta).
- Auditar varias cuentas a la vez (choca con la cuota de Google).
- Enviar a Slack, programar auditorías mensuales, comparar contra el mes anterior.
- Aplicar correcciones desde la auditoría (la primera versión solo lee; las correcciones se hacen desde las secciones que ya existen).

## 7. Qué hay que validar antes de confiar en la primera versión

- Los campos marcados "Verificar" (A3, A9, E3, F1) con una cuenta real, como pasó con el resto de la integración.
- Que los umbrales den resultados razonables en 3 o 4 cuentas de hoteles que ya conoces bien.

## 8. Estado de la construcción (2026-10-11)

Construida la sección **Auditoría de cuenta** (menú, justo debajo de Rendimiento): cuestionario, selector de cuenta con filtro por MCC, resultados con puntaje por área, lectura con IA (solo admins) e informe descargable en HTML y Markdown. Código: `webapp/account_audit.py` (reglas), `fetch_audit_data` en `webapp/google_ads_client.py` (consultas, solo lectura) y la pantalla en `webapp/app.js`.

Pesos del puntaje aplicados: Crítico resta 10, Advertencia resta 5, Info no resta.

**Probado contra una cuenta real (solo lectura, Hotel Neptuno):** las 12 consultas funcionan. Lo que se aprendió:
- La consulta de activos de campaña exigía `campaign.status` en el SELECT; ya corregida.
- **A9 (conversiones mejoradas):** Google no devuelve por API si están activadas (omite el campo cuando está apagado), así que queda siempre como "no verificable" con la indicación de revisarlo a mano. No resta puntos.
- **F1:** además de los tipos que se esperaban, la cuenta real tenía activadas `RAISE_TARGET_CPA` y `LOWER_TARGET_ROAS` (ajustan solos el CPA o ROAS objetivo); se agregaron a la lista de riesgosos. En el informe salen con nombre en español.
- Las conversiones con estado `HIDDEN` (importaciones antiguas de Universal Analytics) no se evalúan, solo las `ENABLED`.
- **Marca:** el nombre del hotel suele estar en todos los nombres de campaña, así que el cuestionario separa dos campos: las palabras que marcan una campaña de marca (por defecto `marca, brand, branded, brnd`) y los términos de marca de las búsquedas (nombre del hotel).
- B4 (idiomas): en la cuenta real no devolvió ningún criterio de idioma; se deja como Info y conviene confirmar si "sin criterios" significa todos los idiomas.

Pendiente de probar con más cuentas: umbrales de D3, D4 y C5 en 3 o 4 hoteles que conozcas bien.

