---
updated: 2026-08-18
owner: Antonio Payá
---

# Arquitectura

> Este documento describe **la forma del sistema**: sus piezas, sus límites y cómo se relacionan.
> No dice dónde está cada fichero (eso es [CODEMAP](CODEMAP.md)) ni cómo se escribe código
> (eso es [CONVENTIONS](CONVENTIONS.md)).

## Qué es esto

Una plantilla de *harness*: una estructura que se deja caer sobre un proyecto de software para que
agentes de código trabajen en él con backlog, roles, comandos y documentación acotada. Funciona con
Claude Code hoy, y está construida para no depender de ese proveedor.

## Las cuatro capas

```
                    ┌──────────────────────────────────────────┐
   Adaptadores      │ CLAUDE.md · .claude/ · AGENTS.md          │  GENERADOS
   (por proveedor)  │ docs/runbooks/                            │  nunca se editan a mano
                    └───────────────▲──────────────────────────┘
                                    │  harness generate
                    ┌───────────────┴──────────────────────────┐
   Definiciones     │ .harness/agents/   .harness/commands/     │  fuente de verdad
   canónicas        │ .harness/schema/   .harness/layouts/      │  neutral de proveedor
                    └───────────────▲──────────────────────────┘
                                    │  leen
                    ┌───────────────┴──────────────────────────┐
   Datos            │ .harness/backlog/tasks/*.json            │  el estado del proyecto
                    │ .harness/project.json                    │
                    │ .harness/workspace/<ID>/                 │
                    └───────────────▲──────────────────────────┘
                                    │  manipula
                    ┌───────────────┴──────────────────────────┐
   CLI              │ .harness/bin/harness.mjs + lib/          │  lo determinista
                    └──────────────────────────────────────────┘
```

**La regla que define el sistema**: los adaptadores no contienen conocimiento propio. Son proyecciones.
Si una instrucción vive solo en `CLAUDE.md`, está en el sitio equivocado y se perderá en la siguiente
regeneración.

## Las tres fronteras que importan

**Determinista vs. juicio.** Todo lo que puede comprobar una máquina lo comprueba el CLI: transiciones
de estado, validación de esquema, ciclos de dependencias, presupuestos de líneas, deriva de
adaptadores. Los agentes solo hacen lo que requiere juicio. Esta frontera es la que evita que el
harness dependa de la buena voluntad de un modelo.

**Datos vs. vistas.** Los ficheros de tarea son la verdad; `index.json` y `BOARD.md` son vistas
generadas. Un conflicto de merge en una vista no se resuelve a mano: se regenera.

**Capacidad vs. permiso.** Cada agente declara `writes` y `forbidden`. La separación
`tester`/`implementer` es el ejemplo central: el tester no puede arreglar el código, y por eso su
veredicto vale algo.

## Flujo de una tarea

```
/task new ──> backlog ──/plan──> ready ──/implement──> in_progress ──/verify──> in_review ──humano──> done
                                             │                                       │
                                             └── planner · implementer · tester ──────┘
                                                 · scribe · reviewer
```

`/implement` orquesta a los agentes y para en cuatro puntos donde decide un humano: confirmación de
criterios, plan de riesgo alto, dos verificaciones fallidas, y el paso a `done`.

## Decisiones estructurales

Las decisiones de diseño con su razonamiento están en [HARNESS-PLAN.md](HARNESS-PLAN.md) §2 (D1–D8).
Las que más condicionan el código:

- **Node sin dependencias** (D2): el tooling debe ser inerte respecto al proyecto anfitrión. Sin venv,
  sin lockfile, sin resolución de paquetes.
- **Un fichero JSON por tarea** (D3): un backlog monolítico genera conflicto en cada rama.
- **El estado vive en disco** (D4): `.harness/workspace/<ID>/handoff.json` sobrevive a un reinicio de
  contexto, y por eso `/implement` es reanudable.
- **Sync de una sola dirección** (D6): el repo manda; ClickUp es una proyección de lectura.

## Qué no es

No es un gestor de proyectos, ni un CI, ni un framework de agentes. No sustituye la revisión humana:
ningún agente puede marcar una tarea como `done`.
