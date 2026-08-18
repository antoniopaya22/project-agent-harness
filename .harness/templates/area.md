---
area: <id>
updated: AAAA-MM-DD
owner: <persona o equipo>
---

# Área: <nombre>

> Este documento es el **paso 4 del camino de lectura en frío**: un agente que trabaja en una tarea de
> esta área lo lee entero y no necesita nada más para entender el contexto. Presupuesto: 300 líneas.
> Si crece más, el área es demasiado grande y hay que partirla.

## Qué hace esta área

Dos o tres frases. Su responsabilidad, y su límite: qué **no** es asunto suyo.

## Cómo está organizada

| Pieza | Dónde | Responsabilidad |
|-------|-------|-----------------|
|       |       |                 |

Solo lo que un agente necesita para orientarse. La lista exhaustiva de ficheros está en el código, no
aquí.

## Flujo principal

El recorrido típico de una petición, un job o un caso de uso a través de esta área. Nombra los
ficheros por los que pasa, en orden.

## Invariantes

Las reglas que este código asume siempre ciertas y que romper causaría un fallo silencioso. Esto es lo
más valioso del documento — es lo que un agente no puede deducir leyendo una función.

- …

## Trampas conocidas

Lo que ha morderdido a alguien antes. Cada entrada con la evidencia: un commit, un incidente, un test.

- …

## Cómo añadir algo nuevo aquí

Los dos o tres casos habituales, con la ruta exacta donde va cada cosa. Si la respuesta está en
`docs/CODEMAP.md`, enlázala y no la repitas.

## Dependencias

De qué otras áreas depende esta, y quién depende de ella. Solo los acoplamientos reales.
