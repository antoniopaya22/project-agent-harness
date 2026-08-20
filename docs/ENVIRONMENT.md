---
updated: 2026-08-18
owner: Antonio Payá
---

# Entorno

> Prerequisitos, secretos y cómo ejecutar las cosas. Los **comandos** concretos de calidad no se
> documentan aquí: viven en `gates` de `.harness/project.json` y se ejecutan con
> `harness gate <nombre>`. Un comando escrito en dos sitios acaba divergiendo.

## Prerequisitos

| Herramienta | Versión | Para qué | Obligatoria |
|-------------|---------|----------|-------------|
| Node.js | ≥ 20 (probado en 22) | Ejecutar el CLI. Cero dependencias, sin `npm install` | sí |
| Git | ≥ 2.30 | Todo el flujo de ramas y commits | sí |
| GitHub CLI (`gh`) | cualquiera | Abrir PRs automáticamente. Sin él, `harness commit` imprime la URL | no |

No hay `package.json` ni `node_modules`. Es deliberado: el harness se copia dentro de proyectos ajenos
y no debe interferir con su gestor de paquetes.

## Ejecutar el CLI

```bash
node .harness/bin/harness.mjs status
```

Con los shims, el nombre del comando es el mismo en las tres shells:

```bash
./harness status          # bash / zsh
.\harness.ps1 status      # PowerShell
harness.cmd status        # cmd.exe
```

## Gates

Se declaran una vez en `.harness/project.json` y se invocan siempre igual:

```bash
node .harness/bin/harness.mjs gate lint
node .harness/bin/harness.mjs gate test
node .harness/bin/harness.mjs gates          # todos los bloqueantes, con resumen
```

Un gate en estado `not-configured` o `n/a` se salta con aviso y **no bloquea**. Un gate `required` en
rojo bloquea el commit.

## Variables de entorno

| Variable | Para qué | Si falta |
|----------|----------|----------|
| `HARNESS_ACTOR` | Quién actúa por defecto (`implementer`, `tester`, …) cuando no se pasa `--as` | Se asume un humano |
| `CLICKUP_API_TOKEN` | Sincronización con ClickUp | `harness sync` avisa y sale con 0; todo lo demás funciona |
| `NO_COLOR` | Desactiva el color | Color solo si hay TTY |

## Secretos

- **Nunca** en ficheros de tarea, en `.harness/project.json` ni en un commit. `doctor` tiene una
  comprobación específica que falla si algo con forma de credencial aparece ahí.
- Los tokens van en `.env`, que está en `.gitignore`.
- La configuración guarda **identificadores** (por ejemplo el `list_id` de ClickUp), nunca credenciales.

## Primera vez en el repositorio

```bash
node .harness/bin/harness.mjs doctor
node .harness/bin/harness.mjs status
```

`doctor` en verde significa que esquemas, backlog, adaptadores, presupuestos del camino de lectura y
rutas del mapa del código están sanos. Es la comprobación que conviene ejecutar antes de empezar y
antes de abrir un PR.
