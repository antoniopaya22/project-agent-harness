# project-agent-harness

Plantilla de *harness* para agentes de código. Se deja caer sobre un proyecto de software y le da
backlog con criterios de aceptación verificables, roles especializados, comandos automatizados y una
documentación cuyo camino de lectura está acotado y comprobado por una máquina.

Independiente de proveedor: hoy proyecta a Claude Code y a la convención `AGENTS.md`, y añadir otro no
toca el núcleo.

## El problema que resuelve

Un agente de código en un repositorio sin estructura hace tres cosas mal: explora treinta ficheros para
entender lo que ya estaba escrito en algún sitio, inventa el comando de tests, y declara terminado algo
que nadie ha verificado. Este harness ataca las tres.

```
                         idea
                          │
              /task new   ▼            /plan                 /implement
            ┌────────────────┐    ┌────────────┐    ┌────────────────────────┐
            │    backlog     │───▶│   ready    │───▶│      in_progress       │
            └────────────────┘    └────────────┘    └───────────┬────────────┘
                                   criterios con      planner ─ implementer ─
                                   comprobación        tester ─ scribe ─ reviewer
                                                                │
                          humano       /commit + PR             ▼
              done  ◀──── revisa  ◀─────────────────────  in_review
```

Ningún agente puede marcar una tarea como `done`. Es deliberado.

## Las tres ideas

**El camino de lectura mínimo.** Un agente pasa de cero a implementar leyendo **cuatro ficheros** y
menos de 800 líneas: las reglas, la tarea, la configuración del proyecto y el documento del área que
toca. La tarea es el enrutador — su bloque `context` dice qué más leer. Y esto no es una buena
intención: `harness doctor` hace cumplir un presupuesto de líneas por fichero, y el build se rompe si
alguien lo engorda.

```bash
$ ./harness read-path FEAT-0017
FEAT-0017  Reconocimiento del proyecto y línea base de calidad

FILE                                   SIZE       WHY
.harness/ENTRYPOINT.md                 104 lines  rules + map
.harness/backlog/tasks/FEAT-0017.json   52 lines  the task
.harness/project.json                  152 lines  gates, areas, git conventions
docs/areas/cli.md                       74 lines  area "cli"

4 files, ~382 lines. Read nothing else unless the work forces you to.
```

**Lo que puede comprobar una máquina, lo comprueba una máquina.** Transiciones de estado, validación de
esquema, ciclos de dependencias, rutas del mapa del código, deriva de los adaptadores. El harness no
depende de que un modelo se acuerde de una regla.

**Un rol se define por lo que no puede hacer.** El agente que verifica no puede arreglar el código —
por eso su veredicto vale algo. El que implementa no puede tocar los criterios de aceptación ni
debilitar un test. Son seis roles, y cada uno aporta una prohibición que ningún otro puede darle.

## Arranque rápido

```bash
git clone <este-repo> mi-proyecto && cd mi-proyecto
./harness doctor      # todo verde
./harness status      # el tablero, y qué hacer a continuación
```

Los dos caminos completos — proyecto nuevo y proyecto ya en marcha — están en
[docs/QUICKSTART.md](docs/QUICKSTART.md).

Requisitos: Node ≥ 20 y git. **Sin dependencias**, sin `npm install`, sin `package.json`. Es
deliberado: el harness se copia dentro de proyectos ajenos y no debe interferir con su gestor de
paquetes. `gh` es opcional (sin él, `harness commit` imprime la URL del PR en lugar de abrirlo).

## Comandos

| | |
|---|---|
| `/implement <ID>` | El ciclo completo, reanudable, con cuatro puntos de decisión humana |
| `/commit` | Commit convencional, push a la rama de la tarea, y PR cuando la tarea está lista |
| `/plan <ID>` | Refina una tarea hasta que sea implementable, o produce su plan |
| `/verify <ID>` | Veredicto por criterio, con evidencia citable |
| `/review` | Revisión con veredicto binario y hallazgos localizados |
| `/task <sub>` | El backlog: crear, listar, transicionar, dividir, refinar |
| `/status` · `/doctor` | Situación del proyecto · salud del propio harness |
| `/handoff` | Persiste el estado para que el trabajo sobreviva a un reinicio de contexto |

El mismo `harness <cmd>` funciona igual en PowerShell, bash y cmd.

## Estado

**Fases 0 a 2 construidas y verificadas**: esquemas, CLI, los seis agentes, nueve comandos y la
proyección a Claude Code y `AGENTS.md`. 89 autotests, `doctor` en verde, backlog del propio proyecto
sembrado desde su plan.

**Pendiente**: `/adopt` (reorganizar un proyecto ya existente), los adaptadores de Cursor y Copilot, y
la sincronización con ClickUp. El detalle, con criterios de aceptación, está en el
[plan](docs/HARNESS-PLAN.md#12-plan-por-fases) y en el
[tablero](.harness/backlog/BOARD.md).

## Para leer más

| | |
|---|---|
| [QUICKSTART](docs/QUICKSTART.md) | Los dos caminos de arranque, en pasos |
| [HARNESS-PLAN](docs/HARNESS-PLAN.md) | Todas las decisiones de diseño con su razonamiento, y el roadmap |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | La forma del sistema y sus fronteras |
| [CODEMAP](docs/CODEMAP.md) | Dónde vive cada cosa y dónde va una cosa nueva |
| [CONVENTIONS](docs/CONVENTIONS.md) | Estilo de código, de tests y de git |
| [PROVIDERS](docs/PROVIDERS.md) | Qué puede cada proveedor y cómo degrada lo que no puede |
| [GLOSSARY](docs/GLOSSARY.md) | Los términos, con el significado exacto que tienen aquí |
