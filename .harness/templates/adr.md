---
adr: NNNN
title: <decisión, en una frase afirmativa: "Usar X para Y">
status: propuesta   # propuesta | aceptada | rechazada | sustituida por ADR-NNNN
date: AAAA-MM-DD
deciders: <quién decide>
area: <id de área, si aplica>
---

# ADR-NNNN — <título>

## Contexto

Qué situación fuerza a decidir ahora. Hechos, no opiniones: qué restricción existe, qué se rompió, qué
se necesita. Si hay evidencia, enlázala (`ruta/fichero.py:42`, un issue, una medición).

## Decisión

Qué se decide, en presente y en afirmativo. Una decisión, no tres.

## Alternativas consideradas

| Alternativa | Qué ofrecía | Por qué no |
|-------------|-------------|------------|
|             |             |            |

Una alternativa sin motivo de rechazo no estaba realmente considerada.

## Consecuencias

Qué se vuelve más fácil y qué se vuelve más difícil. Incluye lo que esta decisión **cierra**: qué
dejamos de poder hacer sin revertirla. Esta sección es la que hace útil el ADR seis meses después.

## Cómo revertir

Qué habría que deshacer y cuánto costaría. Si la respuesta es "no se puede", dilo: es información
crítica.

---

Un ADR registra una decisión y sus consecuencias. No es un documento de diseño y **no se edita tras
aceptarse**: se sustituye por otro ADR que lo referencia.
