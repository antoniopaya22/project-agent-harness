---
updated: 2026-08-21
owner: Antonio Payá
---

# Matriz de capacidades por proveedor

> Contiene: qué sabe hacer cada proveedor de agentes, a qué se proyecta cada concepto canónico
> del harness, y qué se pierde cuando no hay equivalente. No contiene: cómo funciona el
> generador (eso es [`docs/areas/adapters.md`](areas/adapters.md)) ni por qué existe la capa de
> proveedor (eso es [`docs/HARNESS-PLAN.md`](HARNESS-PLAN.md), D3).

Lo que sigue **está verificado contra documentación oficial**, con la fuente al lado. Donde no
lo esté, lo dice. Un adaptador construido sobre sintaxis recordada a medias es peor que no tener
adaptador: parece funcionar y falla en silencio.

## Lo que el harness necesita de un proveedor

Seis cosas, en orden de cuánto duele perderlas:

| Capacidad | Para qué | Si no está |
|-----------|----------|------------|
| Instrucciones de proyecto | El camino de lectura en frío y las reglas duras | No hay harness: es el mínimo |
| Roles con herramientas acotadas | Un agente que no puede tocar lo que no le toca | Los roles pasan a ser prosa: prohibiciones que el agente recuerda, no que el proveedor impide |
| Comandos invocables | `/implement`, `/commit`, `/plan` | Degradan a runbooks: el humano ejecuta los pasos |
| Nivel de modelo por rol | No quemar el modelo caro en una tarea mecánica | El proveedor elige; la sugerencia de `harness tier` queda informativa |
| Automatismos ante eventos | Que la regla sea mecanismo y no recordatorio | Las reglas duras vuelven a ser buena voluntad |
| Ámbito por ruta | Instrucciones distintas por área | Todo el contexto en un solo fichero, y el presupuesto se dispara |

## La matriz

| | Claude Code | AGENTS.md (universal) | Cursor | Copilot |
|---|---|---|---|---|
| Instrucciones de proyecto | `CLAUDE.md` | `AGENTS.md` | `.cursor/rules/*.mdc` | `.github/copilot-instructions.md` |
| Roles | `.claude/agents/<id>.md` con `tools:` | sección de prosa | un `.mdc` por rol, sin herramientas acotadas | no hay |
| Comandos | `.claude/commands/<id>.md` | `docs/runbooks/<id>.md` | regla de aplicación manual, por `@mención` | no hay |
| Nivel de modelo | `model: haiku\|sonnet\|opus` | no hay | no hay | no hay |
| Automatismos | `.claude/settings.json`, hooks | no hay | no hay | no hay |
| Ámbito por ruta | no hay | no hay | `globs:` en el front-matter | `applyTo:` en `.github/instructions/*.instructions.md` |
| Estado en el harness | **generado** | **generado** | pendiente (FEAT-0023) | pendiente (FEAT-0024) |

## Formato de cada proveedor, verificado

### Claude Code

Front-matter de un agente: `name`, `description`, `tools`, `model`. Comandos: `argument-hint`,
`allowed-tools`, `model`. Los hooks van en `.claude/settings.json` bajo `hooks.PreToolUse` y
`hooks.PostToolUse`, con `matcher` y una lista de `{ type: "command", command }`.

Es el proveedor canónico del harness y el único con las seis capacidades. Verificado por uso:
lo que genera este repositorio se ejecuta en Claude Code.

### AGENTS.md

Un solo fichero markdown en la raíz, sin front-matter y sin vocabulario propio. No es un
proveedor sino el mínimo común: lo que queda cuando no se puede contar con nada más. Todo lo que
en Claude Code es estructura, aquí es prosa. Copilot también lo lee (ver más abajo), lo que lo
convierte en la apuesta más rentable de las cuatro.

### Cursor

- Directorio: **`.cursor/rules`**, un fichero por regla, extensión **`.mdc`** (obligatoria: un
  `.md` en ese directorio se ignora, porque no lleva front-matter).
- Front-matter, exactamente tres campos: **`description`** (texto), **`globs`** (patrón de
  ficheros), **`alwaysApply`** (booleano).
- Cuatro modos de aplicación: siempre, por criterio del agente a partir de la `description`, por
  `globs`, y manual por `@mención`.
- Se pueden organizar en subcarpetas dentro de `.cursor/rules`.
- Referencias a otros ficheros con `@fichero.ts`.
- Precedencia: reglas de equipo → de proyecto → de usuario.

**[SIN VERIFICAR]** si `.cursorrules` (el formato antiguo de fichero único) sigue soportado: la
documentación oficial ya no lo menciona, y "no lo menciona" no es lo mismo que "está retirado".
El adaptador no debe escribirlo.

Consecuencia para el adaptador: los roles caben (un `.mdc` por agente, `alwaysApply: false` y
`description` para que el agente decida), pero **sin herramientas acotadas**, así que `writes` y
`forbidden` degradan a prosa. Lo que Cursor tiene y Claude Code no es `globs`: permite proyectar
cada documento de área como una regla con su ámbito, que es exactamente el camino de lectura
corto pero automático.

Fuente: [Rules | Cursor Docs](https://cursor.com/docs/rules).

### GitHub Copilot

- Instrucciones para todo el repositorio: **`.github/copilot-instructions.md`**. Soportado en
  Copilot en GitHub, en la revisión de código y en los IDE.
- Instrucciones por ruta: directorio **`.github/instructions`**, ficheros
  **`NOMBRE.instructions.md`**, con **`applyTo`** en el front-matter (sintaxis de glob). Campo
  opcional **`excludeAgent`**, con valores `code-review` o `cloud-agent`.
- **Las instrucciones por ruta solo funcionan hoy en el agente en la nube y en la revisión de
  código de github.com**, no en el IDE. Es la limitación que decide el diseño del adaptador.
- Copilot también lee **`AGENTS.md`** en cualquier punto del repositorio (gana el más cercano) y
  `CLAUDE.md` en la raíz.

Consecuencia: **el adaptador de Copilot es casi gratis**. `AGENTS.md`, que ya se genera, cubre el
caso de agente; lo único que aporta un adaptador propio es `.github/copilot-instructions.md` para
las superficies que no leen `AGENTS.md`, y los ficheros `.instructions.md` por área. Sin roles ni
comandos: no existen en el modelo de Copilot y fingir lo contrario sería inventar sintaxis.

Fuente: [Add repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions).

## Cómo degrada lo que no cabe

La regla es la misma en los cuatro casos y se aplica sin excepción: **lo que el proveedor no
puede hacer se escribe como prosa en el prompt, no se omite y no se finge**.

| Concepto canónico | Degradación |
|---|---|
| `capabilities` | Frase en el prompt: «solo puedes leer y editar; nada más». |
| `writes` / `forbidden` | Reglas duras en el cuerpo, en imperativo. |
| `model` | Se omite: sugerir un nivel que el proveedor no entiende no ayuda a nadie. |
| Comandos | Runbook en `docs/runbooks/`, con los pasos que el humano ejecuta. |
| Automatismos | Se omite el mecanismo y **se mantiene la regla escrita**, que es de donde venía. |

## Lo que no se hará

- **No se escribe `.cursorrules`.** Formato antiguo, sin confirmación de que siga vivo.
- **No se inventan campos de front-matter.** Los de Cursor son tres y los de Copilot dos; si
  hace falta un tercero, es que el concepto no cabe y toca degradarlo a prosa.
- **No se proyectan roles a Copilot.** No existen en su modelo.
