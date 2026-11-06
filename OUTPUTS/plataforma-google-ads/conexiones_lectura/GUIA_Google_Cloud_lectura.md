# Conectar GA4, Tag Manager, Search Console y BigQuery (solo lectura)

Esta guía deja listo el acceso de **solo lectura** de Paid Media Helper a Google Analytics 4,
Google Tag Manager, Search Console y BigQuery. Es una credencial **aparte** de la de Google
Ads: si algo saliera mal, se revoca sin tocar las cuentas de anuncios.

Todo lo que ejecuta el script está en `autorizar_google_lectura.py` (en esta misma carpeta).
Solo usa Python estándar y no escribe ninguna clave en el repositorio.

## Qué necesitas antes de empezar

- La **cuenta de Google** que ve los GA4, GTM, Search Console y BigQuery de los clientes (si
  usas una distinta, la comprobación solo mostrará lo que esa cuenta pueda ver).
- Poder **crear un proyecto y credenciales** en Google Cloud.
- Una terminal en la carpeta del proyecto con la CLI de Railway vinculada (`railway status`
  debe responder). Sirve para guardar las claves sin escribirlas en ningún archivo.

> **No pegues el ID ni el secreto del cliente en ningún chat, correo o repositorio.** El script
> los pide en tu terminal y el secreto no se muestra al escribirlo.

## Paso 1 · Un proyecto de Google Cloud

1. Entra en <https://console.cloud.google.com/>.
2. En el selector de proyectos (arriba a la izquierda) elige **Proyecto nuevo**.
3. Nómbralo, por ejemplo, `pmh-lectura`. Se recomienda un proyecto **distinto** del que usa
   Google Ads, para que cada acceso quede aislado.

## Paso 2 · Activar las 5 APIs

Con el proyecto nuevo seleccionado, abre cada enlace y pulsa **Habilitar**:

| API | Enlace |
|---|---|
| Google Analytics Admin API | <https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com> |
| Google Analytics Data API | <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com> |
| Tag Manager API | <https://console.cloud.google.com/apis/library/tagmanager.googleapis.com> |
| Google Search Console API | <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> |
| BigQuery API | <https://console.cloud.google.com/apis/library/bigquery.googleapis.com> |

Si olvidas alguna, el script te lo dice y te da el enlace exacto para activarla.

## Paso 3 · Pantalla de consentimiento de OAuth

En **APIs y servicios → Pantalla de consentimiento de OAuth** (o *Google Auth platform*):

1. **Tipo de usuario:**
   - **Interno**, si todas las personas que usarán esto están en el mismo Google Workspace
     (por ejemplo, el de Roiback). Es lo mejor: sin avisos y sin caducidad.
   - **Externo**, si no. Entonces, en el último paso, pulsa **Publicar la aplicación** (estado
     *En producción*). **Si la dejas en *Pruebas*, el acceso caduca a los 7 días** y habría que
     repetir todo cada semana.
2. Ponle un nombre (por ejemplo, `Paid Media Helper lectura`) y tu correo de soporte.
3. En **Acceso a los datos / Ámbitos**, añade estos cuatro, todos de lectura:
   - `.../auth/analytics.readonly`
   - `.../auth/tagmanager.readonly`
   - `.../auth/webmasters.readonly`
   - `.../auth/bigquery.readonly`
4. Si es Externo y no está verificada por Google, al autorizar verás el aviso *"Google no ha
   verificado esta aplicación"*. Para un uso interno de pocas personas es esperable: pulsa
   *Configuración avanzada → Ir a (nombre de la app)*.

## Paso 4 · Crear la credencial

1. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**.
2. **Tipo de aplicación: Aplicación de escritorio** (importante: con otro tipo, el script falla
   con `redirect_uri_mismatch`).
3. Ponle un nombre y créala. Google muestra el **ID de cliente** y el **secreto**: guárdalos un
   momento en tu gestor de contraseñas. Los vas a necesitar en el paso siguiente.

## Paso 5 · Ejecutar el script

```bash
cd "/Users/cessvasquez/PLATAFORMA INTERNA GOOGLE ADS"
python3 OUTPUTS/plataforma-google-ads/conexiones_lectura/autorizar_google_lectura.py
```

