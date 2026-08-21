---
area: definitions
updated: 2026-08-18
owner: Antonio Payá
verified_commit: a85a96155978
---

# Área: Definiciones canónicas

## Qué hace esta área

Contiene la **fuente de verdad neutral de proveedor**: los esquemas, las definiciones de los seis
agentes, las de los comandos, los perfiles de layout y las plantillas. Todo lo que un proveedor concreto
consume se genera desde aquí.

Su límite: aquí no hay código ejecutable. Son datos y prompts.

## Cómo está organizada

| Pieza | Dónde | Responsabilidad |
|-------|-------|-----------------|
| Esquema de tarea | `.harness/schema/task.schema.json` | La forma de una tarea, exhaustiva |
| Esquema de proyecto | `.harness/schema/project.schema.json` | Gates, áreas, git, proveedores, `read_path` |
| Agentes | `.harness/agents/*.md` | Un rol por fichero, con front-matter |
| Comandos | `.harness/commands/*.md` | Un comando por fichero, con front-matter |
| Perfiles de layout | `.harness/layouts/*.json` | Estructura destino por lenguaje, para `/adopt` |
| Plantillas | `.harness/templates/*.md` | ADR, cuerpo de PR, documento de área |
| Entrada en frío | `.harness/ENTRYPOINT.md` | Las reglas duras y el camino de lectura |

## El front-matter de un agente

```yaml
id: implementer          # coincide con el nombre del fichero
purpose: ...             # una frase; se convierte en `description` del proveedor
inputs: [...]            # qué recibe
outputs: [...]           # qué produce
writes: [...]            # dónde puede escribir, y en ningún otro sitio
forbidden: [...]         # obligatorio y no vacío
capabilities: [read, search, edit, shell, web, delegate, ask]
network: true|false
model: fast | primary | deep
effort: low | medium | high
```

`capabilities` y `model` son **neutrales**: el generador los traduce a los nombres del proveedor
(`read` → `Read`, `primary` → `sonnet`). Nunca escribas nombres de herramientas de un proveedor aquí:
eso rompe la independencia.

## Invariantes

- **`forbidden` no puede estar vacío en un agente.** `doctor` falla si lo está. El razonamiento es el
  centro del diseño: un rol se justifica por lo que *no* puede hacer. El `tester` existe precisamente
  porque no puede arreglar el código, y por eso su veredicto vale algo.
- **`purpose` es obligatorio** en agentes y comandos: es lo que el proveedor usa para decidir cuándo
  invocarlos.
- **Los prompts van en inglés; los entregables en español** (D8). El idioma de salida lo inyecta el
  generador desde `output_language`, no se escribe en cada prompt.
- **Todos los agentes siguen el mismo esqueleto de secciones**: `Role and limit` · `What to read` ·
  `Procedure` · `Never` · `Output format` · `When to stop and ask`. Un roster que se lee distinto en cada
  fichero es un roster que nadie audita.
- **Máximo ~150 líneas por definición.** `doctor` avisa a partir de 200. Un prompt que nadie lee es un
  prompt que no existe.
- El `id` del front-matter coincide con el nombre del fichero.

## Trampas conocidas

- El lector de front-matter (`parseFrontMatter` en `lib/util.mjs`) soporta escalares, arrays en línea
  `[a, b]` y listas de bloque `- item`. **No soporta objetos anidados ni cadenas multilínea.** Si
  necesitas eso, la señal es que el formato está desviándose, no que haya que ampliar el parser.
- Un `#` dentro de un valor se interpreta como comentario si va precedido de espacio. Entrecomilla el
  valor si lo necesitas.
- Cambiar `id` renombra el agente o comando generado, pero **no borra el fichero antiguo** en
  `.claude/`. Bórralo a mano.
- Añadir una palabra clave nueva a un esquema exige añadirla también a `KNOWN` en `lib/schema.mjs`, o el
  validador la reportará como no soportada.

## Cómo añadir algo nuevo aquí

Un agente: `.harness/agents/<id>.md` con el esqueleto completo y `forbidden` no vacío; después
`harness generate`. Un comando: `.harness/commands/<id>.md`. Un campo de tarea: el esquema primero,
luego `KEY_ORDER` en `lib/tasks.mjs`. Un perfil de layout: copia la forma de `layouts/python.json`.

Antes de añadir un **agente** nuevo, comprueba que no es un rol existente con otro sombrero. La lista
tiene seis por decisión, no por falta de ideas: cada uno aporta una prohibición que ningún otro puede
darle. Si el nuevo agente no aporta una prohibición nueva, no es un agente.

## Dependencias

`lib/generate.mjs` consume todo esto. `lib/schema.mjs` consume los esquemas. `/adopt` consumirá los
perfiles de layout.
