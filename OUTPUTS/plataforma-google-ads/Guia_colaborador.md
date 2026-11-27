# Guía para trabajar el proyecto desde una segunda cuenta de Claude

Para cuando la misma persona gestiona Paid Media Helper desde dos cuentas de Claude (por ejemplo, la personal y la empresarial), o cuando alguien más se suma como colaborador. Lo esencial es que **cada cuenta de Claude es independiente y no comparte nada con la otra**: ni conversaciones, ni memoria de Claude, ni sesiones. Lo que las une es el repositorio, Railway y las credenciales de Google, así que ahí hay que dejar todo ordenado.

Este repositorio es público: esta guía no lleva claves, códigos ni IDs de clientes.

## 1. Qué se comparte y qué no

| Qué | ¿Pasa solo a la otra cuenta? | Cómo se resuelve |
|---|---|---|
| Código y documentación | Sí, viven en GitHub | `git clone` / `git pull` |
| Reglas del proyecto para Claude | Sí, están en `CLAUDE.md` | Claude Code lo lee al abrir la carpeta |
| Memoria de Claude (preferencias, decisiones, estado) | **No**, es local de cada instalación y se busca por la **ruta de la carpeta del proyecto** | Mismo computador, mismo usuario y misma carpeta: ya está. Otro computador, otro usuario del sistema u otra ruta: hay que copiarla a mano con el nombre de carpeta equivalente (sección 2b). No la subas al repo, tiene datos de clientes |
| Historial de conversaciones | **No** viaja entre cuentas ni computadores | `CLAUDE.md`, `Resumen_Proyecto.md` («Cómo retomar el proyecto») y `roadmap.md` («Estado al 2026-11-27 y pendientes») reemplazan lo importante. En el mismo computador ver la sección 2b |
| Plugins, skills y conectores de Claude (Google Drive, Gmail, etc.) | **No**, pertenecen a la cuenta u organización de Claude | Volver a conectarlos en la cuenta nueva si la empresa lo permite; el proyecto funciona sin ellos |
| Permisos ya aprobados en Claude Code (`.claude/settings.local.json`) | **No**, el archivo está en `.gitignore` | Claude volverá a pedir permiso al principio; es normal. `.claude/launch.json` sí está en el repo |
| Variables y secretos | No | Las ve cada identidad en Railway; nunca por chat ni en archivos |
| Accesos a Google y Railway | Dependen de la identidad con la que inicies sesión | Ver sección 2 |

## 2. Accesos que hay que configurar para la segunda cuenta

Si la cuenta empresarial usa **otro correo** que la personal, esa identidad necesita acceso propio en cada servicio. Si usa el mismo correo de Google y GitHub, solo hay que iniciar sesión.

- **GitHub:** invitar la identidad como colaboradora del repositorio (`paid-media-helper`) con permiso de escritura, y configurar `git config user.name` y `user.email` en ese computador para que los commits queden bien atribuidos.
- **Railway:** invitarla al proyecto como miembro del equipo; así `railway login` y `railway link` funcionan y puede ver variables, despliegues y logs.
- **Google Ads y Google Cloud:** solo hace falta acceso si esa identidad va a entrar a las consolas. La plataforma funciona con el refresh token ya guardado en Railway, no con la cuenta de quien programa.
- **Anthropic (consola):** la clave que usa la IA de la plataforma es independiente de la suscripción de Claude Code. No se cambia.
- **La plataforma:** una cuenta de usuario con rol de administrador (y super admin si va a tocar Hoteles, Campañas o Audiencias; se define con `PMH_SUPER_ADMIN_USERNAMES`).

## 2b. Al cambiar de cuenta de Claude: qué revisar para que no se pierda nada

1. **La memoria se busca por la carpeta.** Claude guarda la memoria de un proyecto en `~/.claude/projects/<ruta de la carpeta con las barras y los espacios cambiados por guiones>/memory/`. Para este proyecto el nombre de esa carpeta es `-Users-<usuario>-PLATAFORMA-INTERNA-GOOGLE-ADS`. Si el proyecto queda en otra ruta, en otro computador o con otro usuario del sistema, Claude abre una memoria vacía aunque la anterior siga en el disco. Solución: copiar la carpeta `memory/` a la carpeta con el nombre que corresponde a la ruta nueva (abre Claude Code una vez en el proyecto para que cree esa carpeta y luego copia dentro). Para un respaldo, comprime la carpeta `memory/` completa (`tar -czf respaldo.tar.gz -C <carpeta del proyecto en ~/.claude/projects> memory`) y guárdalo fuera del repositorio.
2. **`CLAUDE_CONFIG_DIR`.** Si separas la configuración de las dos cuentas con esta variable de entorno, la memoria queda dentro de esa carpeta de configuración, no en `~/.claude`: hay que copiarla allí.
3. **Conversaciones anteriores.** Viven como archivos en la misma carpeta de proyecto, bajo `~/.claude/projects/`. En el mismo computador y con la misma carpeta puede que `claude --resume` las siga listando con la cuenta nueva, pero no está garantizado: compruébalo y no cuentes con ello. Lo importante ya está en la documentación del repositorio.
4. **Plugins, skills y conectores** son de la cuenta, no del proyecto. Si la cuenta empresarial no los tiene, instálalos de nuevo o pídelos a quien administre la organización.
5. **Permisos.** `.claude/settings.local.json` no viaja (está ignorado por git); se aprueban de nuevo.
6. **Correo de git.** Mantén el mismo `git config user.email`: el repositorio es público y el correo de cada commit queda visible.
7. **Comprobación en la sesión nueva.** Pregunta: «¿qué reglas de commit tiene este proyecto?» (debe decir que pregunta «¿Hago el commit y el push?» y usa rutas concretas en `git add`), «¿cuál es el estado actual y qué falta?» (debe citar `roadmap.md`, «Estado al 2026-11-27 y pendientes») y «¿qué sabes de la cuota de Google Ads?» (esto solo lo sabe si la memoria pasó bien). Si no lo sabe, la memoria no se copió a la carpeta correcta.

