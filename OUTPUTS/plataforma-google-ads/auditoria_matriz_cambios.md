# Matriz de cambios a las reglas existentes

Fuente: sección 4 de `Propuesta_viabilidad_auditoria_Google_Ads_hoteles.docx` (21 filas). Estado: **las 21 filas decididas** (2026-10-13). Además se pidió construir B5 y B6 (sección al final). **Implementado y probado en local y en solo lectura contra cuentas reales (2026-10-13); pendiente de publicar.** Quedan 44 reglas (antes 41): se quita D1, E3 se separa en E3, E4 y E5, y se suman B5 y B6.

Cómo usarla: en la última columna escribe **Aceptar**, **Ajustar** (con lo que cambias) o **Descartar**. También puedes decírmelo por número ("1 aceptar, 3 ajustar a Info, 9 descartar"). La columna "Recomiendo" es mi sugerencia, no una decisión.

Las filas 3, 8, 9, 10, 11, 17, 18 y 21 son las que cambian de verdad el puntaje o el criterio; el resto son ajustes de texto, de datos o de forma.

| # | Regla(s) | Hoy en la plataforma | Cambio propuesto en el documento | Viabilidad técnica | Recomiendo | Tu decisión |
|---|---|---|---|---|---|---|
| 1 | A1–A6 | Todas Crítico. La conversión de reserva se detecta sola (primaria activa de compra, reserva o formulario con más conversiones). | Mantener; revisar duplicados y cómo se identifica la conversión de reserva. | Viable. Para no pedir de nuevo la pregunta que quitaste, mostrar en el informe qué conversión se detectó como reserva para que el estratega la valide. | **Ajustar:** mantener y mostrar la conversión detectada, sin pregunta obligatoria. | Ajustar (mi recomendación): mantener y mostrar la conversión detectada |
| 2 | A7–A8 / P1–P1b | A7 Crítico, A8, P1b Advertencia, P1 Crítico, ya sin duplicarse entre sí. | Mantener; explicar el efecto sobre la optimización. | Viable; solo texto. | **Aceptar** (agregar la explicación al detalle). | Aceptar |
| 3 | A9 | Crítico cuando el cuestionario dice "No". | Bajar de Crítico a Advertencia o Info según contexto. | Viable; es un cambio de gravedad. | **Aceptar → Advertencia:** la ausencia de conversiones mejoradas no prueba que la medición esté rota. | Descartar: A9 se queda en Crítico |
| 4 | A10 | Informativa; muestra la ventana cuando es menor de 30 días y no resta. | No penalizar; mostrar la ventana y recomendar validar el ciclo de decisión. | Ya cumple. | **Aceptar** (solo ajustar el texto para decir "validar si cubre el ciclo"). | Aceptar (mi recomendación): ajustar el texto |
| 5 | B1 | Informativa. | Mantener y explicar la configuración. | Ya cumple. | **Aceptar** | Aceptar (mi recomendación) |
| 6 | B2 | Advertencia si la red de socios gasta más del 10% y su CPA es 1,3 veces el de Google Search. Sin mínimo de muestra. | Mantener solo con volumen razonable; mostrar gasto, conversiones y CPA por red. | Viable: se agrega un mínimo (por ejemplo 30 clics en socios) y una tabla por red con los datos que ya se leen. | **Aceptar** con mínimo de muestra editable. | Aceptar (mi recomendación): mínimo de muestra editable |
| 7 | B3 | Crítico. | Mantener como Crítico o Advertencia alta según configuración y objetivo. | Viable. | **Mantener Crítico**; no veo una configuración que lo justifique distinto. | Mantener en Crítico (mi recomendación) |
| 8 | C1 | Crítico si ninguna campaña activa trae "marca, brand, branded, brnd" en el nombre. | Cambiar a "no se identifica una estrategia de protección de marca": el nombre no prueba la función. | Viable: además del nombre, buscar palabras clave de marca (con los términos de marca del cuestionario) en cualquier campaña. Si no hay términos de marca, queda no verificable. | **Aceptar → Advertencia**, y solo si no hay campaña con la marca en el nombre ni palabras clave de marca. | Aceptar (mi recomendación): Advertencia, mirando también las palabras clave |
| 9 | C3–C4 | C3 Advertencia (Maximizar clics), C4 Informativa. | No tratar Maximizar clics ni un mínimo fijo de conversiones como error automático. | Viable. | **Aceptar:** C3 pasa a Info; solo sube a Advertencia si la meta es CPA o ROAS y la campaña tiene conversiones. C4 se queda en Info. | Aceptar (mi recomendación): C3 pasa a Info |
| 10 | C5 / P12 | Advertencia si la campaña rentable pierde más del 15% por presupuesto (sin meta, basta con tener conversiones). | Mostrarlo como oportunidad de escala solo si cumple la meta; no restar puntos (regla 4 de la sección 7). | Viable; es un cambio de clasificación. | **Aceptar:** pasa a "Oportunidad" y deja de restar puntos. | Aceptar (mi recomendación): pasa a Oportunidad y no resta |
| 11 | C6 | Crítico: campañas activas sin impresiones en el periodo (las pausadas ya no cuentan). | Excluir recién creadas, pausadas o fuera de periodo. | Parcial: pausadas ya se excluyen. Para "recién creadas", el campo de fecha de inicio que probé no existe en la API actual; hay que encontrar otro (estado de servicio o fecha de creación) y confirmarlo. | **Aceptar, con verificación del campo.** Mientras tanto, bajarla a Advertencia. | Aceptar (mi recomendación): con verificación del campo; mientras tanto, Advertencia |
| 12 | D1 | Advertencia si más del 30% del gasto en palabras clave va a amplia sin puja inteligente. | Evaluarla junto con estrategia, volumen y calidad de términos. | Parcial: se agrega un gasto mínimo y se muestran las palabras. Evaluar la calidad de los términos de cada palabra requiere cruzar con los términos de búsqueda, más costoso. | **Aceptar** con gasto mínimo; la calidad de términos, para después. | Quitar la regla D1 |
| 13 | D4 | Advertencia: temas fijos en el código (empleo, gratis, alquiler de larga estadía). | Hacer los temas configurables por tipo de hotel. | Viable: lista editable en el cuestionario, con esos tres temas por defecto. Hace falta agregar el campo a la pantalla. | **Aceptar** | Aceptar (mi recomendación): temas editables |
| 14 | D5 | Advertencia: índice de calidad de 4 o menos y más de 30 de gasto. | Contextualizar por gasto, impresiones y volumen. | Viable: umbral relativo (por ejemplo más del 1% del gasto de Search) y mostrar impresiones. | **Aceptar** | Aceptar (mi recomendación) |
| 15 | E3 | Un solo hallazgo, Advertencia, con enlaces de sitio, llamada y ubicación juntos. | Separarlos en controles independientes. | Viable. | **Aceptar:** enlaces de sitio y ubicación en Advertencia, llamada en Info. | Aceptar (mi recomendación): tres reglas separadas |
| 16 | F1 | Crítico si hay recomendaciones riesgosas habilitadas. | Identificar cuáles están habilitadas y cuáles se aplicaron; evaluar el tipo de cambio. | Parcial: "habilitadas" ya se lee; "aplicadas" podría salir del historial de cambios (indica el origen), pero en la cuenta de prueba no apareció ninguna aplicada por recomendaciones, así que no está confirmado. | **Aceptar por partes:** listar cada tipo con su riesgo (alto o medio), y "aplicadas" cuando se confirme. | Aceptar por partes (mi recomendación) |
| 17 | P2 | Advertencia: menos de 30 conversiones al mes. | Presentarlo como contexto, no como requisito. | Viable. | **Aceptar → Info.** | Aceptar (mi recomendación): P2 pasa a Info |
| 18 | P3 / P5 / P6 / P7 | Advertencia (Info si usa feed de Hotel Center). | Separar calidad, cantidad, video y señales; clasificarlos en general como oportunidades. | Viable. | **Aceptar → Info** para P5, P6 y P7. P3 "Pobre" se queda en Advertencia. | Aceptar (mi recomendación): P5, P6 y P7 a Info; P3 Pobre en Advertencia |
| 19 | P9 | Informativa, con la proporción por campaña. | Mantener y mostrar la proporción. | Ya cumple. | **Aceptar** | Aceptar |
| 20 | P11 | Advertencia: más de 3 cambios en 14 días. El texto dice que puede reiniciar el aprendizaje. | Medir frecuencia y magnitud sin afirmar que todo cambio reinicia el aprendizaje. | Parcial: frecuencia ya sale. La magnitud (cuánto cambió) requiere comparar el valor antes y después, que el historial podría entregar; no lo he probado. | **Aceptar:** ajustar el texto y pasar a Info; la magnitud, después de probar. | Aceptar (mi recomendación): texto ajustado, pasa a Info; la magnitud, después |
| 21 | G1–G2 | G1 Advertencia contra la meta del cuestionario (ROAS menor al 90% o CPA mayor al 110%). G2 Advertencia con óptimos fijos de CPA % por tipo (marca 11%, PMax 20%, resto 30%). | Usar metas declaradas por cuenta o campaña; no imponer porcentajes universales por tipo. | Parcial: G1 ya usa la meta declarada. Quitar G2 es fácil. Metas por campaña piden un campo por campaña en la pantalla, más trabajo. | **Aceptar:** G2 deja de restar (se queda como Info o se retira); G1 se queda; metas por campaña, en una fase posterior. | Aceptar (mi recomendación): G2 deja de restar; G1 se queda; metas por campaña, después |

