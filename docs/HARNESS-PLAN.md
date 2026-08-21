# Plan de construcción — `project-agent-harness`

> Plantilla de *harness* para agentes de código, independiente de proveedor.
> Estado: **fases 0–2 construidas y verificadas**; fases 3–6 pendientes. Decisiones de diseño cerradas (§13).

## 0. Estado de implementación

| Fase | Estado |
|------|--------|
| 0 — Cimientos | **construida**: esquemas de tarea y proyecto, `ENTRYPOINT.md`, set documental, convenciones git |
| 1 — CLI núcleo | **construida**: 14 comandos, validador de esquema propio, guardas de estado, índice y tablero |
| 2 — Agentes y comandos | **construida**: 6 agentes, 9 comandos, adaptadores de Claude Code y `AGENTS.md` con detección de deriva |
| 3 — `/adopt` | pendiente. El camino manual equivalente está documentado en [QUICKSTART](QUICKSTART.md#camino-b--proyecto-que-ya-existe) |
| 4 — Multi-proveedor | parcial: `AGENTS.md` y runbooks hechos; Cursor y Copilot necesitan verificar su formato |
| 5 — Proyección externa | pendiente. GitHub por defecto (D9), ClickUp como espejo opcional |
| 6 — Endurecimiento | parcial: 113 autotests, CI en Linux y Windows y documentación hechos; automatismos del proveedor pendientes |

Tras construir las fases 0–2 se revisó el harness con perspectiva y se sembró una **segunda ronda de
40 tareas en 6 épicas nuevas**, ordenadas por el criterio de que la mejora más valiosa es la que ataca la
tesis central del proyecto:

| Épica | Qué ataca |
|-------|-----------|
| Eficiencia del camino de lectura | Los presupuestos se miden en líneas, que es un proxy malo; un agente hace 4 llamadas donde bastaría 1; el fichero de tarea arrastra campos que nadie usa para implementar |
| Mecanismos en lugar de instrucciones | La regla general: cada vez que un prompt dice «fíjate en X» hay un código de salida esperando a existir. El fichero de traspaso, en el que `/implement` **confía** para saltarse trabajo, es lo más crítico sin validar |
| Anti-podredumbre | La frescura de documentos se mide por existencia de rutas, así que un documento puede estar obsoleto con todas sus rutas vivas |
| Proyección a GitHub | D9: destino por defecto sin secretos, y la interfaz de adaptador deja de ser especulativa |
| Ergonomía y huecos | El mayor: hay comando planeado para adoptar un proyecto existente y, para uno nuevo, una lista de pasos manuales |
| Preguntas abiertas y medición | Tres cosas sin resolver, incluida la incómoda: nadie ha medido si el harness se paga |

Verificación: `harness doctor` en verde, `harness gates` en verde, 89 autotests, cero deriva de
adaptadores. El backlog del propio proyecto está sembrado desde §12 (46 tareas, incluidas 7 épicas) y
visible en [BOARD.md](../.harness/backlog/BOARD.md).

### Desviaciones del plan, y por qué

**No hay directorio `template/`.** El `.harness/` de este repositorio *es* la plantilla. Mantener una
copia «plantilla» y otra «aplicada a sí misma» habría garantizado que divergieran; una sola copia lo hace
imposible. Al adoptar, se copia `.harness/` excluyendo el backlog propio.

**Los identificadores `HRN-nnnn` de §12 son referencias del plan**, no del backlog. Las tareas reales
llevan prefijo de tipo según la decisión 1 (`FEAT-0017`, `DOCS-0002`, `EPIC-0004`). El plan se mantiene con
su numeración original para que las referencias cruzadas de este documento sigan siendo válidas.

**Tres defectos de diseño corregidos al usar el harness sobre sí mismo** — los tres los encontró el
propio `lint-backlog` o el propio `next`, que es exactamente lo que se esperaba de ellos:

1. Una épica no puede exigir `context.area`: abarca varias áreas por naturaleza y nunca se implementa
   directamente, así que no tiene camino de lectura.
2. `ready` no debe exigir que las dependencias estén hechas. Eso confundía *refinada* con *desbloqueada* e
   impedía refinar el backlog por adelantado, que es para lo que existe. El bloqueo por dependencias se
   aplica al entrar en `in_progress` y lo muestra `next`.
3. `next` no debe proponer épicas: son contenedores, se completan cuando sus hijas terminan.

---

## 1. Objetivo y principios

Convertir este repo en una **plantilla reutilizable** que se deja caer sobre cualquier proyecto de software y
consigue que un agente de código trabaje bien: con backlog, criterios de aceptación, roles especializados,
comandos automatizados y documentación que no miente.

Cinco principios que gobiernan todas las decisiones siguientes:

| # | Principio | Consecuencia práctica |
|---|-----------|----------------------|
| P1 | **Una sola fuente de verdad** | Todo lo canónico vive en `.harness/` + `docs/`. `.claude/`, `AGENTS.md`, `.cursor/` son adaptadores **generados**. |
| P2 | **Camino de lectura mínimo** | Un agente pasa de cero a implementar leyendo **4 ficheros**. La tarea es el enrutador que le dice qué leer. |
| P3 | **Cada artefacto o lo lee un agente o lo verifica una máquina** | Si un fichero no lo consume nadie y nadie comprueba que sigue vivo, no existe. Mata la ceremonia. |
| P4 | **Todo lo opcional es opcional de verdad** | Sin token de ClickUp, sin Cursor, sin CI: el harness funciona igual. Nada del núcleo depende de una integración. |
| P5 | **Dogfooding** | El plan de construir el harness se expresa como tareas en el formato del propio harness. Si el formato es incómodo, lo notamos el primer día. |

---

## 2. Decisiones de arquitectura

**D1 — Separación `.harness/` vs `docs/`.**
`.harness/` es la capa *máquina*: datos de tareas, esquemas, definiciones de agentes y comandos, scripts, config.
`docs/` es la capa *humano y agente*: arquitectura, mapa del código, convenciones, glosario, ADRs.
Motivo: la documentación tiene que ser navegable y renderizable en GitHub (un directorio oculto la entierra),
mientras que los datos de tareas y los scripts no deben ensuciar la raíz del proyecto.

**D2 — Runtime de tooling: Node.js sin dependencias.**
Scripts `.mjs` usando solo la stdlib, ejecutados por un único punto de entrada `harness`. Motivo: Node está
presente en casi cualquier máquina de desarrollo, es multiplataforma sin depender de bash, y cero dependencias
significa cero mantenimiento de lockfiles en una plantilla. Shims `harness.ps1` (Windows) y `harness` (POSIX)
para que **el nombre del comando sea el mismo en las dos shells** — importante porque trabajas en PowerShell.

**D3 — Un fichero JSON por tarea.**
`.harness/backlog/tasks/FEAT-0042.json`. Un `backlog.json` monolítico genera conflicto de merge en cada rama.
`index.json` y `BOARD.md` son **generados** y regenerables: ante conflicto, no se resuelve a mano, se ejecuta
`harness index`.

**D4 — El estado de la tarea es el contrato entre agentes, y vive en disco.**
`.harness/workspace/<ID>/handoff.json` sobrevive a un reinicio de contexto. Cualquier comando puede
reanudar una tarea a medias sin volver a razonar desde cero.

**D5 — `/adopt` sí reorganiza el código, contra un perfil de layout declarado y con los gates como oráculo.**
Reorganizar es parte del encargo: mover el código a la estructura que el harness necesita, y actualizar la
documentación y la configuración para que el proyecto quede utilizable. Pero mover ficheros de un proyecto de
tres años a ojo es la forma más rápida de romperlo en silencio, así que la reorganización va sujeta a seis
condiciones no negociables:

1. **Se mueve hacia un estándar escrito**, no hacia el criterio del agente. `.harness/layouts/<lenguaje>.json`
   declara la estructura destino (p.ej. Python: `src/<paquete>/`, `tests/` espejando `src/`; Node/TS: `src/`,
   `tests/`). El perfil es editable y `layout: "as-is"` desactiva por completo el movimiento.
2. **Árbol limpio obligatorio.** Nada sin commitear antes de empezar; nada que esté en `.gitignore`, vendorizado
   o generado se mueve.
3. **`git mv` siempre**, para preservar el historial y para que `git status` muestre renombrados y no
   borrado+creación.
4. **Rama dedicada y commit único de reestructuración**, separado de todo lo demás: revertir es un solo comando.
5. **Los gates son el oráculo.** Se captura una línea base *antes* de mover; después del movimiento los mismos
   gates deben dar el mismo resultado o mejor. Movimiento por **lotes pequeños**, verificando entre lotes, no un
   big-bang.
6. **Sin línea base verde no se mueve nada.** Si el proyecto no tiene tests que pasen, no existe forma de saber
   si el movimiento rompió algo: en ese caso `/adopt` **no mueve** y emite la reestructuración como tareas del
   backlog, más una tarea previa de "conseguir una red de seguridad mínima". Es una degradación honesta, no una
   negativa: en cuanto haya tests, `/adopt --restructure` lo ejecuta.

La parte difícil no es mover, es **reescribir las referencias**: imports, rutas relativas, `pyproject.toml`,
`tsconfig.json` paths, `Dockerfile` COPY, workflows de CI, `pytest.ini` testpaths, configuración de cobertura,
`MANIFEST.in`, entry points. Van en el mismo commit y con inventario explícito de qué se ha tocado.

**D6 — Proyección externa de una sola dirección (push), a varios sumideros.**
El repo es la fuente de verdad porque es donde ocurre el trabajo: para cambiar el estado de una tarea hay que
tocar el código, así que se cambia desde el harness. Fuera se **consulta**, no se edita.
Consecuencia: no hay `pull`, no hay resolución de conflictos, no hay emparejado de tareas remotas
preexistentes. Queda una salvaguarda barata: si el contenido remoto no coincide con el hash guardado, alguien
editó a mano y `/sync` lo **avisa** sin intentar mezclar nada.

**D9 — GitHub es la proyección por defecto; los demás trackers son espejos opcionales.**
Dos niveles, y el reparto no es arbitrario:

| Nivel | Destino | Por qué |
|-------|---------|---------|
| **1, siempre activo** | GitHub Issues + Projects | Está donde vive el código, y **no necesita ni un secreto**: el transporte es `gh`, que ya está autenticado. Coste de configuración cero |
| **2, opcional** | ClickUp, Jira, Linear… | Espejo para quien viva en otra herramienta. Requiere token y configuración explícita |

Lo importante de esta decisión no es GitHub, es lo que le hace a la arquitectura: el motor de sincronización deja
de ser «un cliente de ClickUp» y pasa a ser **una proyección con N sumideros**. `harness sync` recorre los
sumideros habilitados; cada uno reconcilia contra el repo por su cuenta y **nunca hablan entre ellos**, así que
dos espejos no pueden entrar en conflicto — solo pueden estar cada uno más o menos fresco.

Y hace que la interfaz de adaptador deje de ser especulativa: tiene dos implementaciones desde el primer día,
que es la única forma de saber si una abstracción está bien puesta.

Detalles que **hay que verificar** antes de escribir el código (spike propio): Projects v2 es solo GraphQL —
la API REST de los proyectos clásicos está retirada — así que el transporte será `gh project`, que exige el
scope `project` en el token (el habitual no lo trae: `gh auth refresh -s project`). Pendiente también confirmar
la superficie de sub-issues para las épicas, y si el `GITHUB_TOKEN` de Actions puede escribir en un Project
(es un recurso de usuario u organización, no del repositorio, así que probablemente haga falta un PAT o una App).

**D7 — Los *gates* de calidad se declaran una vez y se invocan siempre igual.**
`project.json` declara cómo se formatea, lintea, tipa, testea, construye y ejecuta el proyecto. Ningún agente
adivina un comando: llama a `harness gate test`. Esto elimina el fallo más común (el agente inventa
`npm test` en un proyecto con `pnpm`, o `pytest` donde hay `tox`).

**D8 — Idioma: prompts en inglés, entregables en español, y el idioma es configuración.**
Las definiciones de agentes y comandos (`.harness/agents/*.md`, `.harness/commands/*.md`) y las claves de
frontmatter van en **inglés**: la terminología ya lo es (commit, branch, gate, acceptance criteria), los modelos
siguen instrucciones algo mejor en inglés, y abre la puerta a publicar la plantilla. La documentación (`docs/**`)
y el contenido de las tareas (título, descripción, criterios) van en **español**, porque los lee tu equipo y
porque tus compañeros no técnicos ven los títulos en el tablero.
El riesgo de mezclar es concreto — un agente tiende a responder en el idioma de su prompt, así que prompt en
inglés + tarea en español da idioma de salida impredecible. Se resuelve con `output_language: "es"` en
`project.json`, que el generador inyecta en todos los prompts: el idioma de los entregables es **configuración**,
no algo cocido en seis ficheros.

---

## 3. Estructura de carpetas

### 3.1 La plantilla (este repo)

```
project-agent-harness/
├── README.md                      # puerta de entrada humana: qué es, quickstart en 2 min
├── docs/
│   ├── HARNESS-PLAN.md            # este documento
│   ├── QUICKSTART.md              # greenfield y brownfield paso a paso
│   ├── CONCEPTS.md                # tarea, área, gate, adaptador, handoff
│   └── PROVIDERS.md               # matriz de capacidades por proveedor
├── template/                      # <- lo que se copia al proyecto destino
│   ├── .harness/
│   └── docs/
├── tests/
│   └── fixtures/sample-python-project/
├── .github/workflows/harness.yml
└── .harness/                      # el harness aplicado a sí mismo (dogfooding)
```

### 3.2 Un proyecto real tras adoptar el harness

```
mi-proyecto/
├── CLAUDE.md                      # GENERADO — 20 líneas que apuntan a .harness/ENTRYPOINT.md
├── AGENTS.md                      # GENERADO — misma cosa, convención universal
├── README.md                      # del proyecto (nunca se sobrescribe)
├── src/ · tests/                  # el código, movido al perfil de layout por /adopt (D5)
├── docs/
│   ├── ARCHITECTURE.md            # forma del sistema, límites, flujo de datos
│   ├── CODEMAP.md                 # dónde vive cada cosa · dónde añadir una X nueva
│   ├── CONVENTIONS.md             # estilo de código, de tests, de git, de errores
│   ├── ENVIRONMENT.md             # prerequisitos, secretos, cómo levantarlo en local
│   ├── GLOSSARY.md                # términos de dominio
│   ├── areas/
│   │   ├── api.md                 # contexto profundo por área
│   │   └── billing.md
│   ├── adr/0001-postgres-sobre-mongo.md
│   └── runbooks/                  # GENERADO — comandos como prompts, para proveedores sin slash commands
├── .claude/                       # GENERADO
│   ├── agents/{planner,implementer,tester,reviewer,researcher,scribe}.md
│   ├── commands/{implement,commit,task,plan,verify,review,adopt,sync,status,doctor,handoff}.md
│   └── settings.json
└── .harness/
    ├── VERSION                    # 1.0.0 — para migraciones
    ├── ENTRYPOINT.md              # ★ EL fichero de arranque en frío del agente (~100 líneas)
    ├── project.json               # gates, áreas, convenciones git, proveedores activos
    ├── policy.json                # permisos de herramientas por agente, hooks
    ├── schema/{task,project}.schema.json
    ├── layouts/<lenguaje>.json    # estructura destino declarada, para /adopt (D5)
    ├── adoption/                  # solo en proyectos adoptados
    │   ├── interview.json         # respuestas del humano, para no volver a preguntar
    │   ├── PROPOSAL.md            # propuesta iterada antes de tocar nada
    │   └── RESTRUCTURE-PLAN.md    # plan de `git mv` + reescritura de referencias
    ├── agents/<rol>.md            # definición canónica, neutral de proveedor
    ├── commands/<nombre>.md       # idem
    ├── templates/{task,adr,pr,area}.md
    ├── backlog/
    │   ├── tasks/FEAT-0001.json ...
    │   ├── index.json             # GENERADO
    │   └── BOARD.md               # GENERADO — tablero legible en GitHub
    ├── workspace/FEAT-0042/       # plan.md · research.md · verification.md · review.md · handoff.json
    ├── integrations/clickup/{adapter.mjs,config.json,mapping.json}
    ├── migrations/
    ├── overrides/<proveedor>/     # escotilla de escape para tweaks manuales
    └── bin/harness.mjs
```

---

## 4. El camino de lectura mínimo (requisito clave)

Cuando se lanza `/implement FEAT-0042`, el agente lee **exactamente esto**, en este orden:

| # | Fichero | Presupuesto | Qué le da |
|---|---------|------------|-----------|
| 1 | `.harness/ENTRYPOINT.md` | ≤ 120 líneas | Las reglas del juego y el mapa de mapas. Lo único que se lee siempre. |
| 2 | `.harness/backlog/tasks/FEAT-0042.json` | ≤ 200 líneas | Qué hacer, criterios de aceptación, y **punteros de contexto**. |
| 3 | `.harness/project.json` | ≤ 150 líneas | Cómo construir/testear/lintear, convenciones git, áreas. |
| 4 | `docs/areas/<area>.md` | ≤ 300 líneas | Solo la rebanada de arquitectura que toca esta tarea. |

**Total: 4 ficheros, < 800 líneas.** Todo lo demás (`CODEMAP.md`, `CONVENTIONS.md`, un ADR concreto, ficheros de
código) se lee **solo si la tarea lo lista** en `context.docs` / `context.files`.

Dos invariantes lo sostienen, y ambas son verificables por máquina:

- **Un tema, un dueño.** Ningún hecho aparece en dos documentos. Los documentos enlazan, no repiten.
  `harness doctor` avisa de secciones duplicadas entre docs.
- **La tarea es el enrutador.** Rellenar `context` es trabajo del agente `planner` durante el *grooming*, no del
  `implementer` en caliente. Una tarea sin `context.area` no puede pasar a `ready`.

Y una prueba mecánica en CI: un test recorre el camino de lectura declarado en `ENTRYPOINT.md`, comprueba que
cada fichero existe y que **ninguno excede su presupuesto de líneas**. El requisito de "leer lo mínimo" deja de
ser una buena intención y pasa a ser un test que rompe el build.

---

## 5. Modelo de tareas

### 5.1 Identificadores

Formato **`<TIPO>-<NNNN>`**, con **contador independiente por tipo**: `FEAT-0042`, `FIX-0007`, `DOCS-0003`.
El objetivo es que un humano identifique y filtre una tarea de un vistazo, en el backlog, en la rama y en el
tablero.

| Tipo | Uso |
|------|-----|
| `FEAT` | nueva funcionalidad |
| `FIX` | corrección de un defecto |
| `CHORE` | mantenimiento, tooling, dependencias |
| `DOCS` | documentación |
| `RFCT` | refactor sin cambio de comportamiento |
| `TEST` | trabajo de tests |
| `SPIKE` | investigación acotada, con pregunta y presupuesto |
| `EPIC` | agrupador de tareas |

Contador monótono por tipo, asignado por `harness task new --type feat`, que **escanea los ids existentes de
ese tipo** — deliberadamente *no* hay fichero contador, porque un contador es el peor conflicto de merge
posible. Contadores separados reducen además las colisiones: dos ramas que crean tareas de tipos distintos
nunca chocan. Si chocan (mismo tipo, dos ramas), `harness lint-backlog` lo detecta y la reparación es renombrar
un fichero y editar un campo.

**Regla de congelación (importante).** El tipo es un atributo *mutable* metido en un identificador *inmutable*:
una tarea groomeada como `FEAT-0042` puede resultar ser un bug. Por tanto:

- Mientras la tarea está en `backlog` no existe rama, ni commit, ni tarjeta remota: `harness task retype`
  reasigna el id y renombra el fichero sin coste.
- Al salir de `backlog` el id **se congela**. Un cambio de tipo posterior se refleja solo en el campo `type`,
  que puede divergir del prefijo; `doctor` lo reporta como informativo, nunca como error. La alternativa
  (prohibir cambiar de tipo) no sobrevive al contacto con la realidad.

**El prefijo de proyecto vive en el borde, no en el id.** Localmente el id es corto (`FEAT-0042`), porque se
escribe cien veces al día. La unicidad global se resuelve donde de verdad hace falta — un workspace de ClickUp
con varios proyectos — escribiendo `PANGEA · FEAT-0042` en el campo personalizado *Harness ID* (§10).

### 5.2 Máquina de estados

```
backlog ──groom──> ready ──claim──> in_progress ──verify+review──> in_review ──human──> done
                                          │  ▲                          │
                                          ▼  └──────────────────────────┘
                                       blocked                      (cambios pedidos)

   cualquiera ──human──> cancelled
```

| Estado | Requiere para entrar | Quién puede |
|--------|---------------------|-------------|
| `backlog` | título + descripción | cualquiera |
| `ready` | ≥1 criterio de aceptación con `check`, `context.area`, dependencias resueltas | `planner` |
| `in_progress` | rama creada, `assignee`, `claimed_at` | `implementer` |
| `blocked` | `blocked_reason` no vacío | cualquier agente |
| `in_review` | todos los gates requeridos en verde, todos los AC `pass` o `unverifiable` justificado | `tester` |
| `done` | revisión aprobada + merge | **solo humano** |
| `cancelled` | `resolution` no vacío | **solo humano** |

Ningún agente puede marcar `done`. Es el freno de mano del sistema.

### 5.3 Criterios de aceptación verificables

El punto que hace útil al agente `tester`: cada criterio es un objeto con una comprobación asociada.

```json
"acceptance_criteria": [
  { "id": "AC1",
    "must": "POST /users con email duplicado devuelve 409 y no crea registro",
    "check": { "type": "command", "run": "pytest tests/api/test_users.py::test_duplicate_email" },
    "status": "pending" },
  { "id": "AC2",
    "must": "El endpoint aparece documentado en docs/areas/api.md",
    "check": { "type": "review" },
    "status": "pending" }
]
```

`check.type` ∈ `command` (ejecutable, veredicto automático) · `review` (juicio del `reviewer`) · `manual`
(un humano lo confirma). Un AC sin `check` no es un AC: `lint-backlog` lo rechaza.

### 5.4 Ejemplo completo de tarea

```json
{
  "$schema": "../../schema/task.schema.json",
  "id": "FEAT-0042",
  "title": "Registro de usuario con verificación por email",
  "type": "feature",
  "status": "ready",
  "priority": "high",
  "size": "M",
  "parent": "EPIC-0007",
  "description": "Los usuarios se registran con email+password y quedan inactivos hasta pulsar el enlace de verificación, que caduca en 24h.",
  "acceptance_criteria": [ "...ver §5.3..." ],
  "context": {
    "area": "api",
    "docs": ["docs/areas/api.md", "docs/adr/0003-tokens-firmados.md"],
    "files": ["src/api/routes/users.py", "src/services/mailer.py"],
    "out_of_scope": ["OAuth social", "recuperación de contraseña"]
  },
  "depends_on": ["FIX-0031"],
  "labels": ["auth", "email"],
  "assignee": { "kind": "agent", "id": "implementer" },
  "branch": "feat/0042-registro-usuario",
  "estimate_hours": 6,
  "links": { "pr": null, "commits": [], "issue": null },
  "worklog": [
    { "at": "2026-08-18T17:40:00Z", "by": "planner", "event": "groomed", "note": "3 AC definidos, área api" }
  ],
  "external": {
    "clickup": { "id": null, "url": null, "list_id": null, "last_synced_at": null, "content_hash": null }
  },
  "created_at": "2026-08-18T17:32:00Z",
  "updated_at": "2026-08-18T17:40:00Z"
}
```

`worklog` se acota a las últimas 20 entradas; el histórico completo va a
`.harness/workspace/FEAT-0042/worklog.md` para que el JSON no se hinche.

### 5.5 Artefactos generados

`index.json` — un array plano con solo lo necesario para decidir (`id, title, status, priority, size, area,
depends_on, assignee, blocked`). Existe para que la pregunta *"¿cuál es mi siguiente tarea?"* se responda con
**una sola lectura** en vez de abrir 200 ficheros.
`BOARD.md` — tablero en Markdown por columnas, legible en GitHub, para quien no use ClickUp.

---

## 6. Subagentes

Seis roles. La justificación de lo que **no** hay es tan importante como la de lo que hay.

| Agente | Propósito | Escribe | Prohibido explícitamente |
|--------|-----------|---------|--------------------------|
| **planner** | Convierte una idea en tarea bien formada: descripción, AC con `check`, área, punteros de contexto, dependencias. Parte las tareas grandes. Produce el `plan.md` de implementación. | task JSON, `workspace/<id>/plan.md`, borradores de ADR | tocar código de producción |
| **implementer** | Escribe código y tests que satisfacen el plan y los AC. | `src/`, `tests/`, docs que su cambio invalida | editar criterios de aceptación · debilitar, saltar o borrar tests para que pasen · marcar `done` |
| **tester** | Verifica cada AC de forma independiente y ejecuta los gates. Emite veredicto por AC con evidencia. | ficheros de test, `verification.md` | escribir código de producción (si el test falla, **reporta**, no arregla) |
| **reviewer** | Revisa el diff contra los AC y las convenciones. Veredicto `approve` / `changes_requested` con hallazgos localizados. | `review.md` | modificar el código · aprobar sin hallazgos cuando los hay |
| **researcher** | Investigación para spikes: alternativas, APIs externas, arqueología del propio repo. Cita fuentes. | `research.md` | código de producción · decidir en lugar del planner |
| **scribe** | Documentación: actualiza `CODEMAP`, docs de área, ADRs. Es el motor documental de `/adopt`. | `docs/**` | inventar hechos sin evidencia (todo va con `[evidencia: path:línea]` o marcado `[SIN VERIFICAR]`) |

**Fusiones y descartes justificados.** No hay agente *Architect* separado: el diseño previo a codificar lo hace
`planner` con esfuerzo alto, porque separar grooming de diseño duplica el contexto sin añadir capacidad. No hay
agente *Integrator*: git es determinista, vive en el comando `/commit` como script, no como juicio de un LLM.
No hay agente *Sync*: es un script, no razona. No hay agente *Adopter*: `/adopt` orquesta a `researcher`,
`scribe` y `planner`, que ya existen. Cada rol que se queda tiene una **prohibición** que otro rol no puede
darle: ahí está su razón de ser (el `tester` existe precisamente porque no puede arreglar el código).

### 6.1 Definición canónica y proyección

`.harness/agents/implementer.md`:

```yaml
---
id: implementer
name: Implementer
purpose: Escribe código y tests que satisfacen el plan y los criterios de aceptación de una tarea.
inputs:  [task, plan, area_docs, project_config]
outputs: [handoff, changed_files]
writes:  [src, tests, docs]
forbidden: [acceptance_criteria, task_status_done, gate_config, test_deletion]
capabilities: [read, edit, search, shell]
network: false
model: primary        # primary | fast | deep
effort: high
---
(cuerpo: el prompt del rol, con el esqueleto común de §6.3)
```

Proyección a Claude Code (`.claude/agents/implementer.md`): `purpose` → `description`, `capabilities` → `tools`
(`read,edit,search,shell` → `Read, Edit, Write, Glob, Grep, Bash`), `model: primary|fast|deep` →
`sonnet|haiku|opus`. `forbidden` y `writes` se inyectan como reglas duras en el cuerpo del prompt **y** como
hooks de bloqueo donde el proveedor lo permite.

### 6.2 Contrato de handoff

`.harness/workspace/FEAT-0042/handoff.json` — lo que permite reanudar tras un reinicio de contexto:

```json
{ "task": "FEAT-0042", "stage": "implemented", "by": "implementer",
  "at": "2026-08-18T19:10:00Z", "branch": "feat/0042-registro-usuario",
  "summary": "Endpoint + servicio de tokens + 4 tests",
  "changed_files": ["src/api/routes/users.py", "tests/api/test_users.py"],
  "gates": { "format": "pass", "lint": "pass", "test": "pass", "typecheck": "skipped" },
  "acceptance": [ { "id": "AC1", "status": "pass", "evidence": "pytest ... 1 passed" } ],
  "next": "tester", "blockers": [], "notes_for_next": "AC2 requiere juicio humano sobre la redacción" }
```

`stage` ∈ `claimed → planned → implemented → verified → reviewed → committed`. `/implement` lee este fichero
antes que nada: si existe, **reanuda** en lugar de reempezar.

### 6.3 Esqueleto común de prompt

Todos los agentes siguen el mismo orden de secciones, para que el roster se lea consistente y sea auditable:
`Rol y límite` · `Qué leer (y en qué orden)` · `Procedimiento` · `Nunca hagas` · `Formato de salida` ·
`Cuándo pararte y preguntar`. Máximo 150 líneas por agente: un prompt que nadie lee es un prompt que no existe.

---

## 7. Comandos

Definición canónica en `.harness/commands/<nombre>.md`, proyectada a `.claude/commands/<nombre>.md` (frontmatter
`description`, `argument-hint`, `allowed-tools`, `model`; cuerpo con `$ARGUMENTS`/`$1`, inyección de bash con
``!`comando` `` y referencias `@ruta`).

| Comando | Naturaleza | Qué hace |
|---------|-----------|----------|
| `/implement <id>` | híbrido | El comando estrella. Ciclo completo, reanudable. §7.1 |
| `/commit [msg]` | script + prompt fino | Gates → commit convencional → rama de la tarea → push. §7.2 |
| `/task <sub>` | script | `new · show · next · list · split · status · block · claim` |
| `/plan <id>` | agente | `planner` produce/refresca `plan.md` |
| `/verify <id>` | híbrido | `tester`: gates + veredicto por AC |
| `/review [id]` | agente | `reviewer` sobre el diff actual |
| `/adopt <ruta>` | híbrido | Adoptar un proyecto existente. §7.3 |
| `/sync [--dry-run]` | script | Sync con el tracker externo (opcional) |
| `/status` | script | Situación en una pantalla: board + ramas + tareas estancadas |
| `/doctor [--fix]` | script | Valida el harness a sí mismo |
| `/handoff` | script | Persiste estado y para limpiamente |
| `/harness-init` | híbrido | Arranque greenfield |

`/task` es un único comando con subcomandos, no ocho comandos: el espacio de nombres de slash commands es
memoria del usuario, y `new`/`show`/`next` no valen un comando cada uno.

### 7.1 `/implement <task-id>` — algoritmo

```
0. Leer camino mínimo (§4). Si existe handoff.json → saltar a su stage.
1. Guardas: status ∈ {ready, in_progress}. Si backlog → invocar planner y PARAR
   para que el humano confirme los AC antes de escribir una línea de código.
2. Dependencias: alguna depends_on != done → rehusar y listar bloqueantes.
3. Rama: crear/cambiar a <type>/<ID>-<slug> desde la default actualizada.
4. Claim: status=in_progress, assignee, claimed_at, handoff stage=claimed.
5. Plan: si no hay plan.md → planner. Si el plan toca >1 área o marca riesgo alto → PARAR (checkpoint humano).
6. Implementar: implementer, leyendo solo el camino mínimo + plan.
7. Verificar: tester. AC fallido → volver a 6. Máximo 2 vueltas, luego PARAR y reportar.
8. Documentar: scribe actualiza los docs que el cambio invalidó.
9. Revisar: reviewer. Hallazgos bloqueantes → resolver.
10. Cerrar: status=in_review, worklog, /commit, imprimir resumen + siguiente acción humana.
```

Cuatro puntos de parada humana: confirmación de AC, plan de riesgo alto, dos verificaciones fallidas, y el paso
a `done`. El resto es automático.

### 7.2 `/commit` — gramática y guardas

- **Rama**: `<tipo-minúscula>/<NNNN>-<slug-kebab>` → `feat/0042-registro-usuario`.
  El tipo ya vive en el id (§5.1), así que **no se repite**: la rama de `FEAT-0042` es `feat/0042-…`, nunca
  `feat/FEAT-0042-…`. La conversión rama ↔ id es determinista en los dos sentidos.
- **Commit**: `<type>(<scope>): <asunto>` · asunto imperativo, ≤72 car., sin punto final · cuerpo explicando
  *por qué* · trailer `Refs: FEAT-0042` (o `Closes: FEAT-0042` en el último commit de la tarea).
  Commits **incrementales** durante `/implement`: cada hito es un punto de recuperación.
- **Guardas**: en la rama por defecto → rehúsa y ofrece crear la rama de la tarea · nada staged → informa y
  sale 0 · gate requerido en rojo → rehúsa (`--no-verify` explícito para saltarlo, y lo deja anotado en el
  mensaje) · rama divergida → informa, nunca `--force` por su cuenta.
- **Push**: automático a la rama de la tarea, sin preguntar. Confirmación explícita solo para force-push y para
  empujar a la rama por defecto.
- **PR**: se abre **automáticamente**, pero no en cada `/commit` — solo cuando la tarea alcanza `in_review`
  (gates requeridos en verde + todos los AC resueltos). Si el PR ya existe, `/commit` solo empuja y el PR se
  actualiza solo. Título = `<type>(<scope>): <título de la tarea>`; cuerpo desde `templates/pr.md` con enlace a
  la tarea, checklist de AC y evidencia de tests. Sin `gh` instalado, imprime la URL de creación en vez de
  fallar.
- **Nunca automático**: asignar revisores, marcar *ready for review* si se abrió en borrador, y **mergear**.
  Configurable con `git.auto_pr: "ready" | "draft" | "never"` (por defecto `ready`).

### 7.3 `/adopt <ruta>` — ocho etapas, conversacional e iterativo

No es un comando de un disparo: es una sesión con el humano, y todo lo que el humano contesta se persiste en
`.harness/adoption/interview.json` para que una segunda ejecución **no vuelva a preguntar** lo mismo.

1. **Survey** (solo lectura, cero escrituras). Lenguajes, gestor de paquetes, puntos de entrada, framework de
   tests, CI, docs existentes, y los *hotspots* del repo
   (`git log --format= --name-only | sort | uniq -c | sort -rn`). Inventaría `TODO`/`FIXME` y, si hay `gh`, los
   issues abiertos. Captura la **línea base de gates** (D5): qué pasa, qué falla, qué no existe.

2. **Interview.** Solo lo que **no se puede inferir del código**:
   propósito y descripción del proyecto en un párrafo · quién lo usa y para qué · los 5–15 términos de dominio
   del glosario · qué partes están deprecadas o fuera de alcance · qué áreas son las importantes y dónde duele ·
   convenciones que el equipo ya tenga · si se reestructura ahora y con qué perfil de layout.

   Tres reglas que hacen la entrevista soportable:
   - **Confirmar inferencias en lugar de preguntar en abierto.** No "¿cómo se testea esto?", sino "he detectado
     `pytest -q` en el CI y 214 tests, ¿es el comando real?". El humano dice *sí* mucho más rápido que redacta.
   - **Por lotes temáticos**, máximo 4 preguntas por ronda y unas 4 rondas. Un cuestionario de 30 campos no se
     rellena.
   - **Todo respondido se persiste**; lo que el humano no sepa se queda como `[SIN VERIFICAR]` y no bloquea.

3. **Infer.** Los gates salen de evidencia real (`package.json` scripts, `pyproject.toml`, `Makefile`, el
   workflow de CI), nunca de convención imaginada. Las áreas, de los directorios de código reales cruzados con
   los hotspots. Las convenciones, de la config existente (eslint/ruff/prettier) y del código tal como está.

4. **Propose** (iterativo). Escribe `.harness/adoption/PROPOSAL.md`: qué se va a crear, qué dirá cada documento,
   el backlog semilla y —si aplica— el plan de movimiento. Cada afirmación lleva `[evidencia: ruta:línea]` o va
   marcada `[SIN VERIFICAR — confirmar]`. El humano corrige, se vuelve a proponer. Nada más se toca todavía.

5. **Apply (estructura).** Crea `.harness/` + `docs/`, genera la documentación desde la propuesta, siembra el
   backlog en estado `backlog` (nunca `ready`: son ideas sin refinar), genera los adaptadores.
   **Nunca sobrescribe** un fichero existente: si ya hay `README.md` o `docs/`, escribe al lado y lo reporta.

6. **Restructure** (D5) — mover el código, si hay línea base verde y el humano ha dicho que sí.
   Genera `RESTRUCTURE-PLAN.md` con el `git mv` exacto de cada fichero y la lista de referencias a reescribir;
   `--dry-run` se queda aquí. Después, bucle por lotes: mover un directorio → reescribir sus referencias →
   `harness gate` → si empeora respecto a la línea base, **revertir el lote y parar**. Todo acaba en un único
   commit de reestructuración en su propia rama.

7. **Rewrite references.** Parte del mismo lote, nunca diferido: imports, rutas relativas, `pyproject.toml`,
   `tsconfig.json` paths, `Dockerfile`, workflows de CI, `pytest.ini`, cobertura, `MANIFEST.in`, entry points.
   El informe lista **qué ficheros de configuración se han tocado**, uno por uno.

8. **Verify + informe.** `harness doctor`, gates completos, y un informe final que dice: qué quedó documentado,
   qué quedó `[SIN VERIFICAR]`, qué ficheros se movieron, qué configuración se reescribió, y qué tiene que
   rellenar el humano.

El riesgo real de este comando es doble. Que el agente escriba documentación segura de sí misma y equivocada, lo
mitigan la evidencia enlazada, las marcas de incertidumbre, los gates que tienen que ejecutarse de verdad y la
propuesta iterada antes de aplicar. Que el movimiento de código rompa algo en silencio, lo mitigan las seis
condiciones de D5 — y sobre todas, la línea base de gates: **sin oráculo no se mueve**.

Monorepo: `project.json` admite `packages: [{path, gates, areas}]`; un backlog compartido, áreas por paquete, y
la reestructuración se decide y ejecuta **por paquete**, nunca de golpe.

---

## 8. Gates de calidad y tooling

```json
"gates": {
  "format":    { "run": "ruff format .", "check": "ruff format --check .", "required": true },
  "lint":      { "run": "ruff check .", "required": true },
  "typecheck": { "run": null, "status": "not-configured" },
  "test":      { "run": "pytest -q", "required": true, "coverage_min": 70 },
  "build":     { "run": null, "status": "n/a" },
  "start":     { "run": "uvicorn app.main:app --reload" }
}
```

Un gate `not-configured` se salta con aviso y **no bloquea**: la plantilla tiene que servir a un proyecto a
medio equipar. La *definition of done* es exactamente "gates requeridos en verde + todos los AC resueltos".

Scripts del harness (todos `harness <cmd>`, exit≠0 si fallan, usables por comando, hook o CI):
`validate` (tareas contra schema) · `index` (regenera `index.json` + `BOARD.md`) · `lint-backlog` (ids
duplicados, ciclos de dependencias, padres huérfanos, `ready` sin AC) · `generate [--check]` (adaptadores) ·
`gate <nombre>` · `task <sub>` · `area <ruta>` · `sync` · `doctor [--fix]` (todo lo anterior + rutas del
CODEMAP que ya no existen + docs rancios + adaptadores desincronizados).

**Cómo sabemos que el harness funciona**: fixtures de esquema (válidas e inválidas), test *golden-file* de
`generate`, un proyecto Python de mentira en `tests/fixtures/` sobre el que CI ejecuta `/adopt`, y el test del
camino de lectura de §4.

---

## 9. Capa multi-proveedor

`harness generate` lee `.harness/` y escribe los adaptadores. Cada fichero generado abre con:

```
<!-- GENERADO por harness v1.0.0 desde .harness/agents/implementer.md — no editar; ejecuta `harness generate` -->
```

`harness generate --check` sale con 1 si hay deriva (apto para CI). Se activa/desactiva por proveedor en
`project.json`. Escotillas de escape: `.harness/overrides/<proveedor>/` se fusiona literal al final, y las
regiones `<!-- harness:keep -->` se preservan entre regeneraciones.

| Capacidad | Claude Code | AGENTS.md | Cursor | Copilot |
|-----------|-------------|-----------|--------|---------|
| Subagentes | sí | no → sección de roles + prompts | no | no |
| Slash commands | sí | no → `docs/runbooks/<cmd>.md` | parcial | no |
| Hooks | sí | no | no | no |
| Permisos de herramientas | sí | no | no | no |
| Reglas por fichero | vía hooks | no | sí (`.cursor/rules`) | parcial |

**La degradación es el punto interesante**: un comando que un proveedor no puede expresar no desaparece, se
convierte en un *runbook* numerado en `docs/runbooks/` que el humano pega como prompt. Se pierde comodidad,
no capacidad. Los detalles exactos de formato de Cursor y Copilot van marcados **verificar** antes de
implementar el adaptador; no vamos a inventar sintaxis.

Versionado: `.harness/VERSION` + `harness upgrade` aplicando `.harness/migrations/` + CHANGELOG disciplinado.

**Hooks que merece la pena enviar** (nombres de evento **a verificar** contra la doc de Claude Code):
tras editar un task JSON → `validate` + `index`; bloquear ediciones a ficheros con la cabecera GENERADO;
formatear al editar usando el gate `format`; gate previo al commit.

---

## 10. Sync con ClickUp (opcional)

**Interfaz de adaptador** (`.harness/integrations/<proveedor>/adapter.mjs`): `listRemote`, `fetchRemote`,
`createRemote`, `updateRemote`, `mapStatus`, `unmapStatus`. ClickUp es la implementación de referencia; Jira,
Linear o GitHub Projects entran después sin tocar el núcleo.

**Mapeo de campos** (jerarquía ClickUp: Workspace → Space → Folder → List → Task):

| Harness | ClickUp |
|---------|---------|
| `id` | campo personalizado de texto **Harness ID**, con prefijo de proyecto: `PANGEA · FEAT-0042` (§5.1) |
| `title` | `name` |
| `description` + AC | `description` en Markdown, AC como checklist |
| `status` | estado de la lista, por nombre — mapeo **identidad**, ver abajo |
| `priority` | `priority` 1–4 (1 = urgent) |
| `type` | `tags` (`feat`, `fix`, …), redundante con el prefijo del id pero es lo que ClickUp sabe filtrar |
| `labels` | `tags` |
| `assignee` | `assignees` (requiere mapa de usuarios en config) |
| `parent` | subtarea |
| `depends_on` | dependencias nativas de ClickUp — **verificar** endpoint |
| `estimate_hours` | time estimate — **verificar** unidad (ms) |
| `branch`, `links.pr` | campos personalizados tipo URL |

**Estados: mapeo identidad.** Como la List destino la creamos nosotros desde cero, sus estados se definen
**idénticos a la máquina de estados del harness** (§5.2): `backlog · ready · in progress · in review · blocked ·
complete · cancelled`, marcando `complete` y `cancelled` como estados cerrados. Así `mapping.json` es la
identidad y desaparece de golpe toda una clase de bugs de traducción. El fichero sigue existiendo para el día en
que haya que sincronizar contra una lista ajena.

**Plan de pago de empresa** ⇒ campos personalizados, dependencias y estimaciones nativas disponibles: no hay
degradación. No usamos *custom task IDs* de ClickUp: el id canónico es el nuestro y viaja en el campo
personalizado.

**Dirección y conflictos.** Push, y solo push (D6). El estado de sync vive en `external.clickup`
(`id, url, list_id, last_synced_at, content_hash`). Se empuja si el hash local difiere del guardado.
Si el `date_updated` remoto es posterior a `last_synced_at`, alguien editó la tarjeta a mano: se **avisa** y se
empuja de todos modos (el repo manda), dejando el aviso en el log. No hay `pull`, ni resolución de conflictos,
ni `--adopt-remote`: son alcance descartado, no pendiente.
`--dry-run` es el modo por defecto de la primera ejecución. Log de auditoría en `sync.log.jsonl` (gitignored).

**Secretos y fallo seguro.** Token en `CLICKUP_API_TOKEN` (`.env` gitignored, nunca en el JSON de tarea ni en
la config). Sin token, `/sync` imprime *"sync deshabilitada"* y sale 0: el harness entero sigue funcionando.
Endpoints v2 previstos (`POST /list/{id}/task`, `PUT /task/{id}`, `GET /list/{id}/task`,
`GET /list/{id}/field`, `POST /task/{id}/field/{id}`), cabecera de autorización, límites de rate y paginación:
**todo marcado verificar contra la documentación oficial** en la tarea correspondiente antes de escribir el
cliente.

---

## 11. Flujo diario y trabajo en paralelo

```
idea → /task new → /plan FEAT-0042 → [humano confirma AC] → /implement FEAT-0042
     → [gates+AC verdes] → /review → /commit → PR → [humano mergea] → /task status done → /sync
```

Ramas fallidas contempladas: tests en rojo (vuelve a implementar, máx. 2 vueltas y para), AC imposible (pasa a
`blocked` con razón), tarea más grande de lo pensado (`/task split` la parte y la original se vuelve `epic`).

**Paralelismo.** El *claim* es `assignee` + `claimed_at` + existencia de la rama, todo visible en git. Para
trabajo simultáneo real, un *worktree* por tarea. `/status` delata las dos derivas típicas: ramas sin tarea
asociada y tareas `in_progress` sin commits en N días.

**Vista no técnica.** El tablero de ClickUp y `BOARD.md`. Convención de higiene: los títulos de tarea se
escriben para un humano de negocio, sin rutas de fichero ni identificadores de código — el `reviewer` lo
comprueba durante el grooming.

---

## 12. Plan por fases

**Prefijo de ids del propio harness: `HRN-`.** Fases independientemente útiles: al final de cada una hay algo
que puedes usar, sin necesitar la siguiente.

### Fase 0 — Cimientos (utilizable a mano el primer día)

| id | tipo | tarea | entregables | criterios de aceptación |
|----|------|-------|-------------|------------------------|
| HRN-0001 | feature | JSON Schema de tarea | `template/.harness/schema/task.schema.json` | valida el ejemplo de §5.4 · rechaza estado inválido, AC sin `check`, id mal formado |
| HRN-0002 | feature | JSON Schema de proyecto + `project.json` de ejemplo | `schema/project.schema.json`, `project.json` | valida ejemplos Python y Node · un gate `not-configured` es válido |
| HRN-0003 | docs | `ENTRYPOINT.md` y el camino de lectura | `template/.harness/ENTRYPOINT.md` | ≤120 líneas · lista los 4 ficheros de §4 · declara las prohibiciones duras |
| HRN-0004 | docs | Plantillas del set documental | `template/docs/{ARCHITECTURE,CODEMAP,CONVENTIONS,ENVIRONMENT,GLOSSARY}.md`, `areas/_template.md`, `adr/_template.md` | cada plantilla declara qué contiene y **qué no** · frontmatter con `updated` y `owner` |
| HRN-0005 | docs | Convenciones git | sección en `CONVENTIONS.md`, `templates/pr.md` | gramáticas de rama y commit de §7.2 con ejemplos válidos e inválidos |
| HRN-0006 | chore | Dogfooding: este plan → backlog | `.harness/backlog/tasks/HRN-*.json` | toda tarea de §12 existe como JSON y valida contra el schema |

*Salida de fase*: puedes crear tareas a mano y un agente puede implementar una leyendo 4 ficheros.

### Fase 1 — CLI núcleo

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0007 | feature | Dispatcher `harness.mjs` + shims PS1/sh | `harness --help` funciona idéntico en PowerShell y bash · cero dependencias · exit codes documentados |
| HRN-0008 | feature | `harness validate` | valida todas las tareas · sale 1 y señala fichero+campo en el fallo |
| HRN-0009 | feature | `harness index` | regenera `index.json` y `BOARD.md` · idempotente (dos ejecuciones, mismo byte) |
| HRN-0010 | feature | `harness lint-backlog` | detecta id duplicado, ciclo de dependencias, padre huérfano, `ready` sin AC |
| HRN-0011 | feature | `harness task new/show/next/claim/set-status/retype` | `new --type feat` asigna id con contador por tipo sin colisión · `retype` solo funciona en `backlog` y renombra el fichero · `set-status` rehúsa transiciones ilegales de §5.2 · `next` responde con 1 lectura de `index.json` |
| HRN-0012 | feature | `harness gate <nombre>` + `harness area <ruta>` | ejecuta el gate declarado · `not-configured` sale 0 con aviso · `area` resuelve ruta→área por globs |

*Salida de fase*: backlog validado, tablero generado, transiciones de estado forzadas por máquina.

### Fase 2 — Agentes y comandos (Claude Code primero)

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0013 | feature | Esqueleto de prompt + los 6 agentes canónicos | 6 ficheros en `.harness/agents/` · cada uno ≤150 líneas · cada uno con `forbidden` no vacío |
| HRN-0014 | feature | `harness generate` → adaptador Claude Code | genera `CLAUDE.md`, `.claude/agents/*`, `.claude/commands/*` · cabecera GENERADO · `--check` sale 1 ante deriva |
| HRN-0015 | feature | Formato canónico de comando + proyección | frontmatter documentado · `$ARGUMENTS`, `allowed-tools` y `argument-hint` correctos en la salida |
| HRN-0016 | feature | `/task`, `/status`, `/doctor` | `/status` cabe en una pantalla · `/doctor` detecta los 5 problemas de §8 |
| HRN-0017 | feature | `/plan` y `/verify` | `/plan` produce `plan.md` con pasos y riesgo · `/verify` emite veredicto por AC con evidencia |
| HRN-0018 | feature | `/implement` (los 10 pasos de §7.1) | rehúsa dependencias abiertas · reanuda desde `handoff.json` · para en los 4 checkpoints humanos |
| HRN-0019 | feature | `/commit` + apertura de PR | rehúsa en rama por defecto · mensaje convencional con `Refs:` · rama `feat/0042-slug` sin repetir el tipo · empuja siempre · abre PR solo al llegar a `in_review` y nunca duplica uno existente · sin `gh` imprime la URL · nunca mergea |
| HRN-0020 | feature | `/review` y `/handoff` | `review.md` con veredicto y hallazgos localizados · `/handoff` deja el estado reanudable |

*Salida de fase*: ciclo de vida completo de una tarea, de idea a PR, ejecutado sobre el propio backlog del harness.

### Fase 3 — `/adopt` (brownfield)

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0021 | feature | Etapa survey + línea base de gates | detecta stack y gates de un proyecto Python y de uno Node · registra qué gate pasa, falla o no existe · cero escrituras |
| HRN-0022 | feature | Etapa interview iterativa | ≤4 preguntas por ronda · prefiere confirmar inferencias a preguntar en abierto · persiste en `interview.json` · una segunda ejecución no repite preguntas |
| HRN-0023 | feature | Etapas infer + propose | genera `adoption/PROPOSAL.md` · toda afirmación con evidencia o marca `[SIN VERIFICAR]` · admite corrección y re-propuesta |
| HRN-0024 | feature | Etapa apply (estructura) + verify | no sobrescribe ningún fichero existente · gates inferidos ejecutados de verdad · backlog semilla en estado `backlog` |
| HRN-0025 | feature | Perfiles de layout | `.harness/layouts/{python,node-ts}.json` declaran la estructura destino · `layout: "as-is"` desactiva el movimiento |
| HRN-0026 | feature | Reescritura de referencias | reescribe imports y las 8 familias de config de D5 · inventario de ficheros tocados en el informe |
| HRN-0027 | feature | Motor de reestructuración por lotes | `git mv` siempre · exige árbol limpio · rehúsa sin línea base verde y emite tareas en su lugar · revierte el lote si un gate empeora · commit único en rama propia · `--dry-run` genera `RESTRUCTURE-PLAN.md` sin tocar nada |
| HRN-0028 | chore | Fixture + test de adopción en CI | `/adopt` sobre `tests/fixtures/sample-python-project` produce un harness que pasa `doctor` · un segundo fixture sin tests demuestra que la reestructuración se rehúsa y se convierte en tareas |

*Salida de fase*: puedes adoptar un repo real y obtener documentación con evidencia, backlog sembrado y —si hay
red de seguridad— el código movido a la estructura del harness con las referencias reescritas.

### Fase 4 — Multi-proveedor (opcional)

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0029 | feature | Adaptador `AGENTS.md` + runbooks de degradación | todo comando sin equivalente tiene runbook en `docs/runbooks/` |
| HRN-0030 | spike | Verificar formatos de Cursor y Copilot | documento con la sintaxis confirmada; cero invención |
| HRN-0031 | feature | Overrides, keep-regions y matriz de capacidades | la regeneración preserva `harness:keep` · `docs/PROVIDERS.md` publicada |
| HRN-0032 | feature | `VERSION` + `harness upgrade` | migración de prueba 1.0→1.1 aplica y es idempotente |

### Fase 5 — ClickUp (opcional)

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0033 | spike | Verificar API v2 de ClickUp | endpoints, auth, rate limit, campos personalizados y dependencias confirmados contra la doc oficial |
| HRN-0034 | chore | Crear la List destino y sus campos personalizados | 7 estados idénticos a §5.2 (`complete` y `cancelled` cerrados) · campos `Harness ID`, `Branch`, `PR` creados · ids anotados en `config.json` |
| HRN-0035 | feature | Interfaz de adaptador + `mapping.json` identidad | mapeo de estados editable sin tocar código · adaptador sustituible por otro proveedor |
| HRN-0036 | feature | Cliente y `harness sync --push [--dry-run]` | idempotente (dos ejecuciones, cero cambios remotos) · sin token sale 0 con aviso · aviso de deriva remota sin intentar mezclar · log de auditoría |

### Fase 6 — Endurecimiento y publicación

| id | tipo | tarea | criterios de aceptación |
|----|------|-------|------------------------|
| HRN-0037 | feature | `policy.json` + hooks | edición de fichero GENERADO bloqueada · task JSON editado dispara `validate` |
| HRN-0038 | chore | Autotests + CI | golden-file de `generate` · fixtures de schema · test del camino de lectura con presupuesto de líneas |
| HRN-0039 | docs | `README.md` + `QUICKSTART.md` | orienta en <2 min · greenfield y brownfield en pasos numerados |

### Fuera de alcance (deliberado)

Sync bidireccional completo · **refactorizar** código en `/adopt` (mover ficheros sí, reescribir su lógica no) ·
reestructurar sin red de seguridad de tests · sustituir la revisión humana ·
UI propia (ClickUp y `BOARD.md` ya lo cubren) · orquestador de agentes propio (usamos el del proveedor) ·
gestión de sprints, estimaciones agregadas o burndown.

### Riesgos principales

1. **Documentación que envejece en silencio** → contramedida: `doctor` verifica rutas mecánicamente, y el paso
   de `scribe` va *dentro* de `/implement`, no como ritual aparte.
2. **Ceremonia que nadie sigue** → P3: todo artefacto lo lee un agente o lo verifica un script.
3. **Documentación inventada en `/adopt`** → evidencia enlazada + marcas de incertidumbre + gates ejecutados +
   confirmación humana.
4. **La reestructuración rompe el proyecto en silencio** → las seis condiciones de D5, y sobre todas: línea base
   de gates como oráculo, lotes pequeños con verificación entre lotes, y un único commit revertible.
5. **El backlog se separa de la realidad** → `/status` delata ramas sin tarea y tareas estancadas.
6. **Formatos de proveedor que cambian** → los adaptadores son la única capa acoplada, y se regeneran.

---

## 13. Registro de decisiones

Resueltas el 18/08/2026:

| # | Decisión | Resolución | Dónde vive |
|---|----------|-----------|------------|
| 1 | Identificadores | `<TIPO>-<NNNN>` con contador por tipo, congelado al salir de `backlog`; prefijo de proyecto solo en ClickUp | §5.1 |
| 2 | Runtime de tooling | **Node.js**, `.mjs`, cero dependencias | D2 |
| 3 | Idioma | Prompts en inglés · docs y tareas en español · `output_language` como configuración | D8 |
| 4 | `/commit` y PRs | Push automático; PR automático al llegar a `in_review`; revisión y merge humanos | §7.2 |
| 5 | ClickUp | Plan de empresa, List nueva, mapeo identidad de estados, solo push, sin `pull` ni `--adopt-remote` | D6, §10 |
| 6 | Alcance de `/adopt` | Sí mueve y reorganiza el código y actualiza config y docs · sesión iterativa con entrevista al humano · sujeto a las seis condiciones de D5 | D5, §7.3 |

### Orden de trabajo acordado

`/adopt` fabrica JSONs de tarea, documentos y ficheros de adaptador — pero la forma exacta de esas tres cosas se
decide en las Fases 0–2. Construirlo primero sería montar la fábrica antes de decidir qué produce, y escribirlo
dos veces. Por tanto:

1. **Fases 0–2**: harness funcional en Claude Code, ciclo completo de idea a PR, validado sobre su propio backlog.
2. **Adopción manual de un proyecto real** usando los agentes que ya existen: `planner` escribe las tareas,
   `scribe` los documentos, y la reestructuración se hace a mano con `implementer` sobre una rama, aplicando ya
   las condiciones de D5. Se obtiene el proyecto adoptado sin que `/adopt` exista, sirve de prueba de aceptación
   del harness entero, y —lo importante— produce el guion literal que la Fase 3 va a automatizar.
3. **Fase 3**: construir `/adopt` grabando ese proceso ya validado, en vez de adivinándolo.

### Pendiente

- **Proyecto piloto para el paso 2**: cuál es, lenguaje, **si tiene tests que pasen** (determina si la
  reestructuración es posible o hay que crear antes la red de seguridad, D5 condición 6), y si tiene
  documentación. Un caso raro (monorepo, cero tests, docs muy desactualizadas) puede alterar el orden de la
  Fase 3.

---

## ClickUp: mapeo y verificaciones pendientes

Movido aquí desde `docs/areas/integrations.md`, que se salía del presupuesto del camino de lectura. Es
material de diseño sin verificar: no es contexto que haga falta para trabajar en el área hoy.

## Mapeo de campos a ClickUp

Jerarquía: Workspace → Space → Folder → List → Task.

| Harness | ClickUp |
|---------|---------|
| `id` | campo personalizado de texto **Harness ID**, con prefijo de proyecto: `HRN · FEAT-0042` |
| `title` | `name` |
| `description` + criterios | `description` en Markdown, criterios como checklist |
| `status` | estado de la lista, por nombre — **mapeo identidad** |
| `priority` | `priority` 1–4 (1 = urgent) |
| `type` | `tags` |
| `labels` | `tags` |
| `assignee` | `assignees`, vía el mapa `integrations.clickup.users` |
| `parent` | subtarea |
| `depends_on` | dependencias nativas — **[VERIFY]** endpoint exacto |
| `estimate_hours` | time estimate — **[VERIFY]** unidad (¿ms?) |
| `branch`, `links.pr` | campos personalizados tipo URL |

**Mapeo identidad de estados**: la List destino se crea desde cero con exactamente los siete estados del
harness (`backlog`, `ready`, `in progress`, `in review`, `blocked`, `complete`, `cancelled`, los dos
últimos marcados como cerrados). Así `mapping.json` es la identidad y desaparece una clase entera de
bugs de traducción.

## Trampas conocidas y verificaciones pendientes

Todo lo que sigue debe confirmarse contra la documentación oficial **antes** de escribir el cliente. No
se implementa sobre esto tal como está:

- **[VERIFY]** base `https://api.clickup.com/api/v2` y forma exacta de la cabecera de autorización con
  un token personal.
- **[VERIFY]** endpoints: crear tarea en una lista, actualizar tarea, listar tareas de una lista, listar
  campos personalizados, fijar el valor de un campo personalizado.
- **[VERIFY]** límite de peticiones por minuto y cabeceras de rate limit, para respetarlo con backoff.
- **[VERIFY]** paginación de la lista de tareas.
- **[VERIFY]** endpoint de dependencias y unidad del time estimate.

