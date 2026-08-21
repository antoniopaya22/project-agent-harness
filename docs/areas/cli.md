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
| Comandos de adopción | `lib/adopt-cmd.mjs` | `init`, `survey`, `interview`, `propose`, `apply`, `layouts`, `restructure` |
| Reconocimiento | `lib/survey.mjs` | Qué contiene un proyecto, con evidencia, sin escribir nada |
| Entrevista | `lib/interview.mjs` | Lo que el código no puede responder, persistido entre ejecuciones |
| Propuesta | `lib/proposal.mjs` | Un único fichero revisable, cada afirmación con respaldo |
| Aplicación | `lib/apply.mjs` | Siembra el backlog y comprueba que los gates arrancan de verdad |

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

- **Una flag repetida acumula en un array**, así que `--file a --file b` conserva las dos. Con una sola
  aparición sigue siendo un escalar, y por eso los subcomandos que aceptan repetición la envuelven con
  `[].concat(flags.x || [])` y los que no comprueban `typeof flags.x === 'string'`. Si mezclas las dos
  convenciones en un subcomando nuevo, una entrada válida se descartará en silencio.
- **`spawnSync` con `shell: true`** usa `cmd.exe` en Windows y `sh` en POSIX. Los comandos de gate
  tienen que funcionar en los dos: nada de `&&`, `$(...)` ni comillas simples anidadas.
- **`node --test --test-name-pattern` falla en abierto**: si el patrón no casa con ningún test, sale
  con 0, porque cero pruebas ejecutadas cuenta como éxito. **Nunca sirve como comprobación de un
  criterio de aceptación** — parece acotarla y en realidad la vacía. Un fichero de test dedicado que
  todavía no existe sí falla, y es la forma correcta de escribir esa comprobación.
- **`node --test <directorio>` no funciona** en Node 22 en Windows: hay que pasar un glob entre
  comillas (`node --test "tests/*.test.mjs"`).
- El validador de `schema.mjs` **avisa de palabras clave que no soporta** en lugar de ignorarlas
  silenciosamente. Si añades una palabra clave a un esquema, añádela también a `KNOWN`.
- `slugify` normaliza acentos; los títulos en español producen ramas ASCII limpias. No cambies eso sin
  mirar `idFromBranch`, que es su inversa.
- **El shell no distingue «falló» de «no arrancó»**: se come el ENOENT, sale con un código propio (1 en
  `cmd.exe`, no el 127 de POSIX) y lo explica **en el idioma del usuario**. Ni el código ni el mensaje
  sirven como señal. Por eso `gateBaseline` resuelve el ejecutable contra el `PATH` antes de ejecutar,
  con `resolveExecutable`. Lo que sigue siendo indetectable es un fallo *envuelto* (`npm run lint` con
  npm instalado y la herramienta de dentro no): eso se queda en `fail` y el gate sigue configurado,
  porque perder una red de seguridad que funciona es el error más caro de los dos.
- **`import.meta.dirname` cambia de profundidad al mover un fichero.** `init` localiza la plantilla
  subiendo desde su propio directorio; al pasar de `bin/` a `bin/lib/` hubo que añadir un `..`. Lo
  detectó la prueba de adopción de punta a punta, no el linter ni el autodiagnóstico.

## Cómo añadir algo nuevo aquí

Un comando de primer nivel, un subcomando de tarea o una comprobación de `doctor`: las rutas exactas
están en [CODEMAP](../CODEMAP.md#dónde-poner-una-cosa-nueva). Dos reglas propias del área: el gate
`lint` rechaza cualquier fichero de más de 600 líneas, y una comprobación nueva de `doctor` necesita un
test en `tests/`.

## Dependencias

Depende de `.harness/schema/` y de `.harness/project.json` como datos de entrada. `lib/generate.mjs`
depende de las definiciones de `.harness/agents/` y `.harness/commands/` — ver
[definitions](definitions.md) y [adapters](adapters.md).