## Efecto en el puntaje si se aceptan mis recomendaciones

Hoy una cuenta de ejemplo con muchos problemas queda en 54 puntos. Con mis recomendaciones, A9, C1, C3, C5, P12, P2, P5, P6, P7, P11 y G2 dejarían de restar o restarían menos, así que los puntajes subirían y los Críticos que quedarían serían los de medición y configuración (A1 a A7, B3, F1 y P1), que es el sentido del documento: que los puntos bajen por problemas de medición y no por estilo de campaña.

Si además se adopta la puntuación ponderada por áreas de la sección 7, los números cambian otra vez; esa decisión va aparte, después de esta matriz.

## Reglas nuevas pedidas (de la sección 5 del documento)

| Código | Qué hace | Gravedad | Umbral | Fuente | Probado |
|---|---|---|---|---|---|
| B5 | Rendimiento por país: gasto, clics, conversiones, CPA y valor | Info (no resta) | tabla con los países que suman al menos el 1% del gasto | `geographic_view` + `geo_target_constant` | Sí, cuenta real, solo lectura |
| B6 | País con gasto y sin conversiones | Advertencia | al menos 3% del gasto y 30 clics, con 0 conversiones | igual | Sí: en la cuenta de prueba salió Estados Unidos con 28 clics y 0 conversiones |

