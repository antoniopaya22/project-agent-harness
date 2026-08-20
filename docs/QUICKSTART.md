---
updated: 2026-08-18
owner: Antonio Payá
---

# Guía de arranque

> Los dos caminos: proyecto nuevo y proyecto ya en marcha. Para el razonamiento detrás de cada decisión,
> [HARNESS-PLAN](HARNESS-PLAN.md); para la forma del sistema, [ARCHITECTURE](ARCHITECTURE.md).

Requisitos: Node ≥ 20 y git. Sin instalación de dependencias.

---

## Camino A — proyecto nuevo

Un comando:

```bash
node <ruta-al-harness>/.harness/bin/harness.mjs init . --name mi-proyecto   --purpose "Un párrafo: para qué existe esto y quién lo usa."
```

Instala el harness, detecta tu stack **desde la evidencia** (los scripts que de verdad
existen en `package.json`, la configuración real de `pyproject.toml`), propone áreas a
partir de los directorios que hay, crea el documento de cada una, genera los adaptadores y
deja `harness doctor` en verde. Lo que no puede deducir lo deja marcado `[RELLENAR]` y lo
enumera al final: un propósito inventado que suena plausible es peor que un hueco visible.

Nunca sobrescribe un fichero que ya existiera, y dice cuáles respetó.

Después, rellena lo que te señaló y sigue en el paso 5. Los pasos manuales de abajo quedan
como referencia de qué hace el comando por dentro.

### 1. Copiar el harness (manual, si prefieres verlo)

```bash
git clone <este-repo> mi-proyecto
cd mi-proyecto
rm -rf .git && git init
```

Borra el backlog de la plantilla, que es el de este proyecto y no el tuyo:

```bash
rm .harness/backlog/tasks/*.json
```

### 2. Describir el proyecto

Edita `.harness/project.json`. Cuatro cosas, y solo cuatro:

```jsonc
{
  "project": {
    "name": "mi-proyecto",
    "purpose": "Un párrafo: para qué existe esto y quién lo usa. No lo inventes ni lo dejes vacío — es lo que un agente lee para entender el contexto.",
    "output_language": "es"
  },
  "gates": {
    // Los comandos reales de tu proyecto. Lo que no exista todavía: status "not-configured".
    "lint": { "run": "ruff check .", "required": true },
    "test": { "run": "pytest -q", "required": true },
    "typecheck": { "run": null, "status": "not-configured" }
  },
  "areas": [
    // Una rebanada del código con su documento. Empieza con dos o tres; añadir es fácil.
    { "id": "api", "globs": ["src/api/**"], "doc": "docs/areas/api.md" }
  ],
  "layout": "python"  // o "node-ts", o "as-is" para prohibir mover ficheros
}
```

Lo demás (convenciones de git, proveedores, presupuestos del camino de lectura) tiene valores por
defecto sensatos.

### 3. Crear el documento de cada área

```bash
cp .harness/templates/area.md docs/areas/api.md
```

Rellénalo. La sección que más importa es **Invariantes**: lo que este código asume siempre cierto y que
romper causaría un fallo silencioso. Es lo que un agente no puede deducir leyendo una función.

### 4. Comprobar y generar

```bash
./harness doctor        # falla mientras falte un documento de área declarado — es el orden correcto
./harness generate      # escribe CLAUDE.md, .claude/ y AGENTS.md
./harness doctor        # verde
```

### 5. Primera tarea

```bash
./harness task new --type feature --title "Registro de usuario con verificación por email" --area api
```

Nace en `backlog` con un criterio de relleno. **No puede pasar a `ready` hasta que tenga criterios
reales**, y eso es lo que hace `/plan`:

```
/plan FEAT-0001        # el planner escribe criterios con comprobación y fija el contexto
                       # → te muestra los criterios y espera tu confirmación
/implement FEAT-0001   # el ciclo completo hasta el PR
```

---

## Camino B — proyecto que ya existe

> `/adopt` automatizará esto. Todavía no está construido (fase 3), así que aquí está el proceso manual,
> que es exactamente el que el comando va a automatizar. Hacerlo a mano una vez es además la mejor forma
> de descubrir qué debería hacer el comando.

### 1. Copiar solo el harness, sin tocar el proyecto

Desde la raíz de tu proyecto:

