---
updated: 2026-08-18
owner: Antonio Payá
---

# Proveedores

> Qué puede expresar cada herramienta de agentes, qué no, y cómo degrada lo que no puede.
> Los mecanismos de generación están en [areas/adapters](areas/adapters.md); aquí está el estado.

## Matriz de capacidades

| Capacidad | Claude Code | `AGENTS.md` | Cursor | Copilot |
|-----------|-------------|-------------|--------|---------|
| Instrucciones de raíz | `CLAUDE.md` | `AGENTS.md` | *sin verificar* | *sin verificar* |
| Subagentes con permisos propios | sí | no → sección de roles | no | no |
| Comandos de barra | sí | no → guías en `docs/runbooks/` | *sin verificar* | no |
| Restricción de herramientas por rol | sí | no | no | no |
| Automatismos ante eventos | sí | no | no | no |
| Reglas por patrón de fichero | vía automatismos | no | sí, se cree | parcial |

**Estado de implementación**: Claude Code y `AGENTS.md` están generados y con test de no-deriva. Cursor y
Copilot tienen su interruptor en `providers` de `.harness/project.json` pero **el generador todavía no
los implementa**, porque su formato real no está verificado. Prefiero un hueco declarado a un adaptador
construido sobre sintaxis recordada a medias.

## Cómo degrada lo que falta

La pregunta correcta no es qué se pierde, sino si se pierde **capacidad** o solo **comodidad**.

**Sin comandos de barra** → cada comando se genera además como guía numerada en `docs/runbooks/<id>.md`.
Es el mismo contenido; el humano lo pega como instrucción en lugar de escribir `/implement`. Se pierde
comodidad.

**Sin subagentes** → `AGENTS.md` describe cada rol con sus límites y el agente adopta uno a la vez
explícitamente. Es más frágil que un subagente con permisos reales, porque la separación pasa a depender
de que el modelo la respete en lugar de que la herramienta la imponga. Aquí sí se pierde algo: la
separación `tester`/`implementer` es lo que hace fiable la verificación, y sin subagentes es una
promesa en lugar de una restricción.

**Sin restricción de herramientas ni automatismos** → las reglas duras siguen escritas, pero nadie las
fuerza salvo el CLI. Por eso el CLI comprueba todo lo comprobable: `harness` rehúsa una transición
ilegal, un commit en rama protegida o un `done` puesto por un agente **independientemente del
proveedor**. Esa es la red que sobrevive a cualquier degradación.

## Lo que nunca depende del proveedor

- El CLI completo: backlog, gates, validación, generación, autodiagnóstico.
- El esquema de tarea y la máquina de estados con sus guardas.
- El camino de lectura y sus presupuestos.
- Las convenciones de git y la política de commit y PR.
- La documentación.

Un proyecto adoptado sigue siendo utilizable a mano, sin ningún agente, solo con `harness`.

## Añadir un proveedor

El procedimiento está en [areas/adapters](areas/adapters.md#cómo-añadir-un-proveedor). Antes de escribir
el mapeo, **verifica el formato contra la documentación oficial del proveedor** y actualiza la matriz de
arriba quitando el «sin verificar». Ese orden no es burocracia: es la diferencia entre un adaptador que
funciona y uno que parece funcionar.
