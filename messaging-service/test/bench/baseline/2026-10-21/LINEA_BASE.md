# Línea base — 2026-10-21

Código medido:
- Conduit `develop` @ `e0c3ac1` (sin cambios en `src/`).
- Leonice `feat/whatsapp-operations` @ `9b16506`.
- Bot `ea6cf0a6…` copiado de la base de desarrollo, sin plantilla ni ajustes propios (igual que hoy).
- Modelo `claude-haiku-5-5`, tier FREE.

Reproducir: `pnpm bench:baseline` (ver [README](../../README.md)). Datos: [`results.json`](results.json) · tabla por caso: [`summary.md`](summary.md).

## Números (corrida oficial `2026-10-22T00-47-14-891Z`)

| Métrica | Valor |
|---|---|
| Conversaciones / turnos | 43 / 56 (IA 50, ignorado 6, directo 0, plantilla 0) |
| Aciertos sin fallos conocidos | 32/38 |
| Fallos conocidos reproducidos | 5/5 (C1, C3, A1, A2 ×2) |
| Llamadas al modelo | 93 (p50 2 y p95 3 por turno) |
| Tokens de entrada por turno p50 / p95 | 8.902 / 13.936 |
| Tokens de salida por turno p50 / p95 | 352 / 800 |
| De la salida, razonamiento (thinking) | p50 168 / p95 754, **62 % de toda la salida** |
| Herramientas por turno p50 / p95 | 1 / 2 |
| Costo por turno p50 / p95 | US$ 0,00106 / 0,00169 |
| Costo por conversación p50 / p95 | US$ 0,00110 / 0,00248 |
| Costo proyectado por 1.000 conversaciones | US$ 1,32 |
| Tokens que cuenta Conduit por conversación (media) | 11.439 |
| **Conversaciones que caben en el tope diario de producción (400.000)** | **34** |
| Latencia mensaje→respuesta p50 / p95 | 10,97 s / 13,22 s (8 s son debounce) |
| Tiempo del modelo por turno p50 / p95 | 2,9 s / 5,2 s |
| Gasto de la corrida | US$ 0,0567 |

### Variación entre corridas (mismo código y banco)

| Corrida | Aciertos | Fallos conocidos | Costo/conv p50 · p95 | Thinking | Turnos cortados | Caben en el tope |
|---|---|---|---|---|---|---|
| 00-39-06 | 33/38 | 5/5 | 0,00111 · 0,00248 | 57 % | 12 | 33 |
| 00-42-57 | 34/38 | 5/5 | 0,00108 · 0,00297 | 55 % | 10 | 32 |
| 00-47-14 (oficial) | 32/38 | 5/5 | 0,00110 · 0,00248 | 62 % | 15 | 34 |

El modelo no es determinista: ±1 acierto por corrida. Para comparar antes y después en las etapas siguientes conviene correr el banco 3 veces por lado y comparar rangos.

## Fallos conocidos: reproducidos

| Id | Caso | Evidencia |
|---|---|---|
| C1 mezcla de chats | b38 | La conversación de B guardó `"Hola, quiero saber el precio del spa coreano\nBuenas, ¿dónde queda el spa?"`; A no recibió respuesta. |
| C3 fecha desconocida | b12 (y b10, b11, b14) | *"No tengo acceso a la fecha de hoy…"*. Sin fecha, el bot no consulta disponibilidad para "el viernes" ni para "mañana". |
| A1 turnos cortados o vacíos | b41 (y 15 turnos en total) | `stop_reason=max_tokens`; 2 envíos vacíos. |
| A2 promesa falsa de persona | b25, b26 | `registrar_comprobante_automatico` se rechaza dentro de Conduit (sin imagen o descarga fallida). Se envía "una persona de nuestro equipo se pondrá en contacto" y nadie del equipo es avisado. |

## Hallazgos nuevos de la línea base

1. **El razonamiento del modelo consume el `max_tokens` y produce los turnos vacíos y cortados (causa raíz de A1).**
   - Sonda directa: `stop tool_use, out 211, thinking_tokens 179` y `out 349, thinking 317`.
   - El tope es 400 (`PromptEngine.ts:110`). El 62 % de la salida es razonamiento y el p95 por turno (754) ya supera el tope.
   - Con texto vacío, `isTooSimilar('', anterior)` da `true` (`BotRouter.ts:966`) y regenera sin historial. Si también sale vacío: *"Reintento también similar… Descartando"*, y la clienta no recibe nada. En b13 y b21 el bot quedó mudo desde el segundo turno.
2. **El tope diario del modelo de producción alcanza para ~32–34 conversaciones al día.**
   - En la primera corrida, con los límites reales, el modelo se agotó en la conversación 26: `límite diario (408043/400000)`.
   - Desde ahí, todas las clientas recibieron *"nuestro asistente no está disponible"*.
   - El banco ahora levanta ese tope por defecto (`BENCH_KEEP_SOURCE_LIMITS=true` lo restaura).
3. **Una acción exitosa puede comunicarse como fallida (variante de A2).** En b19 (corrida 00-42-57):
   - `cancelar_reserva_whatsapp` dio 400 y luego 200; la cita quedó CANCELADA.
   - Aun así, la clienta recibió *"Tuvimos un inconveniente…"* (`BotRouter.ts:840-858`).
   - Al mismo tiempo, Leonice le envió la confirmación de cancelación: mensajes contradictorios.
4. **Pérdida del hilo tras un turno cortado.** En b13 (corrida 00-29-06), después de un turno truncado el bot volvió a preguntar *"¿qué tratamiento deseas reservar y para qué fecha?"* con ambos datos ya dados.
5. **La reserva completa por chat (b13) no se logró en ninguna de las 5 corridas.** Se combinan la fecha desconocida, los cortes y el silencio por duplicado.

## Diferencias con producción

- Sin limitador de envío ni "escribiendo…": la latencia real será mayor.
- Topes del modelo levantados (ver hallazgo 2).
- `BusinessSettings` con valores ficticios (en desarrollo están en `null`).
- Una conexión simulada por trabajador (4 en paralelo).
- Descarga de imágenes fallida por diseño.

## No verificado

- Entrega real por WhatsApp, recibos, LID y reconexiones: no hay sesión de WhatsApp, por regla.
- Latencia real hacia Leonice por ngrok o producción: el banco usa Leonice local.
- Topes por minuto (20 solicitudes/min) bajo concurrencia real: el banco los levanta. En la corrida con los límites reales solo se alcanzó el tope diario.
- Comportamiento con plantillas o ajustes propios del bot (hoy no existen en la base de desarrollo).