## 2c. Si además cambia el dueño del repositorio de GitHub o del proyecto de Railway

Cambiar de cuenta de Claude **no** mueve el repositorio ni Railway: siguen donde están. Mover la propiedad es otra operación, con más riesgo, y no se ha probado en este proyecto. Mi recomendación es invitar a la cuenta empresarial como colaboradora y miembro (sección 2) y solo transferir si la empresa lo exige. Si se hace:

- **Antes:** respaldo de la base de datos (vive en el volumen `/data` de Railway; queda fuera del repositorio) y lista de las variables de entorno guardada en un gestor de contraseñas, no en el chat ni en archivos.
- **GitHub:** la transferencia de propiedad desde los ajustes del repositorio mantiene el historial y suele dejar redirecciones; hay que volver a conectar el repositorio con Railway y comprobar que el despliegue automático desde `main` sigue activo.
- **Railway:** el proyecto, el volumen con la base de datos y las variables deben quedar juntos. Comprobar en la documentación de Railway cómo se transfiere un proyecto entre espacios de trabajo antes de intentarlo, y que la dirección `paid-media-helper.up.railway.app` no cambie (si cambia, hay que actualizar enlaces y documentos).
- **Después:** un push de prueba de documentación, `railway status`, prueba de humo sin sesión (401 o 403, no 500) y revisión de quién tiene acceso. Ante cualquier duda de seguridad, rotar las credenciales primero (ver `CLAUDE.md`).

## 3. Antes de usar la cuenta empresarial: política de la empresa

Revisa con quien lleve la seguridad o la tecnología de la empresa si el proyecto puede trabajarse desde la cuenta empresarial. Puntos a aclarar:

- Qué retención y qué uso de datos tiene esa organización, ya que en las sesiones de Claude Code pasan datos de cuentas de clientes (gasto, campañas, términos de búsqueda) cuando se prueba con datos reales.
- Si el repositorio, que es personal y público, puede tocarse desde un equipo o cuenta de la empresa, y de quién es la propiedad del código.
- Si se pueden conectar los conectores y plugins que ya usas, o si la organización los restringe.

## 4. Puesta en marcha en la cuenta empresarial

1. Instala Git, Python 3.11 o superior, Node.js, la CLI de Railway y Claude Code, e inicia sesión con la cuenta empresarial.
2. Clona el repositorio y abre la carpeta en Claude Code. Verás que ya conoce las reglas porque lee `CLAUDE.md`.
3. `railway login` y `railway link` para vincular el proyecto.
4. Levanta la plataforma en modo simulado (el comando exacto está en `CLAUDE.md`) y comprueba que carga.
5. Si quieres continuidad con lo que ya sabe la otra cuenta, copia la carpeta de memoria a la carpeta que corresponde a la ruta nueva (sección 2b) o pídele a Claude que lea, en este orden, `CLAUDE.md`, `Resumen_Proyecto.md` («Cómo retomar el proyecto») y `roadmap.md` («Estado al 2026-11-27 y pendientes»).

## 5. Trabajar desde dos cuentas sin pisarse

- **Antes de empezar cada sesión:** `git pull` en `main`. Antes de terminar: commit y push, para que la otra cuenta vea el mismo código.
- **Un solo editor a la vez en los mismos archivos.** `webapp/app.js` y `webapp/server.py` son archivos enormes; dos sesiones que los modifiquen a la vez producen conflictos difíciles. Si hay trabajo en paralelo, usa ramas distintas y únelas después.
- **Cada push que toca `webapp/` redespliega producción** (1 a 3 minutos de corte). Se avisa antes y no se hacen dos publicaciones seguidas desde cuentas distintas.
- **Un solo servidor local por puerto**, siempre con `DATA_DIR` aislado. Nunca apuntes un servidor local a la base de producción.
- El flujo de siempre se mantiene en las dos cuentas: probar en local, reportar, preguntar y solo entonces commit y push (está en `CLAUDE.md`).

## 6. Comprobación

- [ ] La identidad de la cuenta empresarial tiene acceso al repositorio y a Railway.
- [ ] Aclarada la política de datos de la empresa (sección 3).
- [ ] Repositorio clonado, `CLAUDE.md` leído por Claude y servidor simulado funcionando.
- [ ] Memoria copiada a la carpeta del proyecto con el nombre que corresponde a la ruta nueva (si cambió el computador, el usuario del sistema o la ruta) y comprobadas las tres preguntas de la sección 2b.
- [ ] Plugins, skills y conectores revisados en la cuenta nueva; permisos aprobados de nuevo.
- [ ] Una prueba de ida y vuelta: un cambio pequeño hecho en una cuenta aparece al hacer `git pull` en la otra.
- [ ] Si alguna vez dejas de usar una de las cuentas: revocar su acceso a GitHub y Railway.

## 7. Pendientes del proyecto

Lo construido y lo que falta: `roadmap.md` («Estado al 2026-11-27 y pendientes», la foto más reciente) y `Resumen_Proyecto.md` («Cómo retomar el proyecto» y «Novedades»). Lo más urgente al 2026-11-27: pedir a Google el acceso Estándar a la API de Google Ads (la cuota Básica se agotó el 26 y el 27 de noviembre). La conexión de solo lectura a GA4, Tag Manager, Search Console y BigQuery tiene guía y script listos en `OUTPUTS/plataforma-google-ads/conexiones_lectura/`, pero la autorización todavía no se ha ejecutado.
