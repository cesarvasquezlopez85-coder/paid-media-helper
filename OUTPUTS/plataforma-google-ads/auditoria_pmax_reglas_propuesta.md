# Auditoría de Performance Max — propuesta de reglas para hoteles

Estado: **primera versión construida (2026-10-12)**: P1, P1b, P2, P3, P5, P6, P7 y P12, ver la sección 7. El resto del documento es la propuesta original con tus ajustes (P9 en Info). Es un complemento de `auditoria_reglas_propuesta.md`: lo que ya cubre la auditoría general (conversiones, CPA % óptimo de PMax del 20%, campañas sin impresiones, recomendaciones automáticas) no se repite acá.

Cómo ajustar, igual que la vez anterior: edita **Gravedad** y **Umbral**, tacha lo que no quieras (o escribe "quitar") y agrega lo que falte. También puedes decirme por código ("quita P10, P8 pasa a Crítico, P2 con umbral 20").

Gravedades: **Crítico** resta 5 puntos, **Advertencia** resta 2, **Info** no resta (los mismos pesos de la auditoría general).

## 1. Cómo encajaría en la plataforma

- No sería una sección nueva: sería un área más, **"Performance Max"**, dentro de la misma Auditoría de cuenta, con su propio puntaje por área y sus tarjetas en el informe.
- Se activa sola: solo corre si la cuenta tiene campañas Performance Max activas en el periodo. Si no las tiene, no aparece nada.
- Es de solo lectura. Suma unas 5 consultas a Google Ads (solo cuando hay PMax) a las ~12 de la auditoría general.
- Las reglas marcadas **"Verificar"** se prueban primero contra una cuenta real con PMax, como pasó con las de la auditoría general (varios campos se rechazaron o no devolvían lo esperado).

## 2. Pregunta nueva del cuestionario (solo si hay PMax)

1. **¿Usas feed de Hotel Center con PMax?** Sí / No / No sé. Propuesta: con "Sí", las reglas de recursos creativos (P3, P5, P6) pasan a **Info**, porque en ese caso los anuncios salen en buena parte del feed y no de las imágenes o videos propios. Confirma si estás de acuerdo.

## 3. Reglas

### A. Medición y aprendizaje

| # | Regla | Gravedad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| P1 | La campaña puja por valor (Maximizar valor de conversión o ROAS objetivo) y la conversión no trae valor: no tiene qué optimizar | Crítico | conversiones > 0 y valor = 0 | métricas de campaña + estrategia | Seguro |
| P1b | La campaña puja por conversiones y no hay valor: no se puede medir ROAS ni priorizar reservas caras | Advertencia | igual | igual | Seguro |
| P2 | Muy pocas conversiones para que la puja aprenda | Advertencia | menos de 30 al mes por campaña (punto de partida, ajústalo a tu experiencia; Google no publica un mínimo estricto) | métricas | Seguro |
| P11 | Cambios frecuentes de presupuesto o de ROAS objetivo que reinician el aprendizaje | Advertencia | más de 3 cambios en 14 días | historial de cambios | Verificar (consulta costosa) |

### B. Recursos creativos y señales

| # | Regla | Gravedad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| P3 | Grupos de recursos con calidad "Pobre" o "Promedio" | Advertencia | calidad ≤ Promedio, con impresiones en el periodo | `asset_group.ad_strength` | Seguro |
| P4 | Muchos recursos con rendimiento "Bajo" | Advertencia | más del 30% de los recursos de un grupo | etiqueta de rendimiento de cada recurso | Seguro |
| P5 | No hay video propio: Google genera uno automático, normalmente flojo | Advertencia | 0 videos en el grupo | recursos del grupo | Seguro |
| P6 | Faltan formatos de imagen o textos | Advertencia | menos de 2 imágenes por formato (horizontal, cuadrada, vertical), menos de 5 títulos o menos de 4 descripciones | recursos del grupo | Seguro (confirmar los mínimos recomendados por Google) |
| P7 | El grupo no tiene señales: ni audiencias ni temas de búsqueda | Advertencia | 0 señales | `asset_group_signal` | Seguro |

### C. Marca y control del tráfico

| # | Regla | Gravedad | Umbral (editable) | Fuente | API |
|---|---|---|---|---|---|
| P9 | PMax canibaliza la marca: una parte importante de sus búsquedas son del nombre del hotel y la marca no está excluida | Info | más del 15% de las impresiones de las categorías de búsqueda contienen los términos de marca | categorías de búsqueda de PMax (ya se leen en Negativización) + exclusiones de marca de la campaña | Verificar (las exclusiones de marca) |
| P8 | Expansión de URL activada sin exclusiones: manda tráfico a páginas que no son de reserva | Advertencia | expansión activa y 0 exclusiones | ajustes de la campaña | Verificar campo |
| P10 | Parte del gasto va a Display y YouTube con CPA peor que Search | Info | solo informativo | reporte de ubicaciones de PMax | Verificar |
| P12 | Presupuesto limitando una PMax que sí rinde | Advertencia | pierde más del 15% por presupuesto y el ROAS o CPA va dentro de la meta | impression share perdido | Verificar si el campo vale para PMax |

## 3b. Cómo se complementa con la auditoría general

Mismo cuestionario, misma pantalla y mismo puntaje total; el área "Performance Max" solo aparece si hay campañas PMax activas.

**Qué ya cubre la general para PMax:** conversiones (A), campañas sin impresiones (C6), CPA % por tipo con el óptimo de 20% para PMax (G2) y recomendaciones que se aplican solas (F1).

**Qué no ve la general:** las reglas de redes y geografía (B) y de palabras clave y términos (D) son de Search, y C5 (presupuesto limitando campañas rentables) solo mira Search. Los recursos creativos, las señales y la marca dentro de PMax no los toca ninguna regla general: eso es lo que suma esta auditoría.

