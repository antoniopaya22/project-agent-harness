---
area: docs
updated: 2026-08-18
owner: Antonio Payá
verified_commit: a85a96155978
---

# Área: Documentación

## Qué hace esta área

El set documental del harness y las plantillas con las que se documenta un proyecto adoptado. Es la capa
que hace corto el camino de lectura en frío: sin ella, un agente tendría que deducir la arquitectura
leyendo código.

Su límite: **la documentación no da instrucciones a los agentes**. Las reglas duras viven en
`.harness/ENTRYPOINT.md` y en las definiciones de agente. `docs/` explica el proyecto, no gobierna al
agente.

## Cómo está organizada

| Documento | Contiene | No contiene |
|-----------|----------|-------------|
| `README.md` | Puerta de entrada humana, quickstart | Detalle de diseño |
| `docs/HARNESS-PLAN.md` | Decisiones de diseño con su razonamiento, y el roadmap | Estado actual del código |
| `docs/ARCHITECTURE.md` | La forma del sistema, sus fronteras | Rutas de ficheros, estilo |
| `docs/CODEMAP.md` | Dónde vive cada cosa, dónde va una cosa nueva | Razonamiento |
| `docs/CONVENTIONS.md` | Estilo de código, tests, git, documentación | Arquitectura |
| `docs/ENVIRONMENT.md` | Prerequisitos, variables, secretos | Los comandos de gate (viven en `project.json`) |
| `docs/GLOSSARY.md` | Términos de dominio con significado exacto | Cualquier otra cosa |
| `docs/areas/<id>.md` | Contexto profundo de una rebanada | Lo que ya diga otro documento |
| `docs/adr/NNNN-*.md` | Una decisión y sus consecuencias | Diseño en curso |
| `docs/PROVIDERS.md` | Matriz de capacidades por proveedor | — |
| `docs/runbooks/*` | **Generado**: comandos como prompt | — |

## Invariantes

- **Un tema, un dueño.** Ningún hecho aparece en dos documentos. Se enlaza. Esta es la invariante que
  hace posible el camino de lectura corto: si los documentos se solapan, el agente tiene que leerlos
  todos para saber cuál es verdad.
- **Cada documento declara qué contiene y qué no**, en su cita de apertura. Sin eso, la regla anterior se
  incumple por accidente.
- **Los presupuestos del camino de lectura se cumplen, y se miden en tokens**, no en líneas: los declara
  `read_path` con `max_tokens` en `.harness/project.json` y los hace cumplir `doctor`. Se cambió de
  líneas a tokens porque una tabla ancha y un párrafo corto ocupan lo mismo en líneas y muy distinto en
  contexto, que es el recurso real. Cuando un documento se pasa, se **saca** contenido; subir el
  presupuesto es cómo el camino de lectura deja de ser corto.
- **Toda ruta citada en `CODEMAP.md` existe.** `doctor` lo comprueba. Es el mecanismo anti-podredumbre
  que funciona, porque es mecánico y no depende de que nadie se acuerde.
- **Front-matter con `updated` y `owner`** en todo documento de `docs/`, salvo `HARNESS-PLAN.md`, que es
  un registro de decisiones y no tiene dueño único. Nada lo comprueba todavía: es una convención, no una
  invariante, y decir lo contrario sería una de esas afirmaciones que este documento existe para evitar.
- **Cada documento de área declara el commit contra el que se verificó** (`verified_commit`). `doctor` lo
  exige en cuanto el documento deja de ser la plantilla, y avisa cuando el área ha recibido más commits
  que el umbral desde entonces. Que existan las rutas citadas solo detecta un renombrado; esto detecta
  que el documento describe algo que ya cambió.
- **Un documento de área no pasa de 300 líneas.** Si lo hace, el área es demasiado grande: se parte el
  área, no el presupuesto.
- Documentación en español; prompts en inglés (D8).

## Trampas conocidas

- La comprobación de rutas de `doctor` mira **cualquier cosa entre comillas invertidas** que parezca una
  ruta. Si escribes un ejemplo con una ruta que no existe, el build falla. Usa una ruta real o describe
  el ejemplo sin comillas invertidas.
- `docs/runbooks/` es **generado**. Editarlo es tirar el trabajo: se pierde en el siguiente
  `harness generate`.
- Un documento de área no declarado en `areas` de `project.json` produce un aviso: o lo declaras o lo
  borras. Los ficheros que empiezan por `_` se ignoran (plantillas).

## Cómo añadir algo nuevo aquí

**Un área nueva**: declárala en `areas` de `.harness/project.json` (id, globs, doc) y crea su documento
desde `.harness/templates/area.md`. `doctor` falla hasta que el documento exista, que es el orden
correcto.

**Un ADR**: `docs/adr/NNNN-<slug>.md` desde `.harness/templates/adr.md`, numerado en secuencia. Un ADR
no se edita tras aceptarse: se sustituye por otro que lo referencia.

**Un documento nuevo del set**: piénsalo dos veces. La pregunta que decide es *¿qué hecho vive aquí que
no viva ya en otro documento?* Si la respuesta es "ninguno, pero es más cómodo tenerlo junto", no se
crea.

## Dependencias

`doctor` (en [cli](cli.md)) comprueba las invariantes de esta área. El agente `scribe` es quien escribe
aquí. `/adopt` genera este set en un proyecto adoptado, a partir de las plantillas.
