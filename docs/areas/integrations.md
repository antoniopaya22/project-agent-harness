---
area: integrations
updated: 2026-08-18
owner: Antonio Payá
---

# Área: Integraciones con trackers externos

> **Estado: diseñada, no implementada.** El comando `harness sync` existe y sale con 0 avisando de que
> la integración está desactivada. El adaptador de ClickUp es la fase 5 del
> [plan](../HARNESS-PLAN.md#fase-5--clickup-opcional). Este documento es la especificación contra la que
> se construirá; lo que no esté verificado va marcado.

## Qué hace esta área

Proyecta el backlog a herramientas externas para que se vea el estado del proyecto sin tocar el
repositorio. **No es un cliente de una herramienta: es una proyección con N sumideros** (D9).

| Nivel | Destino | Coste de configuración |
|-------|---------|------------------------|
| **1, por defecto y siempre activo** | GitHub Issues + Projects | Ninguno: el transporte es `gh`, ya autenticado. **Cero secretos en el proyecto** |
| **2, opcional** | ClickUp, Jira, Linear… | Token, configuración y activación explícita |

Su límite: **una sola dirección**. El repositorio es la fuente de verdad, porque para cambiar el estado
de una tarea hay que tocar el código. Fuera se consulta, no se edita.

Cada sumidero reconcilia contra el repositorio por su cuenta y **ninguno habla con otro**: dos espejos
no pueden entrar en conflicto, solo pueden estar cada uno más o menos fresco. El fallo de un sumidero no
impide que los demás se completen.

## La interfaz de adaptador

Un adaptador vive en `.harness/integrations/<proveedor>/adapter.mjs` y exporta:

| Función | Contrato |
|---------|----------|
| `run(ctx, { dryRun })` | Punto de entrada que llama `harness sync`. Devuelve un código de `EXIT` |
| `listRemote(cfg)` | Las tareas remotas de la lista destino, paginadas |
| `fetchRemote(cfg, remoteId)` | Una tarea remota |
| `createRemote(cfg, task)` | Crea y devuelve `{ id, url }` |
| `updateRemote(cfg, task, remoteId)` | Actualiza |
| `mapStatus(status)` | Estado del harness → nombre de estado remoto |
| `unmapStatus(remote)` | La inversa, para detectar deriva |

Añadir Jira o Linear significa escribir otro directorio con estas funciones, sin tocar el núcleo.
Con GitHub y ClickUp la interfaz tiene **dos implementaciones reales**, que es la única forma de saber
si una abstracción está bien puesta.

### GitHub: el sumidero por defecto

Transporte: `gh` y `gh api graphql`, porque **los tableros de GitHub son solo GraphQL** — la API REST de
los proyectos clásicos está retirada. Requiere el scope `project` en el token
(`gh auth refresh -s project`); el token habitual solo trae `repo` y `workflow`.

| Harness | GitHub |
|---------|--------|
| tarea | incidencia, con los criterios como lista de comprobación |
| `id` | prefijo del título: `FEAT-0042 · …` |
| `status` | campo de selección única del tablero, **mapeo identidad** con los siete estados |
| `type`, `priority`, `context.area` | etiquetas |
| `parent` (épica) | sub-issue — **[VERIFY]** superficie exacta de la API |
| `branch`, `links.pr` | referencias cruzadas nativas |

### Verificado contra la API (20/08/2026)

Comprobado por introspección del esquema GraphQL, no de memoria:

| Necesidad | Resolución |
|-----------|-----------|
| Añadir una incidencia al tablero | `addProjectV2ItemById(projectId, contentId)` |
| Fijar el estado | `updateProjectV2ItemFieldValue(projectId, itemId, fieldId, value: { singleSelectOptionId })` |
| Descubrir los identificadores | **Una sola consulta**: `ProjectV2SingleSelectField` expone `id`, `name` y `options { id name }` |
| Crear el campo de estado con sus opciones | **Una sola mutación**: `createProjectV2Field(dataType: SINGLE_SELECT, singleSelectOptions: [...])` |
| Épicas como sub-issues | `addSubIssue(issueId, subIssueId)` existe en el esquema |

Fijar un estado necesita **cuatro** identificadores (proyecto, item, campo, opción). Los tres estables
—proyecto, campo, opciones— se descubren una vez y se guardan en la configuración; el del item es por
tarea y vive en `external.github`.

### El token de integración continua, y por qué importa al diseño

Una incidencia es un recurso **del repositorio**, así que el `GITHUB_TOKEN` de Actions puede escribirla
con permiso `issues: write`. Un tablero es un recurso **de usuario u organización**, así que ese token
no llega: hace falta un PAT o una App con scope `project`.

Eso no es un inconveniente, es el argumento del diseño de varios sumideros: en integración continua el
sumidero de incidencias funciona sin configurar nada y el del tablero se salta **avisando**, en lugar de
romper la construcción. Cada sumidero declara qué credencial necesita y se desactiva solo si le falta.

En local no hace falta ningún secreto: el transporte es `gh`, ya autenticado, con `gh auth refresh -s
project` para el tablero.

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

## Invariantes

- **Sin credencial, todo sigue funcionando.** Si falta `CLICKUP_API_TOKEN` o `enabled` es `false`,
  `harness sync` imprime un aviso y sale con **0**. Ningún otro comando depende de esta área (P4).
- **El token nunca se guarda en configuración ni en una tarea.** Solo en `.env`, que está en
  `.gitignore`. `doctor` falla si algo con forma de credencial aparece en un fichero de tarea.
- **Idempotencia**: dos ejecuciones seguidas no producen cambios remotos en la segunda. Se compara
  `content_hash` local con el guardado en `external.clickup`.
- **`--dry-run` es el modo por defecto de la primera ejecución.**
- **Nunca se resuelve un conflicto a ciegas.** Si `date_updated` remoto es posterior a
  `last_synced_at`, alguien editó la tarjeta a mano: se **avisa**, se empuja igual (el repo manda) y
  queda en el log.

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

No usamos los *custom task IDs* de ClickUp: el id canónico es el nuestro y viaja en un campo
personalizado.

## Cómo añadir un tracker

`.harness/integrations/<proveedor>/` con `adapter.mjs`, `config.json` (sin secretos) y `mapping.json`.
Registra el flag en `integrations` del esquema de proyecto. El log de auditoría va a
`sync.log.jsonl` dentro del directorio del proveedor y está en `.gitignore`.

## Dependencias

Consume los ficheros de tarea y `project.json`. Lo invoca el [CLI](cli.md) (`sync`). Nada depende de
esta área — y eso es deliberado.
