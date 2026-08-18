---
updated: 2026-08-18
owner: Antonio Payá
---

# Glosario

> Los términos de dominio de este proyecto, con el significado exacto que tienen aquí. Cuando una
> palabra aparece en un prompt, en un esquema o en un mensaje de error, significa esto y no otra cosa.

**Harness** — La estructura completa que permite a un agente de código trabajar en un proyecto:
backlog, roles, comandos, documentación acotada y el CLI que lo hace cumplir. No es un framework de
agentes: no ejecuta modelos, los organiza.

**Tarea** (*task*) — Una unidad de trabajo con identificador, estado y criterios de aceptación
verificables, en un fichero JSON propio. Es también **el enrutador**: su bloque `context` dice qué debe
leer el agente, y por eso el camino de lectura en frío es corto.

**Criterio de aceptación** (*acceptance criterion*) — Un resultado observable, no una instrucción, con
una comprobación asociada (`command`, `review` o `manual`). Un criterio sin comprobación no es un
criterio: `lint-backlog` lo rechaza.

**Camino de lectura en frío** (*cold-start read path*) — Los cuatro ficheros que un agente lee para
pasar de cero a poder implementar: `ENTRYPOINT.md`, la tarea, `project.json` y el documento del área.
Tiene presupuesto de líneas y `doctor` lo hace cumplir.

**Área** (*area*) — Una rebanada del código con un documento propio y un conjunto de globs que la
identifican. Sirve para que una tarea arrastre solo el contexto que necesita. Se declaran en
`.harness/project.json`.

**Gate** — Un comando de calidad declarado una sola vez (formato, lint, tipos, tests, build, arranque).
Los agentes nunca escriben el comando: llaman a `harness gate <nombre>`. Un gate `required` en rojo
bloquea el commit.

**Definición de hecho** (*definition of done*) — Gates requeridos en verde y todos los criterios de
aceptación resueltos. Es lo que permite entrar en `in_review`; el paso a `done` lo da un humano.

**Handoff** — El fichero `.harness/workspace/<ID>/handoff.json` con el estado de una tarea a medias.
Es lo que hace reanudable a `/implement` tras un reinicio de contexto. Su campo `stage` es un contrato:
declararlo optimista hace que la siguiente sesión se salte trabajo no hecho.

**Adaptador** (*adapter*) — Un directorio o fichero específico de un proveedor (`CLAUDE.md`,
`.claude/`, `AGENTS.md`) **generado** desde `.harness/`. No contiene conocimiento propio; si algo vive
solo ahí, está en el sitio equivocado.

**Deriva** (*drift*) — La diferencia entre lo que dicen las definiciones canónicas y lo que hay en los
adaptadores, o entre el backlog y la realidad del repositorio (una rama sin tarea, una tarea reclamada
sin commits). `generate --check` detecta la primera; `status` la segunda.

**Perfil de layout** (*layout profile*) — La estructura de carpetas destino declarada por lenguaje en
`.harness/layouts/`. `/adopt` mueve código **hacia un perfil escrito**, nunca hacia el criterio del
agente. `as-is` desactiva cualquier movimiento.

**Línea base de gates** (*gate baseline*) — El resultado de los gates capturado **antes** de
reestructurar un proyecto. Es el oráculo que permite saber si mover ficheros rompió algo. Sin línea base
verde no se mueve nada.

**Congelación del id** (*id freeze*) — El identificador de una tarea lleva su tipo (`FEAT-0042`) y deja
de poder cambiar cuando la tarea sale de `backlog`, porque a partir de ahí vive en una rama, en trailers
de commit y posiblemente en ClickUp.

**Actor** — Quién realiza una operación: `human` o uno de los agentes definidos. Importa exactamente
una vez, y es el freno de mano del sistema: `done` y `cancelled` son solo para humanos.
