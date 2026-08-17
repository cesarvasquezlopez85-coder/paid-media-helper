# Propuesta: Recomendaciones de optimización con Claude (IA)

## Qué resuelve

Hoy, la sección de Rendimiento genera recomendaciones con reglas de umbral fijo: si el CPA de una campaña supera el promedio de cuenta en más de 20%, se marca; si el CTR cae debajo de un mínimo por tipo de campaña, se marca; etc. Es rápido, gratis y confiable, pero solo detecta lo que esas reglas fueron diseñadas para ver — no interpreta el contexto completo de la cuenta ni conecta señales entre sí de la forma en que lo haría un estratega humano.

Conectar Claude permite agregar una capa de análisis que lee los datos de la cuenta como un todo y prioriza/explica hallazgos con más criterio — sin reemplazar el cálculo de métricas, que sigue siendo exacto y controlado por la plataforma.

## Cómo funcionaría

1. La plataforma sigue calculando las métricas reales de cada campaña igual que hoy (CPA, CTR, gasto, conversiones, impression share perdido, ROAS) — esto no cambia.
2. Esos números ya calculados se le envían a Claude junto con el contexto del negocio (agencia, cuentas de hotel, las mismas prioridades que ya usa la plataforma: CPA → presupuesto → CTR → ranking).
3. Claude interpreta y prioriza — no inventa ni recalcula cifras, solo trabaja sobre los números reales que ya se le entregan. Esto es clave para que el análisis siga siendo confiable.
4. El resultado se muestra en el mismo formato de tarjeta de recomendación que ya existe hoy, para que la experiencia se sienta igual — solo que más completa.

## Qué se necesita para construirlo

- Una llave de API de Anthropic, guardada del lado del servidor (nunca visible en el navegador) — mismo patrón de seguridad que ya usa la plataforma para otras funciones.
- Un endpoint nuevo que arme la consulta a Claude con los datos reales de la cuenta.
- Un botón "Analizar con IA" para disparar el análisis cuando se quiera, en vez de que corra automático en cada carga — así se controla el costo a medida que crece el número de cuentas.

No requiere aprobación de un tercero (a diferencia de la integración con la API de Google Ads) — es una llave de API que se puede activar directamente.

## Costo

Se paga por uso (no es gratis como el motor de reglas actual). Con el modelo recomendado (Claude Opus 4.8), analizar el reporte típico de una cuenta (10-50 campañas) cuesta probablemente centavos de dólar por análisis — el costo total depende de cuántas veces se use, no es una tarifa fija mensual.

## Cómo se complementa con la integración de la API de Google Ads

Son dos piezas independientes que se potencian juntas:

- **Solo Claude** (sin la API de Google Ads): análisis inteligente bajo demanda sobre el archivo que ya se subió a mano — mejora la calidad de las recomendaciones, pero sigue dependiendo de subir un CSV.
- **Solo la API de Google Ads** (sin Claude): datos siempre frescos, pero las recomendaciones se siguen generando con las reglas de umbral fijo de hoy.
- **Las dos juntas:** datos frescos directo de Google Ads + análisis inteligente sobre esos datos — esto es lo más cercano a "optimización en tiempo real".

## Cuándo tiene sentido hacerlo

Es una mejora de calidad de las recomendaciones, no un bloqueo actual — la plataforma ya funciona y ya está validada con cuentas reales usando el motor de reglas. Vale la pena evaluarlo cuando el equipo sienta que las reglas fijas se están quedando cortas frente a casos reales, o cuando ya esté lista la integración con la API de Google Ads y se quiera dar el siguiente paso hacia análisis más completo.
