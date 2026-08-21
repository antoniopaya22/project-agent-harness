---
updated: 2026-08-21
owner: Antonio Payá
---

# ADR 0002 — Qué costaría saber si un cambio de prompt mejora, y qué se hace en su lugar

**Estado:** aceptada
**Fecha:** 2026-08-21
**Reemplaza a:** —
**Resuelve:** SPIKE-0005

## El problema

La mitad determinista de este harness tiene 419 pruebas. La mitad de juicio —las seis
definiciones de agente y los diez comandos, que son unas 1.800 líneas de prompt— **no tiene
ninguna**. No hay forma de saber si la definición del revisor de hoy es mejor que la de ayer.

Eso no es una laguna menor. La tesis del proyecto es que un buen refinamiento y un buen prompt
hacen el trabajo más corto y más correcto. La mitad que sostiene esa tesis es exactamente la que
nadie puede evaluar.

## Qué haría falta de verdad

Un banco de escenarios con veredicto esperado. Concretamente, para el agente que más se
beneficiaría (el **revisor**, porque su salida es un juicio comparable):

| Pieza | Qué es | Coste realista |
|---|---|---|
| Escenarios | Un diff real + la tarea + qué debería encontrar el revisor | 20–30 escenarios. **Lo caro es acertar el veredicto esperado**, no escribir el diff |
| Veredicto esperado | La lista de hallazgos que cuentan, y los que serían ruido | Una persona que conozca el código, ~15 min por escenario |
| Corredor | Ejecuta el prompt sobre cada escenario y compara | Un día de trabajo, y hay que decidir cómo se compara texto libre con una lista esperada |
| Criterio de comparación | Cuándo un hallazgo «es» el esperado | **Aquí está el problema real** |

Suma: del orden de **tres a cinco días** para el primer agente, más un coste por ejecución en
llamadas al modelo, más mantenimiento cada vez que el código de los escenarios cambia.

### El problema que hace que no salga la cuenta

Comparar la salida de un revisor con una lista esperada requiere decidir si «el manejo de
errores en `parseArgs` no cubre la flag repetida» y «`parseArgs` pierde flags duplicadas» son el
mismo hallazgo. Automatizarlo pide un modelo que juzgue la equivalencia, y entonces la calidad de
la evaluación depende de un prompt que tampoco se puede evaluar. Es el mismo problema una capa
más arriba.

Hacerlo a mano funciona y cuesta lo que cuesta revisar 25 salidas cada vez que se toca una
palabra de un prompt. A ese precio, nadie toca el prompt, que es peor que no tener evaluación.

## La decisión

**No se construye el banco de escenarios ahora.** No se justifica: cuesta entre tres y cinco
días, su criterio de comparación no está resuelto, y hay un sustituto de coste casi nulo que
cubre la mayor parte del valor.

Lo que **sí** se hace, y ya está hecho o es trivial:

1. **Lo que se puede comprobar mecánicamente de un prompt, se comprueba.**
   `tests/definitions.test.mjs` ya exige el esqueleto de secciones, que `forbidden` no esté
   vacío, que haya `purpose`, y el tope de 150 líneas. Eso no mide calidad, pero atrapa la
   regresión estructural, que es la más frecuente.
2. **La realimentación de refinamiento es el sustituto.** `harness read-log report` mide una
   consecuencia observable de la calidad del prompt y del refinamiento: cuántas lecturas hubo
   que hacer fuera de lo previsto. No dice si un prompt es bueno; dice **si empeoró**, que es la
   pregunta que de verdad se hace al cambiar uno.
3. **Un cambio de prompt se anota en el commit con lo que pretendía.** Sin eso no hay ni
   evaluación manual posible a posteriori.

## Cuándo revisar esta decisión

Tres condiciones, y hacen falta las tres:

- **Veinte tareas con lecturas registradas**, para que `read-log report` diga algo y no sea una
  anécdota. Hoy hay tres.
- **Un cambio de prompt que se sospeche que empeoró las cosas** y que el registro de lecturas no
  consiga confirmar ni descartar. Eso es la prueba de que el sustituto no basta.
- **Un solo agente que importe más que los demás.** Construir el banco para seis es seis veces el
  coste; para el revisor solo, puede salir.

## Lo que se acepta perder

Se acepta explícitamente que **la mitad de juicio del harness sigue sin verificar**, y que
cualquier afirmación sobre «prompts mejores» es hoy una opinión. El proyecto no debería afirmar
lo contrario en su documentación, y no lo hace: [`docs/HARNESS-PLAN.md`](../HARNESS-PLAN.md)
registra que `/implement` nunca se ha ejecutado con subagentes reales de punta a punta.

Registrarlo como límite conocido es la única cosa honesta que se puede hacer sin gastar los cinco
días.
