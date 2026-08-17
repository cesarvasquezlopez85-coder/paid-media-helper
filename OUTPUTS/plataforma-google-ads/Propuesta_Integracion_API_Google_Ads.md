# Propuesta: Integración directa con la API de Google Ads

## Qué resuelve

Hoy, para usar Paid Media Helper, alguien tiene que entrar a Google Ads, exportar un CSV de campañas y subirlo a la plataforma — para cada cuenta, cada vez que se quiere ver el análisis. Con la API conectada, la plataforma trae los datos directo de Google Ads, sin ese paso manual. El análisis (CPA, CTR, presupuesto, ROAS, comparativa entre periodos) es el mismo que ya existe y ya está validado con cuentas reales — lo único que cambia es de dónde vienen los datos.

## Beneficio esperado

- Se elimina el paso de exportar/subir archivo por cuenta.
- Los datos están siempre actualizados al momento de abrir la plataforma, no depende de que alguien recuerde exportar y subir el archivo más reciente.
- Escala mejor a medida que crece el número de cuentas que maneja el equipo — hoy el cuello de botella es manual (una persona subiendo archivos, cuenta por cuenta).

## Qué implica construirlo

**Parte administrativa con Google (lo que más tiempo toma, no es desarrollo):**
1. Crear un proyecto en Google Cloud y generar credenciales de acceso (OAuth).
2. Solicitar un *developer token* a Google Ads, desde la cuenta administradora (MCC) de la agencia. Con esto, una sola autorización da acceso a todas las cuentas de cliente vinculadas a la MCC — no hay que pedirle permiso a cada cliente por separado.
3. Google revisa y aprueba la solicitud del developer token. Este tiempo no lo controla el equipo — puede tomar de días a un par de semanas, según el proceso de Google al momento de solicitarlo.

**Parte de desarrollo (lo que sí controla el equipo):**
- Conectar la plataforma a la API para traer los datos de campaña con el mismo formato que ya usan las funciones existentes — reutiliza el análisis ya construido y probado, no se reescribe nada de eso.
- Agregar un selector de cuenta y rango de fechas en la pantalla, en lugar del botón de subir archivo.

## Costo

La API de Google Ads no cobra por uso — solo tiene límites de cuota diarios (cantidad de consultas por día), que para el volumen actual de cuentas no debería ser un problema.

## Cuándo tiene sentido hacerlo

Vale la pena cuando subir archivos a mano para todas las cuentas se vuelva un cuello de botella operativo real. Hoy la plataforma ya funciona con exports manuales validados contra cuentas reales (Click Clack, Estelar) — la integración con la API es una mejora de eficiencia a futuro, no un bloqueo actual.

## Siguiente paso recomendado

Iniciar la parte administrativa (proyecto en Google Cloud + solicitud del developer token) ahora, en paralelo, ya que es lo que más tiempo toma y no depende de que el desarrollo esté listo primero. Mientras tanto, la plataforma sigue funcionando igual que hoy con la carga manual de archivos.
