# Línea base posterior a las etapas 0 y 1 — 2026-10-23

Código medido:
- Conduit `develop` @ `84e0840` más la refactorización del banco (`stack.ts`, `scenario-runner.ts`, `run-load.ts`).
- Leonice `feat/whatsapp-operations` @ `6dc04e6`.
- Modelo `claude-haiku-5-5`, tier FREE. Topes diario y por minuto levantados por defecto.

Reproducir: `pnpm bench:baseline`. Datos: [`results.json`](results.json) · tabla por caso: [`summary.md`](summary.md). La línea base anterior (`e0c3ac1`) sigue en `../2026-10-21/`.

## Antes y después

| Métrica | 2026-10-21 (`e0c3ac1`) | 2026-10-23 (`84e0840`) |
|---|---|---|
| Aciertos sin fallos conocidos | 32/38 | 38/39 |
| Fallos conocidos reproducidos | 5/5 | 0/4 |
| Razonamiento (thinking), parte de la salida | 62 % | 0 % |
| Tokens de salida por turno IA p50 / p95 | 352 / 800 | 195 / 501 |
| Costo por conversación p50 / p95 | US$ 0,00110 / 0,00248 | US$ 0,00035 / 0,00122 |
| Conversaciones que caben en el tope diario | 34 | 95 |
| Latencia mensaje→respuesta p50 / p95 | 10,97 s / 13,22 s | 10,37 s / 13,56 s |
| Gasto de la corrida | US$ 0,0567 | US$ 0,0232 |

## Caso b38 (dos clientas a la vez, misma conexión)

Pasa. A recibió el precio del spa coreano y B la dirección y el horario, cada una en su turno. Antes, la conversación de B guardaba ambos mensajes y A no recibía respuesta (C1).

## Estado de b14, b21 y b44 tras esta corrida

Verificado con corridas parciales posteriores (`BENCH_ONLY`), no con una corrida completa:

- b21: la bandera `genérico-por-herramienta` venía de `applyToolFailureDiscipline`, que sustituía la respuesta si cualquier llamada de la herramienta había fallado, aunque una llamada posterior de la misma herramienta saliera bien. Ahora solo cuenta un fallo sin recuperar (`hasUnrecoveredToolFailure`). En la corrida parcial el turno 2 ofrece horarios reales.
- b14: queda marcado como fallo conocido P1. El bot no tiene forma de saber si la clienta ya existe: `registrar_cliente` solo con el teléfono responde 201 tanto si la crea como si ya existía, y pide los términos del servicio otra vez. Fallaba también en la línea base anterior. Un cambio de prompt que llamaba a `registrar_cliente` primero rompió b13 (409 para clienta nueva activa el mensaje genérico), así que no se aplicó.
- b44 (nuevo, "¿Qué día es hoy?"): pasa y responde "jueves, 22 de octubre de 2026".
- b13 y b18 varían entre corridas con el mismo código (b18 pasó 2 de 2 al repetirlo; b13 se queda sin turnos del guion cuando el bot pide los consentimientos uno por uno).
- Cuatro corridas completas posteriores a esta (03:49 a 11:27 UTC) salieron inválidas: el proceso de Conduit estuvo suspendido unos 16 minutos a mitad de corrida (el log no tiene líneas entre 11:28:08 y 11:44:00 y los temporizadores de 8 s dispararon tarde), lo que produce timeouts. No se usaron como línea base. Para repetir la línea base completa conviene dejar el equipo despierto y con la tapa abierta.

## Cambios al banco desde la línea base anterior

- Expectativas de b03, b08, b09 y b24 pasaron de exigir una herramienta a exigir el contenido de la respuesta.
- b14 pide el próximo lunes a las 9am en vez del jueves a las 2pm.
- Los fallos conocidos C3, A1 y A2 no se reprodujeron; no se determinó qué cambio los corrigió.
- Se añadió `pnpm bench:load` (`run-load.ts`).

## Diferencias con producción y no verificado

Igual que en la línea base anterior: sin limitador de envío ni "escribiendo…", topes del modelo levantados, `BusinessSettings` ficticios, una conexión simulada por trabajador, descarga de imágenes fallida por diseño. No verificado: entrega real por WhatsApp, LID y reconexiones, latencia real hacia Leonice, topes por minuto bajo concurrencia real.

## Etapa 5 — despachador de intenciones (2026-10-26)

Misma muestra (56 conversaciones, 69 turnos), modelo real, dos modos del despachador. Corridas: `2026-10-26T16-06-49` (SOMBRA) y `2026-10-26T16-18-32` (ACTIVO, `INTENT_DEFAULT_MODE=ACTIVE`).

| Métrica | SOMBRA (= comportamiento anterior) | ACTIVO |
|---|---|---|
| Turnos sin IA (directo/plantilla) | 0 de 69 | 17 de 69 (24,6 %) |
| Tokens de entrada, total | 1 115 615 | 806 933 (−27,7 %) |
| Tokens de salida, total | 16 354 | 11 726 (−28,3 %) |
| Costo total del banco | $0,0327 | $0,0228 (−30,5 %) |
| Aciertos | 49/52 | 49/52 |
| Latencia mensaje→respuesta p50, turnos sin IA | — | 8,1 s (casi todo es la espera de 8 s del debounce) |

- SOMBRA no cambia ningún turno: todas las rutas siguen en IA y el despachador solo registra 15 clasificaciones.
- Los fallos (b10, b13, b40) son la variación conocida del modelo en turnos que siguen yendo a la IA; b40 falla igual en ambos modos.
- `expectActive` en `scenarios.json` fija lo esperado cuando la intención responde sin IA (p. ej. cancelar entrega el enlace en vez de cancelar en el chat).
- Los casos b48, b49, b54 y b55 son negativos: parecen una intención pero deben ir a la IA, y en modo ACTIVO lo hacen.