**Para no restar puntos dos veces por lo mismo:**

| General | PMax | Regla de no duplicar |
|---|---|---|
| A7 y A8: la reserva no trae valor | P1 y P1b: lo mismo, por campaña PMax | P1 y P1b solo aparecen si A7 y A8 no se activaron. Si ya salió A7 o A8, el informe nombra las PMax afectadas en su detalle, sin restar de nuevo. |
| C4: puja inteligente con pocas conversiones (Info) | P2: menos de 30 conversiones al mes | C4 excluye las campañas PMax y las deja a P2. |
| C5: presupuesto limitado en Search | P12: lo mismo en PMax | Sin solape: cada una cubre su tipo de campaña. |
| C1 y C2: campaña de marca y marca en las genéricas de Search | P9: marca dentro de PMax | Se complementan; P9 reutiliza los términos de marca del cuestionario. |

**En el informe:** un puntaje total con todas las áreas, el área "Performance Max" con su puntaje y sus tarjetas, y una lectura con IA que recibe los hallazgos de las dos auditorías y puede conectarlos (por ejemplo, recursos pobres en una campaña cuyo CPA % está por encima del óptimo).

## 4. Qué no cubre

- Los términos exactos de búsqueda de PMax: Google solo entrega categorías agrupadas y sin costo.
- Qué recurso concreto gana cada subasta.
- Hotel Ads y la calidad del feed de Hotel Center (otra API distinta).
- Comparar PMax contra Search en la misma cuenta (podría ser una segunda fase).

## 5. Puntaje y orden de construcción

- El puntaje del área "Performance Max" se calcula como el de las otras áreas: 100 menos 5 por crítico y 2 por advertencia, mínimo 0, y suma al puntaje total de la cuenta.
- **Primera versión:** P1, P1b, P2, P3, P5, P6, P7 y P12: son las más seguras de leer.
- **Después de probar con una cuenta real:** P9 (la más valiosa para hoteles), P8, P4 y P10.
- **Más adelante:** P11, porque la consulta es costosa.

## 6. Qué hay que validar antes de confiar en ella

- Los campos "Verificar" (P8, P9, P10, P11, P12) con una cuenta real que tenga PMax.
- Los umbrales de P2, P4, P6 y P9 en 3 o 4 hoteles que conozcas bien.

## 7. Estado de la construcción (2026-10-12)

Construidas en `webapp/account_audit.py` (reglas) y `fetch_audit_data` en `webapp/google_ads_client.py` (4 consultas extra, solo si hay PMax activas): **P1, P1b, P2, P3, P5, P6, P7 y P12**, con las reglas para no duplicar (P1 y P1b se omiten si A7 o A8 ya saltaron y nombran las PMax afectadas en su detalle; C4 ya no revisa las PMax). El área "Performance Max" aparece solo si hay PMax activas. La pregunta del feed de Hotel Center aparece en el cuestionario después de la primera auditoría, cuando se sabe que la cuenta tiene PMax; con "Sí", P3, P5 y P6 pasan a Info.

**Probado contra cuentas reales (solo lectura, Estelar Alto Prado y Estelar Apartamentos Bogotá):** las 4 consultas funcionan. Lo que se aprendió:
- `asset_group_asset.performance_label` no existe en la API v25 ("Unrecognized field"), así que **P4 (recursos con rendimiento bajo) no se puede construir como estaba pensada**; quedó fuera hasta encontrar otro campo equivalente.
- P12 sí funciona con PMax: la pérdida de impresiones por presupuesto llega en las campañas PMax.
- En las dos cuentas salieron hallazgos razonables (P12, P2, y en una P3 y P6).

**Pendiente:** P8, P9, P10 y P11 (los de "Verificar"), y revisar los umbrales de P2, P6 y P12 en 3 o 4 hoteles que conozcas bien.

## 8. Segunda entrega (2026-10-13): P9, P10 y P11

Construidas tras probar los campos contra cuentas reales con PMax (solo lectura). Suman 4 consultas más cuando hay PMax.

- **P9 (Info):** marca dentro de PMax. Lee las exclusiones de marca de la campaña (criterios `BRAND_LIST` con `negative`) y las categorías de búsqueda con sus impresiones. Aparece si más del 15% de las impresiones de categorías son de la marca y la campaña no tiene exclusión de marca. Necesita los términos de marca del cuestionario; sin ellos queda como no verificable. No resta puntos.
- **P10 (Info):** dónde se muestra PMax. Reparto de impresiones por tipo de ubicación (sitios web, apps móviles, YouTube, productos de Google). **La vista solo permite impresiones**: no trae costo, clics ni conversiones, así que no se puede comparar el CPA contra Search como se había pensado. No resta puntos.
- **P11 (Advertencia):** más de 3 cambios en 14 días de presupuesto o de puja (objetivo de ROAS o CPA, estrategia) por campaña PMax. Usa el historial de cambios de Google, que guarda 30 días como máximo; no se guarda quién hizo cada cambio.

**Siguen fuera:**
- **P4 original** (recursos con rendimiento bajo): la etiqueta de rendimiento no existe en la API v25. Se puede leer el estado de cada recurso (`primary_status`: elegible, rechazado, limitado), pero en las cuentas probadas todos estaban elegibles, así que no se confirmó cómo se ve uno rechazado. Si se hace, sería otra regla: "recursos rechazados o con servicio limitado".
- **P8 original** (expansión de URL sin exclusiones): el campo de expansión de URL no existe en la API v25. Lo más cercano es `campaign.asset_automation_settings` con el tipo `FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION` (activado o no), que controla los textos automáticos de las páginas de expansión, no la expansión misma. Si se hace, sería informativa y con ese nombre.