B5 solo muestra los datos y B6 marca el problema, para no restar dos veces por lo mismo. Si la cuenta no tiene conversiones en todo el periodo, B6 no aparece (ya lo cubre A2).

## Cómo quedó construido

- **A1–A6:** se mantienen en Crítico; el informe muestra la conversión que se tomó como reserva. A7/A8 explican el efecto en la optimización. A10 pide validar el ciclo de decisión.
- **A9** se queda en Crítico (decisión 3).
- **B2:** mínimo de 30 clics en socios y tabla Google Search contra socios.
- **C1:** Advertencia, solo si no hay campaña de marca por nombre ni palabras clave con los términos de marca; sin términos de marca queda no verificable.
- **C3:** Info; Advertencia solo con meta CPA/ROAS y conversiones. **C5 y P12:** "Oportunidad", Info, no restan.
- **C6:** Advertencia; no cuenta las campañas con menos de 14 días (campo `campaign.start_date_time`, confirmado en la API).
- **D1:** retirada. **D4:** temas editables en el cuestionario. **D5:** umbral relativo (1% del gasto de Search) y muestra impresiones.
- **E3/E4/E5:** enlaces de sitio y ubicación en Advertencia, llamada en Info.
- **F1:** lista cada tipo con su riesgo (alto o medio); Crítico si hay alguno de riesgo alto, Advertencia si solo hay de riesgo medio. "Aplicadas" queda pendiente de confirmar.
- **P2, P5, P6, P7, P11:** Info. **P3:** Advertencia solo si hay grupos "Pobre", si no Info. **P9** igual. **G1** igual; **G2** Info sin restar.
- **B5 y B6** nuevas (ver sección anterior).

## Otras reglas del documento que se pueden construir (evaluación)

Probadas con la API real: B8 (dispositivo), C9 (pérdida por ranking), P13 (rendimiento por grupo de recursos), D6/D9 (clics y CTR por palabra clave), G5 (periodo anterior). Sin consulta nueva: B7, G6, P15, E4 visual.
