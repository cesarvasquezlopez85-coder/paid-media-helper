# Guía para trabajar el proyecto desde una segunda cuenta de Claude

Para cuando la misma persona gestiona Paid Media Helper desde dos cuentas de Claude (por ejemplo, la personal y la empresarial), o cuando alguien más se suma como colaborador. Lo esencial es que **cada cuenta de Claude es independiente y no comparte nada con la otra**: ni conversaciones, ni memoria de Claude, ni sesiones. Lo que las une es el repositorio, Railway y las credenciales de Google, así que ahí hay que dejar todo ordenado.

Este repositorio es público: esta guía no lleva claves, códigos ni IDs de clientes.

## 1. Qué se comparte y qué no

| Qué | ¿Pasa solo a la otra cuenta? | Cómo se resuelve |
|---|---|---|
| Código y documentación | Sí, viven en GitHub | `git clone` / `git pull` |
| Reglas del proyecto para Claude | Sí, están en `CLAUDE.md` | Claude Code lo lee al abrir la carpeta |
| Memoria de Claude (preferencias, decisiones, estado) | **No**, es local de cada instalación | Si usas el mismo usuario del mismo computador, la carpeta `~/.claude/projects/…/memory/` ya está; si es otro computador, cópiala a mano (no la subas al repo, tiene datos de clientes) |
| Historial de conversaciones | **No** | `CLAUDE.md` y `Resumen_Proyecto.md` reemplazan lo importante |
| Variables y secretos | No | Las ve cada identidad en Railway; nunca por chat ni en archivos |
| Accesos a Google y Railway | Dependen de la identidad con la que inicies sesión | Ver sección 2 |

## 2. Accesos que hay que configurar para la segunda cuenta

Si la cuenta empresarial usa **otro correo** que la personal, esa identidad necesita acceso propio en cada servicio. Si usa el mismo correo de Google y GitHub, solo hay que iniciar sesión.

- **GitHub:** invitar la identidad como colaboradora del repositorio (`paid-media-helper`) con permiso de escritura, y configurar `git config user.name` y `user.email` en ese computador para que los commits queden bien atribuidos.
- **Railway:** invitarla al proyecto como miembro del equipo; así `railway login` y `railway link` funcionan y puede ver variables, despliegues y logs.
- **Google Ads y Google Cloud:** solo hace falta acceso si esa identidad va a entrar a las consolas. La plataforma funciona con el refresh token ya guardado en Railway, no con la cuenta de quien programa.
- **Anthropic (consola):** la clave que usa la IA de la plataforma es independiente de la suscripción de Claude Code. No se cambia.
- **La plataforma:** una cuenta de usuario con rol de administrador (y super admin si va a tocar Hoteles, Campañas o Audiencias; se define con `PMH_SUPER_ADMIN_USERNAMES`).

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
5. Si quieres continuidad con lo que ya sabe la otra cuenta, copia la carpeta de memoria (ver sección 1) o pídele a Claude que lea `Resumen_Proyecto.md` y `roadmap.md`.

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
- [ ] Memoria copiada (si se usa otro computador) y comprobado que el contexto principal se conserva.
- [ ] Una prueba de ida y vuelta: un cambio pequeño hecho en una cuenta aparece al hacer `git pull` en la otra.
- [ ] Si alguna vez dejas de usar una de las cuentas: revocar su acceso a GitHub y Railway.

## 7. Pendientes del proyecto

Lo construido y lo que falta: `roadmap.md` y `Resumen_Proyecto.md` («Novedades»). La conexión de solo lectura a GA4, Tag Manager, Search Console y BigQuery tiene guía y script listos en `OUTPUTS/plataforma-google-ads/conexiones_lectura/`, pero la autorización todavía no se ha ejecutado.