```bash
cp -r <ruta-al-harness>/.harness .
cp <ruta-al-harness>/harness <ruta-al-harness>/harness.ps1 <ruta-al-harness>/harness.cmd .
rm .harness/backlog/tasks/*.json
rm -rf .harness/workspace/*
```

Nada de tu código se mueve en este paso. Si ya tienes `docs/`, no lo toques: escribiremos al lado.

### 2. Capturar la línea base de calidad — antes de cambiar nada

Esto es lo más importante de todo el camino B. Averigua los comandos **reales** de tu proyecto mirando
la evidencia — `package.json`, `pyproject.toml`, `Makefile`, el workflow de integración continua — y no
la convención que te suene. Después ejecútalos y **anota el resultado**:

```bash
pytest -q ; echo "test exit=$?"
ruff check . ; echo "lint exit=$?"
```

Esa foto es el oráculo: si más adelante mueves ficheros, es lo único que te dice si rompiste algo.
Decláralos en `gates` de `.harness/project.json`. Un comando que no llegaste a ejecutar con éxito se
declara `not-configured`, no se apunta como si funcionara.

### 3. Descubrir las áreas con evidencia, no con intuición

Los ficheros que más se tocan son los que de verdad importan:

```bash
git log --format= --name-only -n 2000 | sort | uniq -c | sort -rn | head -30
```

Cruza eso con los directorios de código reales y saldrán tres o cuatro áreas. Decláralas y crea su
documento desde la plantilla.

### 4. Documentar con el redactor, marcando lo que no se puede probar

```
/plan  → invoca al planner para crear las tareas de documentación
```

o directamente, invocando al agente `scribe` sobre un área. La regla que hace útil el resultado: **cada
afirmación lleva su evidencia** (`[evidencia: src/api/app.py:31]`) o va marcada
`[SIN VERIFICAR — confirmar]`. Documentación segura de sí misma y equivocada es peor que no tener
documentación, porque el siguiente agente se la cree.

Responde tú lo que el código no puede decir: el propósito del proyecto, quién lo usa, los términos de
dominio, qué está deprecado y dónde duele. Eso va a `project.purpose`, a `docs/GLOSSARY.md` y a las
trampas conocidas de cada área.

### 5. Sembrar el backlog

```bash
grep -rn "TODO\|FIXME" --include="*.py" . | head -40
gh issue list --limit 50            # si usas GitHub
```

Cada uno se convierte en una tarea **en `backlog`**, nunca en `ready`: son ideas sin refinar y marcarlas
como listas sería mentir sobre su estado.

### 6. Reorganizar el código — solo si tienes red de seguridad

Si en el paso 2 los tests no pasaban, **no muevas nada**: no habría forma de saber si el movimiento
rompió algo. Crea antes una tarea para conseguir una red de seguridad mínima.

Con la línea base en verde:

```bash
git switch -c chore/0001-reorganizar-al-layout-del-harness
git mv src/foo.py src/mipaquete/foo.py     # git mv, para preservar historial
# reescribe los imports y la configuración que apuntaba al sitio antiguo
./harness gate test                         # ¿sigue igual que la línea base?
```

Por lotes pequeños, verificando entre lotes, y **revirtiendo el lote** si un gate empeora. Todo en un
único commit de reorganización, en su propia rama: revertir tiene que ser un solo comando.

La parte que más se olvida no es mover, es lo que apuntaba al sitio antiguo: imports, empaquetado,
`testpaths`, cobertura, `Dockerfile`, workflows de integración continua. `.harness/layouts/python.json`
tiene la lista de familias de configuración a revisar.

### 7. Cerrar

```bash
./harness generate
./harness doctor
./harness status
```

---

## Primeros tropiezos habituales

| Síntoma | Causa y arreglo |
|---------|-----------------|
| `doctor` dice que un documento de área no existe | Declaraste el área antes de crear su documento. Es el orden correcto: créalo desde `.harness/templates/area.md` |
| `set-status ... ready` se niega | El mensaje dice exactamente qué falta. Satisfácelo; no lo rodees |
| `read-path` dice `(no area set)` | La tarea está sin refinar. `/plan` la arregla |
| `commit` se niega en `main` | Correcto. Crea la rama de la tarea, que el propio mensaje te dice |
| Un fichero generado vuelve a cambiar | Lo editaste a mano. Cambia su fuente en `.harness/`, o usa `.harness/overrides/` |
| `next` no propone nada | O nada está `ready`, o todo lo que lo está tiene dependencias abiertas. `harness task list --open` lo aclara |
