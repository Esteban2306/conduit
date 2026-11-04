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

Misma muestra (63 conversaciones, 77 turnos), modelo real, dos modos. `BENCH_INTENTS_MODE=SHADOW|ACTIVE` decide en qué modo siembra Leonice las intenciones. Corridas: `2026-10-26T17-22-56` (SOMBRA) y `2026-10-26T17-35-48` (ACTIVO).

| Métrica | SOMBRA (= comportamiento anterior) | ACTIVO |
|---|---|---|
| Turnos sin IA (directo/plantilla) | 0 de 77 | 25 de 77 (32,5 %) |
| Turnos ignorados sin IA (acuses, silencio de reglas) | 5 | 9 |
| Llamadas al modelo | 140 | 112 |
| Tokens de entrada, total | 1 207 420 | 657 350 (−45,6 %) |
| Tokens de salida, total | 17 131 | 11 545 (−32,6 %) |
| Costo total del banco | $0,0346 | $0,0221 (−36,2 %) |
| Latencia mensaje→respuesta p50, turnos sin IA | — | 8,1 s (casi todo es la espera de 8 s del debounce) |
| Aciertos | 57/59 | 56/59 |

- En ACTIVO, de los turnos que sí usan IA, 19 van por la IA reducida (reglas, clasificador de IA, continuidad de flujo y fallback) con prompt de ~1,5 k tokens fijos y solo las herramientas del manejador.
- El clasificador de IA decidió 8 turnos sin frase conocida (~0,6–1,4 s, ~12 tokens de salida).
- `expectActive` en `scenarios.json` fija lo esperado cuando una intención responde sin IA (p. ej. cancelar entrega el enlace en vez de cancelar en el chat).
- Casos negativos (b48, b49, b54, b55, b60, b61): parecen una intención pero deben ir a la IA, y lo hacen.
- Variación del modelo en turnos que siguen yendo a la IA: b13 (error `DATOS_SALUD` cuando el modelo manda `isPregnant:false`: 2/4 con el prompt reducido comprimido, 4/5 tras devolverle el texto completo de esa regla; 4/4 en SOMBRA), b14 (pide confirmar otra vez tras el "sí": 1/4 en SOMBRA con el prompt actual y 3/5 con el prompt anterior a la etapa, es decir, ya era inestable), b19 y b40.

### Confirmación de la reserva (b14) y silencio al terminar (b64) — 2026-10-26

- Causa de b14: tras el "sí", el modelo volvía a consultar servicios y disponibilidad y pedía otra confirmación (o hablaba de una persona). Correcciones: instrucción de confirmación que se añade al contexto del turno cuando la clienta responde con un sí claro a una pregunta del bot, reintento único si confirmó y la acción no se ejecutó, `treatmentNames` en `crear_reserva_whatsapp` y reglas del prompt.
- Resultado en modo ACTIVO: b14 pasó de ~50 % (3/5 con el prompt anterior; 3/5 y 4/5 en sombra) a 10/10 tras el último cambio. La corrida con 6 fallos de 8 fue un choque de horario entre b14 y b64 (misma hora, mismo servicio) cuando corrían juntos; b64 usa ahora otro día y hora.
- b64: tras crear la reserva, "muchas gracias por todo" y "ok perfecto" quedan sin respuesta (4/4).

### Etapa 6 — el bot no promete lo que no ocurrió (2026-10-26)

- Antes: cualquier fallo de una herramienta de escritura (incluido un horario ocupado) reemplazaba la respuesta por "una persona de nuestro equipo se pondrá en contacto" sin que hubiera traspaso. Era el fallo conocido A2 (b25, b26).
- Ahora: los resultados esperados (409/404) vuelven al modelo con código, siguiente paso y alternativas, sin avisar al equipo; los técnicos, de permiso o con siguiente paso "traspaso" hacen el traspaso desde el servidor (aviso verificado, bot pausado, texto fijo); una frase de promesa sin traspaso exitoso se sustituye por el traspaso real.
- Medido: b25, b26, b27, b30 y b31 pasaron 20/20 en modo ACTIVO; A2 dejó de ser un fallo conocido (se quitó la marca `knownFailure`). En b13 un horario rechazado por "al menos 1 día de anticipación" se explicó con una alternativa en vez de prometer una persona.
- No cubierto por el banco: caída real del backend (no se puede inducir); está en pruebas unitarias del router y del servicio de traspaso con notificador simulado.