Opciones útiles: `--sin-bigquery`, `--sin-gtm`, `--sin-gsc` (para no pedir ese permiso) y
`--servicio NOMBRE` (si el proyecto de Railway tiene más de un servicio).

Qué verás, en orden:

1. La lista de permisos que va a pedir (todos terminan en `.readonly`).
2. Te pide el **ID de cliente** y el **secreto** (este último sin mostrarse al escribir).
3. Se abre el navegador. **Elige la cuenta correcta** y acepta. Google puede dejarte marcar o
   desmarcar cada permiso por separado: **déjalos los cuatro marcados** (si falta alguno, el
   script lo avisa).
4. En la terminal aparece **qué se ve** con esa cuenta, por ejemplo:

   ```
   GA4            3 cuenta(s) y 87 propiedad(es) de GA4
   Tag Manager    5 cuenta(s) de Tag Manager
   Search Console 64 sitio(s) de Search Console
   BigQuery       2 proyecto(s) de BigQuery visibles
   ```

5. Guarda un **inventario** (sin claves) en `~/.pmh_lectura/inventario.json`, con permisos
   solo para ti. Sirve para emparejar cuentas más adelante. **No lo subas al repositorio.**
6. Te pregunta si guarda las tres credenciales como **variables de Railway**
   (`GOOGLE_READ_CLIENT_ID`, `GOOGLE_READ_CLIENT_SECRET`, `GOOGLE_READ_REFRESH_TOKEN`).
   Responde `s`. Se guardan **sin reiniciar el servicio** y sin que el valor aparezca en la
   lista de procesos. Si respondes que no, te ofrece un archivo local protegido, que debes
   borrar en cuanto pases las claves a Railway.

## Paso 6 · Avísame

Cuando termine, escríbeme **"ya autoricé"**, sin pegar nada. Con eso puedo:

- repetir la comprobación con lo guardado (`railway run python3 .../autorizar_google_lectura.py --probar`),
- leer el inventario y proponerte el emparejamiento entre cuentas de Google Ads y propiedades
  de GA4, contenedores de GTM y sitios de Search Console.

## Seguridad

- **Solo lectura.** Los cuatro permisos terminan en `.readonly`: la plataforma no puede
  modificar nada en esas herramientas.
- **Credencial aparte** de Google Ads, con su propio cliente OAuth.
- **Revocar el acceso:** `railway run python3 .../autorizar_google_lectura.py --revocar`, o desde
  <https://myaccount.google.com/permissions> (busca el nombre de la app). Después borra las tres
  variables en Railway (`railway variable delete NOMBRE`) y, si quieres, el cliente OAuth en
  Google Cloud.
- Si crees que se expuso alguna clave: revoca, borra el cliente OAuth y crea otro.
- Esta credencial ve lo mismo que la cuenta con la que autorizas. Usa una cuenta con acceso
  de **lectura**, no de administrador, si puedes.

## Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `redirect_uri_mismatch` | El cliente no es de tipo "Aplicación de escritorio" | Crea uno nuevo de ese tipo (paso 4) |
| `access_denied` | La cuenta no es usuario de prueba, o rechazaste | Si la app está en *Pruebas*, añade tu cuenta como usuario de prueba, o publícala |
| "Google no devolvió un refresh token" | Ya habías autorizado antes con ese cliente | Quita el acceso en <https://myaccount.google.com/permissions> y repite |
| "API desactivada en el proyecto" | Falta habilitar una API | El script imprime el enlace exacto |
| "falta el permiso en la autorización" | Desmarcaste un permiso en Google | Repite y deja los cuatro marcados |
| 0 propiedades de GA4 | La cuenta no tiene acceso a los GA4 | Autoriza con otra cuenta o pide acceso de lectura a los clientes |
| `invalid_grant` pasados unos días | La pantalla de consentimiento está en *Pruebas* | Publícala o hazla *Interna* (paso 3) y repite |

## Lo que viene después

Con el acceso listo: emparejar cuentas de Google Ads con propiedades de GA4 (con tu
confirmación), la sección **Medición** y la primera comparación entre las conversiones de
Google Ads y las reservas de GA4. BigQuery se usaría cuando una cuenta tenga activa la
exportación de GA4 o de Google Ads.
