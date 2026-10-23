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

## Pendiente en esta corrida

- b14 falla: no usó `crear_reserva_whatsapp`. Se cambió la fecha del caso a "el próximo lunes a las 9am"; no está investigada la causa.
- b21 tiene la bandera `genérico-por-herramienta` en su segundo turno.

## Cambios al banco desde la línea base anterior

- Expectativas de b03, b08, b09 y b24 pasaron de exigir una herramienta a exigir el contenido de la respuesta.
- b14 pide el próximo lunes a las 9am en vez del jueves a las 2pm.
- Los fallos conocidos C3, A1 y A2 no se reprodujeron; no se determinó qué cambio los corrigió.
- Se añadió `pnpm bench:load` (`run-load.ts`).

## Diferencias con producción y no verificado

Igual que en la línea base anterior: sin limitador de envío ni "escribiendo…", topes del modelo levantados, `BusinessSettings` ficticios, una conexión simulada por trabajador, descarga de imágenes fallida por diseño. No verificado: entrega real por WhatsApp, LID y reconexiones, latencia real hacia Leonice, topes por minuto bajo concurrencia real.
