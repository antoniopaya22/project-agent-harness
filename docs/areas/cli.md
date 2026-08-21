---
area: cli
updated: 2026-08-18
owner: Antonio Payá
verified_commit: 031243a210a7
---

# Área: CLI

## Qué hace esta área

El ejecutable `harness`: todo lo determinista del harness. Manipula el backlog, valida esquemas,
ejecuta gates, genera vistas y adaptadores, y aplica la política de git.

Su límite: **no toma decisiones de juicio**. No decide si un criterio de aceptación es bueno, ni si un
diff está bien. Eso es de los agentes. La frontera es exactamente esa, y es lo que evita que el harness
dependa de la buena voluntad de un modelo.

## Cómo está organizada

El inventario completo de módulos está en [`docs/CODEMAP.md`](../CODEMAP.md) — «dónde vive cada cosa»
es su tema, no el de este documento. Lo que hace falta saber aquí es la forma:

| Capa | Qué es | Regla |
|------|--------|-------|
| Dispatcher | `harness.mjs` | Solo parsea, despacha y devuelve un `EXIT`. Nunca lógica |
| Comandos por fase | `lib/*-cmd.mjs` | Un fichero por fase (adopción, documentación, tareas) |
| Modelo | `lib/tasks.mjs`, `lib/board.mjs`, `lib/schema.mjs` | Las guardas viven aquí, no en los comandos |
| Ejecución | `lib/gates.mjs`, `lib/git.mjs` | Envoltorios finos, sin política |
| Política | `lib/commit.mjs`, `lib/doctor.mjs`, `lib/lint.mjs` | Toda decisión comprobable por una máquina |
| Proyección | `lib/generate.mjs` | Lo canónico hacia cada proveedor |

Ningún fichero pasa de 600 líneas; el gate `lint` lo comprueba y ya ha forzado tres divisiones.

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

- **El formato de la nota de un cambio de estado es contractual.** `timeInStatus` y las medidas la
  parsean, y se rompió en cuanto un segundo sitio escribió una: `finish` ponía `in_review (finish)` y el
  resto `in_progress -> in_review`, así que toda tarea cerrada con `finish` desaparecía de las dos. Se
  escribe siempre con `logStatusChange`.
- **Una flag desconocida se rechaza, no se ignora.** `parseArgs` recoge lo que le den, así que una errata
  desaparecía en silencio: nueve criterios se registraron con `--note`, que nada consume — OK por pantalla
  y la evidencia a ningún sitio. Un subcomando declara las suyas con `rejectUnknownFlags(flags, ['x'],
  usage)`; las globales van solas.
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
- **El shell no distingue «falló» de «no arrancó»**: se come el ENOENT, sale con código propio (1 en
  `cmd.exe`, no el 127 de POSIX) y lo explica **en el idioma del usuario**. Por eso `gateBaseline` resuelve
  el ejecutable contra el `PATH` antes de ejecutar (`resolveExecutable`). Un fallo *envuelto* (`npm run
  lint` con npm instalado y su herramienta no) sigue siendo indetectable: se queda en `fail` y el gate
  sigue configurado, porque perder una red de seguridad que funciona es el error más caro.
- **Derivado se regenera, generado se comprueba.** `finish` regenera el índice y el tablero sin
  preguntar, porque salen de los ficheros de tarea y no hay criterio humano dentro; en cambio la deriva
  de los adaptadores sí rehúsa, porque ahí puede haber ediciones a mano que merezca la pena ver. Negarse
  a cerrar una tarea terminada por una pulsación de teclado es la clase de roce que hace que un comando
  se abandone.
- **`allocateId` cuenta los ficheros que hay en disco**, así que un lote de tareas construido antes de
  escribir ninguna reparte el mismo id dos veces. `import` las escribe de una en una por eso.
- **Importar la propia proyección crea un bucle.** `sync` escribe incidencias `FEAT-0042 · …` con un
  marcador en el cuerpo; `import` las salta. No se nota hasta que el backlog se ha duplicado, así que la
  comprobación va en el código y no en el prompt.

## Cómo añadir algo nuevo aquí

Un comando de primer nivel, un subcomando de tarea o una comprobación de `doctor`: las rutas exactas
están en [CODEMAP](../CODEMAP.md#dónde-poner-una-cosa-nueva). Dos reglas propias del área: el gate
`lint` rechaza cualquier fichero de más de 600 líneas, y una comprobación nueva de `doctor` necesita un
test en `tests/`.

## Dependencias

Depende de `.harness/schema/` y de `.harness/project.json` como datos de entrada. `lib/generate.mjs`
depende de las definiciones de `.harness/agents/` y `.harness/commands/` — ver
[definitions](definitions.md) y [adapters](adapters.md).
