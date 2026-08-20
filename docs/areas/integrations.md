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

Proyecta el backlog a una herramienta visual para que perfiles no técnicos vean el estado del proyecto.
ClickUp es la implementación de referencia.

Su límite: **una sola dirección**. El repositorio es la fuente de verdad, porque para cambiar el estado
de una tarea hay que tocar el código. Nadie edita tarjetas.

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
