---
updated: 2026-09-24
owner: Antonio Payá
---

# ADR 0003 — El backlog puede vivir en GitHub, sin ficheros ni sincronización

**Estado:** aceptada
**Fecha:** 2026-09-24
**Reemplaza a:** —
**Origen:** PlanifAI-EA, donde se implementó y migró primero (su PR #3243)

## El problema

Con el backlog en `.harness/backlog/tasks/*.json`, cada rama y cada *worktree* llevan su propia
copia. En PlanifAI-EA eso produjo tres fallos distintos con la misma raíz:

- **Dos sesiones reclamaban la misma tarea.** `claim` escribía en la copia local; la otra sesión no
  lo veía hasta fusionar. 28 ramas remotas llevaban estados de tarea más viejos que `main`.
- **El tablero mentía.** Mover una tarjeta a mano no cambiaba nada, y lo que el harness cambiaba
  llegaba al tablero solo cuando `sync` corría en `main`.
- **El espejo se desbocó.** `loadIssueIndex` limitaba `gh issue list` a 1000 (el repositorio tenía
  2703) y, cuando el listado fallaba en CI, lo daba por vacío: cada tarea parecía nueva y `sync`
  creaba una incidencia más por tarea **en cada push**. 2361 duplicadas en dos días.

## La decisión

`project.json → backlog.store` elige dónde vive el backlog:

- `files` (por defecto): lo de siempre. `sync` sigue proyectándolo a trackers externos.
- `github`: **una incidencia por tarea es la tarea**. No hay ficheros ni `sync`.

| Dato | Dónde, con `github` |
|---|---|
| id + título | título de la incidencia, `FEAT-0030 · título` |
| estado | el campo **Status** del tablero, y nada más: mover la tarjeta es cambiar el estado |
| descripción | el cuerpo, por encima de `<!-- harness:datos -->`; editable a mano |
| criterios, contexto, dependencias… | un bloque JSON bajo esa marca, que escribe el harness |
| historial | comentarios con `<!-- harness:evento {…} -->` |
| rama, quién la tiene | además, campos de texto `Rama` y `Reclamada por` del tablero (solo abiertas) |

Todo pasa por `tasks.mjs`, que despacha a `store-github.mjs`; el resto del harness no distingue.

## Consecuencias

- **Reclamar es global y arbitrado.** GitHub no tiene *compare-and-set* sobre un campo, así que el
  comentario de `claim` es el cerrojo: gana el más antiguo desde que la tarea volvió a `ready`, y el
  resto se retira antes de escribir. Probado con dos claims simultáneos.
- **El CI no llama a la API por el backlog.** `doctor` solo mira tareas con `--backlog`; el esquema se
  valida en `save`, antes de que nada salga de la máquina. En PlanifAI-EA salían del job `check`
  `validate`, `lint-backlog` y `status`, que corría dos veces (ubuntu y windows).
- **Hace falta red** para leer y escribir tareas; las lecturas de solo consulta usan una caché local
  de 60 s en `.harness/.cache` (`HARNESS_FRESH=1` la salta). Escribir solo toca lo que cambió.
- **El historial deja de verse en los diffs** de las PRs: vive en la incidencia.
- **Las cuotas de GitHub cuentan.** GraphQL son 5000 puntos/hora compartidos; una operación masiva en
  paralelo con reintentos agresivos los agota.
- Migración: `harness backlog migrate-to-github` (reanudable: `save` compara con lo remoto, así que
  una segunda pasada no escribe nada). Las tarjetas sin tarea se señalan y, con `--remove-orphans`,
  se retiran del tablero sin borrar la incidencia.
- El sumidero `github` de `sync` ya no trata un listado fallido como vacío: rechaza crear nada.

## Cómo se prueba

`tests/store-github.test.mjs`, contra `tests/fixtures/fake-gh.mjs`: un `gh` falso que guarda un
repositorio y un tablero en un JSON y registra cada llamada. `HARNESS_GH_SCRIPT` hace que el harness
lo ejecute con Node en lugar de `gh`, lo que funciona igual en Windows.
