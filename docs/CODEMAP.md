---
updated: 2026-08-18
owner: Antonio Payá
---

# Mapa del código

> Responde a dos preguntas y solo a esas: **¿dónde vive X?** y **¿dónde pongo una X nueva?**
> Nada de razonamiento (eso es [ARCHITECTURE](ARCHITECTURE.md)) ni de estilo
> (eso es [CONVENTIONS](CONVENTIONS.md)).
>
> `harness doctor` comprueba que **todas** las rutas citadas aquí existen. Si este documento miente,
> el build lo dice.

## Vista general

| Zona | Ruta | Qué contiene |
|------|------|--------------|
| CLI | `.harness/bin` | El ejecutable y sus módulos |
| Definiciones | `.harness/agents` · `.harness/commands` | Agentes y comandos, neutrales de proveedor |
| Esquemas | `.harness/schema` | JSON Schema de tarea y de proyecto |
| Perfiles de layout | `.harness/layouts` | Estructura destino por lenguaje, para `/adopt` |
| Plantillas | `.harness/templates` | ADR, cuerpo de PR, documento de área |
| Datos | `.harness/backlog` | Tareas, índice y tablero |
| Trabajo en curso | `.harness/workspace` | Plan, verificación, revisión y handoff por tarea |
| Documentación | `docs` | El set documental y las áreas |
| Adaptadores | `.claude` | Generado desde las definiciones |
| Scripts del repo | `scripts` | El gate `lint` de este proyecto |
| Tests | `tests` | Autotests del harness |

## El CLI en detalle

| Concern | Fichero |
|---------|---------|
| Parseo de argumentos, tabla de comandos, salida con código | `.harness/bin/harness.mjs` |
| Rutas, JSON estable, salida con color, front-matter, globs, `EXIT` | `.harness/bin/lib/util.mjs` |
| Subconjunto de JSON Schema, escrito a mano | `.harness/bin/lib/schema.mjs` |
| Ids, prefijos, transiciones, guardas, `pickNext` | `.harness/bin/lib/tasks.mjs` |
| Cada mutación del backlog, validada | `.harness/bin/lib/task-cmd.mjs` |
| `index.json` y `BOARD.md` | `.harness/bin/lib/board.mjs` |
| Ejecución y resumen | `.harness/bin/lib/gates.mjs` |
| Envoltorios finos, sin política | `.harness/bin/lib/git.mjs` |
| Rama, mensaje, push, PR | `.harness/bin/lib/commit.mjs` |
| Problemas entre tareas | `.harness/bin/lib/lint.mjs` |
| Todas las invariantes comprobables | `.harness/bin/lib/doctor.mjs` |
| Una pantalla, incluida la deriva | `.harness/bin/lib/status.mjs` |
| Proyección a adaptadores | `.harness/bin/lib/generate.mjs` |
| Humano vs. agente | `.harness/bin/lib/actor.mjs` |
| `init`, `survey`, `interview`, `propose`, `apply`, `layouts`, `restructure` | `.harness/bin/lib/adopt-cmd.mjs` |
| Qué contiene un proyecto, con evidencia, sin escribir nada | `.harness/bin/lib/survey.mjs` |
| Lo que el código no puede responder, persistido entre ejecuciones | `.harness/bin/lib/interview.mjs` |
| Un único fichero revisable, cada afirmación con respaldo | `.harness/bin/lib/proposal.mjs` |
| Siembra el backlog y comprueba que los gates arrancan de verdad | `.harness/bin/lib/apply.mjs` |
| Siembra el backlog desde las incidencias que ya existen | `.harness/bin/lib/import.mjs` |
| Las cinco etapas del cierre, parando en la primera que falla | `.harness/bin/lib/finish.mjs` |
| Sugerencia de nivel a partir de tipo, tamaño y radio de impacto | `.harness/bin/lib/tier.mjs` |
| `doc` y `read-log` | `.harness/bin/lib/docs-cmd.mjs` |
| De la versión que adoptó un proyecto a la actual, idempotente | `.harness/bin/lib/upgrade.mjs` |
| Duración derivada del worklog, consumo declarado | `.harness/bin/lib/metrics.mjs` |
| Commits en un área desde que alguien leyó su documento | `.harness/bin/lib/freshness.mjs` |
| Lecturas fuera del camino previsto, agregadas por área | `.harness/bin/lib/feedback.mjs` |

## Dónde poner una cosa nueva

**Un subcomando `harness task <algo>`** → `.harness/bin/lib/task-cmd.mjs`, añadiéndolo a `taskSubs`.
Si muta una tarea, termina con `tasksLib.save` y, si afecta al tablero, con `board.regenerate`.

**Un comando de primer nivel** → `.harness/bin/harness.mjs`, en el objeto `commands`. Devuelve un
código de `EXIT`; no llames a `process.exit` desde el comando.

**Una comprobación nueva de `doctor`** → `.harness/bin/lib/doctor.mjs`, empujando a `issues` con un
`check` propio. Toda invariante del diseño que pueda comprobar una máquina va aquí: es lo que evita que
la estructura se degrade.

**Un agente nuevo** → `.harness/agents/<id>.md` con front-matter completo. `forbidden` no puede estar
vacío: un agente sin límites no justifica ser un rol aparte. Después, `harness generate`.

**Un comando nuevo de barra** → `.harness/commands/<id>.md`. Nunca escribas en `.claude/commands`
directamente: se regenera y se pierde.

**Un campo nuevo en la tarea** → primero `.harness/schema/task.schema.json`, después `KEY_ORDER` en
`.harness/bin/lib/tasks.mjs`, y si debe salir en el tablero, `buildIndex` en
`.harness/bin/lib/board.mjs`.

**Un perfil de layout para otro lenguaje** → `.harness/layouts/<lenguaje>.json`, copiando la forma de
`.harness/layouts/python.json`.

**Un test** → `tests/<algo>.test.mjs`, usando `node:test`. Sin dependencias.

**Un adaptador de tracker externo** → `.harness/integrations/<proveedor>/`, implementando la interfaz
documentada en `docs/areas/integrations.md`.

## Lo que no se edita nunca

Cualquier fichero cuya cabecera diga `GENERADO por harness` / `GENERATED by harness`:
`CLAUDE.md`, `AGENTS.md`, `.claude/agents`, `.claude/commands`, `docs/runbooks`,
`.harness/backlog/index.json`, `.harness/backlog/BOARD.md`.

Para cambiarlos, se edita su fuente en `.harness/` y se ejecuta `harness generate` o `harness index`.
Para un ajuste que la generación no contempla, `.harness/overrides/`.
