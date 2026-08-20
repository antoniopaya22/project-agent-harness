---
risk: low
areas: [cli]
---

# Plan — buscar qué tareas tocan una ruta

## Enfoque

Un filtro más en `task list`: `--touching <ruta>` compara la ruta contra `context.files` de
cada tarea y contra los globs de su área. Rechacé un subcomando propio (`task touching`)
porque es un filtro, no una operación distinta, y el espacio de subcomandos ya es grande.

## Pasos

1. `lib/task-cmd.mjs`, `taskSubs.list`: aceptar `--touching` y filtrar.
2. Reutilizar `matchesAny` de `util.mjs` para los globs del área; comparación exacta y por
   prefijo de directorio para `context.files`.
3. `tests/tasks.test.mjs`: coincidencia por fichero, por glob de área, y ausencia de falsos
   positivos con un prefijo parcial.

## Riesgo

Bajo: un filtro añadido, sin cambio de esquema ni de estado.

## Tests

Los tres del paso 3 prueban AC1.

## Docs

`docs/areas/cli.md` no cambia: no añade concepto nuevo. `task.md` lista el filtro.
