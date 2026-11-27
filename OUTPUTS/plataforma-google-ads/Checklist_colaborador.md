# Checklist: trabajar el proyecto desde una segunda cuenta de Claude

Versión corta de `Guia_colaborador.md`. Marca cada punto al terminarlo. Sin claves ni IDs: el repositorio es público.

## Camino corto: mismo computador, mismo usuario del sistema, otro correo de Claude
Git, Railway y la memoria ya funcionan en ese computador; el cambio de cuenta de Claude no los toca. Solo hace falta:
- [ ] Cerrar sesión en Claude Code y entrar con la otra cuenta (`/login`), o separar la configuración con `CLAUDE_CONFIG_DIR` si quieres alternar sin cerrar sesión (en ese caso hay que copiar la memoria).
- [ ] Abrir la misma carpeta y comprobar que Claude conoce las reglas del proyecto.
- [ ] Comprobar que la memoria se cargó (misma carpeta y mismo usuario del sistema): preguntar «¿qué sabes de la cuota de Google Ads?». Si no lo sabe, la memoria no está en la carpeta que corresponde (ver `Guia_colaborador.md`, sección 2b).
- [ ] Revisar plugins, skills y conectores de la cuenta nueva (pertenecen a la cuenta, no al proyecto) y aprobar de nuevo los permisos (`.claude/settings.local.json` no viaja).
- [ ] Las conversaciones anteriores pueden seguir listadas con `claude --resume` en el mismo computador, pero no está garantizado; no depender de ello.
- [ ] Mantener el `git config user.email` actual: el repositorio es público y el correo del autor queda visible en el historial.
- [ ] Aclarar la política de datos de la empresa (ver abajo).

Lo demás de esta lista aplica solo si el trabajo pasa a otro computador o a otra persona.

## Decisiones (antes de empezar)
- [ ] ¿La cuenta empresarial usa el mismo correo de GitHub y Railway? Si sí, salta «Accesos».
- [ ] ¿Es el mismo computador y el mismo usuario del sistema? Si sí, salta «Memoria».
- [ ] La empresa aclaró su política de datos: retención y uso, uso de un repositorio personal y público, y conectores permitidos.

## Accesos (solo si es otro correo)
- [ ] GitHub: invitada como colaboradora con permiso de escritura, e invitación aceptada.
- [ ] Railway: invitada como miembro del proyecto `paid-media-helper`, e invitación aceptada.
- [ ] Cuenta de usuario en la plataforma con rol de administrador (y super admin si va a tocar Hoteles, Campañas o Audiencias).

## Computador
- [ ] Instalados Git, Node, Python 3.11+, CLI de Railway y Claude Code.
- [ ] `git config user.name` y `user.email` con la identidad correcta.
- [ ] Repositorio clonado (o `git pull` hecho).
- [ ] `railway login` y `railway link` hechos; `railway status` ve el proyecto.
- [ ] Claude Code abierto en la carpeta con la cuenta empresarial.
- [ ] Prueba: preguntarle por las reglas de commit del proyecto; debe decir que pregunta antes del commit y usa rutas concretas en `git add`.

## Memoria (solo si es otro computador)
- [ ] Carpeta `memory/` copiada a la carpeta de `~/.claude/projects/` que lleva el nombre de la ruta nueva del proyecto (la memoria se busca por la ruta: otra ruta, otro usuario del sistema u otro computador = memoria vacía hasta copiarla). Si usas `CLAUDE_CONFIG_DIR`, copiarla dentro de esa carpeta de configuración. No va al repositorio.
- [ ] Preguntas de comprobación hechas: reglas de commit, estado actual y pendientes (`roadmap.md`), cuota de Google Ads.

## Solo si también cambia la propiedad del repositorio o de Railway
Es una operación aparte, no probada en este proyecto (ver `Guia_colaborador.md`, sección 2c). Cambiar de cuenta de Claude no la necesita.
- [ ] Respaldo de la base de datos (volumen `/data`) y variables de entorno guardadas en un gestor de contraseñas, fuera del repositorio.
- [ ] Repositorio y proyecto de Railway movidos juntos; despliegue automático desde `main` comprobado; dirección `paid-media-helper.up.railway.app` sin cambios (si cambia, actualizar enlaces).
- [ ] Prueba de humo sin sesión (401 o 403, no 500) y revisión de accesos.

## Servidor de prueba
- [ ] Servidor simulado con `DATA_DIR` aislado arrancado en un puerto distinto de 8642 (el comando está en `CLAUDE.md`).
- [ ] Usuario de prueba registrado y pantallas principales recorridas.
- [ ] Servidor apagado y carpeta temporal borrada al terminar.

## Prueba de ida y vuelta
- [ ] Un cambio mínimo hecho en una cuenta aparece con `git pull` en la otra.
- [ ] El cambio de prueba se revirtió o descartó.

## Cada sesión
- [ ] `git pull` al empezar y push al terminar.
- [ ] No editar `webapp/app.js` ni `webapp/server.py` desde las dos cuentas a la vez (usar ramas distintas si hay trabajo en paralelo).
- [ ] Un push que toca `webapp/` redespliega producción (1 a 3 minutos de corte): avisar antes y no encadenar dos desde cuentas distintas.
- [ ] Flujo de siempre: probar en local, reportar, preguntar y solo con un sí explícito, commit y push.

## Si dejas de usar una de las cuentas
- [ ] Revocar su acceso a GitHub y Railway.
