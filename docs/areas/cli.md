---
area: cli
updated: 2026-08-18
owner: Antonio Payá
---

# Área: CLI

## Qué hace esta área

El ejecutable `harness`: todo lo determinista del harness. Manipula el backlog, valida esquemas,
ejecuta gates, genera vistas y adaptadores, y aplica la política de git.

Su límite: **no toma decisiones de juicio**. No decide si un criterio de aceptación es bueno, ni si un
diff está bien. Eso es de los agentes. La frontera es exactamente esa, y es lo que evita que el harness
dependa de la buena voluntad de un modelo.

## Cómo está organizada

| Pieza | Dónde | Responsabilidad |
|-------|-------|-----------------|
| Dispatcher | `.harness/bin/harness.mjs` | Parseo de argumentos, tabla de comandos, salida con código |
| Plumbing | `lib/util.mjs` | Rutas, JSON estable, salida con color, front-matter, globs, `EXIT` |
| Validador | `lib/schema.mjs` | Subconjunto de JSON Schema, escrito a mano |
| Modelo de tareas | `lib/tasks.mjs` | Ids, prefijos, transiciones, guardas, `pickNext` |
| Subcomandos de tarea | `lib/task-cmd.mjs` | Cada mutación del backlog, validada |
| Vistas | `lib/board.mjs` | `index.json` y `BOARD.md` |
| Gates | `lib/gates.mjs` | Ejecución y resumen |
| Git | `lib/git.mjs` | Envoltorios finos, sin política |
| Política de commit | `lib/commit.mjs` | Rama, mensaje, push, PR |
| Higiene | `lib/lint.mjs` | Problemas entre tareas |
| Autodiagnóstico | `lib/doctor.mjs` | Todas las invariantes comprobables |
| Situación | `lib/status.mjs` | Una pantalla, incluida la deriva |
| Generación | `lib/generate.mjs` | Proyección a adaptadores |
| Actor | `lib/actor.mjs` | Humano vs. agente |

## Flujo principal

`harness.mjs` → `parseArgs` → `loadContext` (busca `.harness/project.json` hacia arriba, carga
`project.json` y el esquema de tarea) → el comando → devuelve un `EXIT` → `main` sale con ese código.

`loadContext` construye el objeto `ctx` que todo lo demás recibe: `{ root, harnessDir, project,
taskSchema }`. No hay estado global.

## Invariantes

- **Todo comando devuelve un código, nunca llama a `process.exit`.** Solo el `.catch` final del
  dispatcher sale. Romper esto hace intestables los comandos.
- **Los códigos de salida son contrato**: `0` ok · `1` el usuario debe arreglar algo · `2` invocación
  mala · `3` rehusado por precondición · `4` no encontrado. Hooks y CI se ramifican con ellos.
- **Toda escritura pasa por `writeFileIfChanged` o `writeJson`**, que normalizan a LF y no tocan el
  fichero si no cambia. Sin esto, `generate --check` daría falsos positivos.
- **Ningún fichero generado contiene una fecha ni nada no determinista.** Si lo tuviera, la detección de
  deriva sería inútil.
- **Ninguna transición de estado se hace escribiendo el campo a mano**: siempre por
  `transitionProblems` + `set-status`. Las guardas son el motivo de existir del módulo.
- `ctx` es de solo lectura para los comandos; nadie muta `ctx.project`.

## Trampas conocidas

- **`parseArgs` no soporta flags repetidas con el mismo nombre** salvo donde el subcomando las envuelve
  con `[].concat(...)` (como `--doc` y `--file` en `task context`). Si añades un subcomando que acepte
  una flag repetible, envuélvela igual.
- **`spawnSync` con `shell: true`** usa `cmd.exe` en Windows y `sh` en POSIX. Los comandos de gate
  tienen que funcionar en los dos: nada de `&&`, `$(...)` ni comillas simples anidadas.
- El validador de `schema.mjs` **avisa de palabras clave que no soporta** en lugar de ignorarlas
  silenciosamente. Si añades una palabra clave a un esquema, añádela también a `KNOWN`.
- `slugify` normaliza acentos; los títulos en español producen ramas ASCII limpias. No cambies eso sin
  mirar `idFromBranch`, que es su inversa.

## Cómo añadir algo nuevo aquí

Un comando de primer nivel, un subcomando de tarea o una comprobación de `doctor`: las rutas exactas
están en [CODEMAP](../CODEMAP.md#dónde-poner-una-cosa-nueva). Dos reglas propias del área: el gate
`lint` rechaza cualquier fichero de más de 600 líneas, y una comprobación nueva de `doctor` necesita un
test en `tests/`.

## Dependencias

Depende de `.harness/schema/` y de `.harness/project.json` como datos de entrada. `lib/generate.mjs`
depende de las definiciones de `.harness/agents/` y `.harness/commands/` — ver
[definitions](definitions.md) y [adapters](adapters.md).
