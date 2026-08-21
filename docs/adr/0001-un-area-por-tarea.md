---
updated: 2026-08-21
owner: Antonio Payá
---

# ADR 0001 — Una tarea pertenece a un área y solo a una

**Estado:** aceptada
**Fecha:** 2026-08-21
**Reemplaza a:** —
**Resuelve:** SPIKE-0004

## El problema

`context.area` es hoy un solo valor. Las tareas reales cruzan áreas: cinco de las de este
repositorio tocaron el CLI y la documentación a la vez, y una tocó cuatro. Con un solo área hay
que elegir una y mentir un poco, o partir la tarea.

Partir es la disciplina acertada la mayoría de las veces. El resto de las veces es una camisa de
fuerza: hay cambios que **no se pueden** partir sin dejar el repositorio roto entre las dos
mitades — renombrar un concepto que aparece en el código y en su documento, o mover un fichero y
arreglar sus referencias.

La alternativa evidente, permitir varias áreas, diluye precisamente lo que justifica todo el
diseño: si una tarea trae tres documentos de área, el camino de lectura en frío pasa de cuatro
ficheros a seis, y el presupuesto de 6.500 tokens se rompe con dos áreas y salta por los aires
con tres.

## Los datos que había

`harness read-log report` sobre el trabajo de este repositorio, y las tareas cerradas:

- De 70 tareas medidas, **ninguna** declaró más de un área, porque no puede.
- De las 3 tareas con lecturas registradas fuera del camino previsto, **1 cruzó áreas** (leyó
  `cli` desde una tarea de `docs`). Una de tres.
- Los presupuestos por documento de área hoy: entre 1.200 y 2.100 tokens. Dos áreas caben en el
  presupuesto total con lo justo; **tres no caben** sin subir el techo.
- Tres documentos de área de cinco han estado al borde del presupuesto durante esta sesión, y en
  dos ocasiones hubo que sacar contenido. Es decir: el presupuesto ya está tenso con un área.

La muestra es pequeña y el propio informe lo dice: con tres tareas registradas, «una de tres» es
una anécdota. **No hay datos suficientes para justificar el cambio**, y eso es en sí mismo el
resultado del spike.

## La decisión

**Se mantiene un área por tarea.** Con dos precisiones que quitan la mayor parte del dolor sin
tocar el modelo:

1. **El área es dónde vive el cambio, no todo lo que roza.** Una tarea del CLI que además
   actualiza `docs/areas/cli.md` es una tarea de `cli`: el documento es una consecuencia del
   cambio, no un segundo sitio donde trabajar. Esto ya es lo que ocurre en la práctica y
   resuelve la mayoría de los casos que parecían cruzados.
2. **Lo que de verdad cruza se declara en `context.files`, no en un segundo área.** `files` no
   tiene tope por diseño (es trabajo, no orientación) y ya sirve para señalar los ficheros de
   fuera. Lo que se pierde así es el *documento* de la otra área, y ahí es donde entra la
   siguiente parte.
3. **Cuando falte contexto de otra área, se registra**, con `harness read-log add`. Si al cabo
   de veinte tareas una pareja de áreas aparece junta sistemáticamente, la respuesta no es
   permitir dos áreas: es que **esas dos áreas son una sola** y hay que unirlas.

## Consecuencias

- El presupuesto del camino de lectura **no cambia**: sigue siendo un documento de área.
- El caso legítimamente indivisible sigue existiendo y sigue siendo incómodo. Se paga con una
  lectura de más, registrada, en lugar de con un presupuesto roto para todos.
- Se acepta un coste concreto: una tarea que toca dos áreas de verdad tendrá un documento de área
  que no menciona la mitad del trabajo. El registro de lecturas es lo que lo hace visible.
- **Lo que reabriría esta decisión**, dicho por adelantado para que no se reabra por costumbre:
  veinte tareas registradas con más de un tercio cruzando áreas, y la pareja de áreas repetida
  siendo distinta cada vez. Si siempre es la misma pareja, el arreglo es unir áreas.

## La alternativa que se descartó, y a qué precio

Permitir `context.areas` como lista, con el presupuesto total repartido entre ellas.

Se descarta porque el reparto no funciona: un documento de área está escrito para leerse entero
—lo dice su propia plantilla— y la mitad de un documento de área no es la mitad del contexto,
es un documento del que no te puedes fiar. La opción honesta sería subir el techo, y subir el
techo es exactamente cómo el camino de lectura deja de ser corto.
