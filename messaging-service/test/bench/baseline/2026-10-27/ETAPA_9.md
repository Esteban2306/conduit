# Etapa 9: costo de los turnos con IA y evidencia final

Mediciones del banco (64 conversaciones, 3 corridas por lado, intents en ACTIVE, modelo claude-haiku-5-5, precios del banco: entrada 0,10, salida 0,50, escritura de caché 0,125, lectura de caché 0,01 USD por millón de tokens). Se reproduce con `pnpm bench:baseline` y `pnpm bench:compare <carpetas> -- <carpetas>`.

## Antes y después

| Métrica | Etapa 0 (21-oct) | Inicio etapa 9 (27-oct) | Fin etapa 9 | Cambio en la etapa 9 |
|---|---|---|---|---|
| Conversaciones / aciertos | 32/38 | 63, 61, 61 de 64 | 61, 62, 61 de 64 | igual (±1 es ruido del modelo) |
| Entrada total por turno con IA p50 / p95 | 8.902 / 13.936 | 17.037 / 28.569 | 16.850 / 29.310 | igual (el prompt de reserva es el mismo) |
| **Entrada sin caché por turno con IA p50 / p95** | sin caché | 1.570 / 6.903 | **1.191 / 3.081** | **−24 % / −55 %** |
| Aciertos de caché (parte de la entrada que sale de caché) | 0 % | 84,2 % | 90,5 % | +6,3 puntos |
| Tokens contados por conversación (media) | 11.439 | 2.972 | 2.317 | −22 % |
| Costo por conversación p50 / p95 | 0,00110 / 0,00248 | 0,00023 / 0,00150 | 0,00020 / 0,00132 | −13 % / −12 % |
| Costo total del banco | 0,0567 | 0,0240 | 0,0213 | −11 % |
| Turnos sin IA (de los respondidos) | 0 % | 35,1 % | 35,2 % | igual |
| Latencia mensaje→respuesta p50 / p95 | 10,97 s / 13,22 s | 11,39 s / 14,74 s | 11,36 s / 14,19 s | igual (casi todo es el debounce de 8 s) |
| Salida por turno con IA p50 | 352 | 245 | 232 | −5 % |
| Respuestas cortadas / vacías (3 corridas) | 15 / 2 | 1 / 1 | 1 / 1 | igual |
| Traspasos y casos de salud, queja, spam y comprobante | n/d | 27/27 | 27/27 | igual |

Los fallos que quedan son del modelo y no cambian con la etapa: b40 falla 3 de 3 en las tres medidas y el resto se reparte al azar (1 por corrida).

## Qué se hizo y por qué

1. **Medir antes de optimizar.** Cada turno deja una línea `Turno corr=… ruta=… llm=… in=… caché=lectura/escritura out=… ms=… herramientas=nombre(ms,bytes)`. Con eso se vio que `listar_tratamientos` pesaba 4.115 B (la mayor parte de lo que no se cachea), que la reserva envía 12 herramientas y que el prefijo cacheado ronda los 6.100 tokens.
2. **Caché del tramo que crece dentro del turno.** Cada vuelta del ciclo de herramientas marca el final de lo enviado con `cache_control`, así la siguiente vuelta lo lee de caché en vez de pagarlo completo. Es una copia por llamada: nunca se acumulan más de 3 puntos de caché (límite del proveedor: 4).
3. **Prefijo estable compartido.** Prueba automática: dos clientas distintas producen exactamente el mismo bloque cacheado y las mismas herramientas; su nombre, teléfono, resumen y acciones solo aparecen después del punto de caché.
4. **Presupuesto del contexto dinámico.** Las claves internas del bot (`activeFlow`, `taskDoneAt`, `handoffAt`, `failureStreaks`, `closedAt`…) ya no llegan al prompt; el resumen se recorta a 1.500 caracteres conservando lo reciente; la memoria de acciones tiene presupuesto de 2.400 caracteres y conserva las más recientes.
5. **Tope por resultado de herramienta (6.000 caracteres).** Las listas se recortan por elementos y avisan cuántos faltan; un resultado normal no se toca. En las 3 corridas ningún resultado lo alcanzó (el mayor fue 4.115 B): es una red de seguridad.
6. **Backend más magro.** La lista de tratamientos que ve el modelo ya no trae el eslogan de marketing (~37 % de cada lista); la ficha sigue en `info_tratamiento`.
7. **Trazabilidad.** El id del turno viaja como `X-Correlation-Id` a cada llamada al backend; Leonice ya lo acepta y lo conserva.
8. **Vigilante** (cada minuto): respuestas atascadas o ≥ 20 en cola, cola de mensajes ≥ 100, mensajes nuevos en la cola de fallidos, ≥ 80 % del límite diario de tokens, circuito abierto o credencial rechazada. Cada condición avisa por webhook `ops.alert` y correo, como máximo cada 30 minutos.
9. **TTL de 1 hora del prefijo estable** (`ANTHROPIC_CACHE_TTL=1h`, por defecto 5 minutos, sin cambios hasta que se active).

## Lo que el banco NO muestra (y por qué importa)

El banco encadena conversaciones seguidas, así que la caché de 5 minutos está **tibia**. Un spa con pocas conversaciones por hora tendrá la caché **fría**: el primer turno de cada conversación paga la *escritura* del prefijo. Con ~6.100 tokens de prefijo, eso es ≈ 6.100 × 0,125 / 1.000.000 ≈ **0,00076 USD por conversación fría**, unas 3,5 veces el costo mediano medido (0,00020). Esta cifra es una estimación, no una medición.

Regla para decidir el TTL de 1 hora: la escritura cuesta 2× el precio de entrada (frente a 1,25× del TTL de 5 minutos) pero se paga una vez por hora. Conviene a partir de aproximadamente **2 conversaciones por hora separadas por más de 5 minutos**. Con una conversación por hora o menos, el TTL de 5 minutos sigue siendo más barato.

## Lista de revisión para producción

| # | Punto | Estado |
|---|---|---|
| 1 | Pruebas unitarias de Conduit (≈ 800) y de Leonice en verde, tsc limpio | Cumplido |
| 2 | Banco: 61–63 de 64 en 3 corridas, sin regresión frente a la medición de partida | Cumplido |
| 3 | Casos de traspaso, salud, queja, spam y comprobante: 27/27 | Cumplido |
| 4 | Migraciones aplicadas en la base de producción (`prisma migrate deploy`, 3 de las etapas 7 y 8) | **Pendiente (tuyo)** |
| 5 | `INTEGRATION_ENCRYPTION_KEY` guardada en un gestor de secretos, aparte del respaldo de la base | **Pendiente (tuyo)** |
| 6 | Al menos un modelo de respaldo con rol FALLBACK o una segunda clave | **Pendiente (tuyo)** |
| 7 | `OPS_ALERT_EMAILS` definida y un webhook suscrito a `ops.alert` | **Pendiente (tuyo)** |
| 8 | Reiniciar Conduit y volver a sembrar Leonice (herramientas, prompt, intents, plantillas con `OVERWRITE=true`) | **Pendiente (tuyo)** |
| 9 | Revisar los dos procesos `main.ts` antiguos que siguen vivos (riesgo de sesión duplicada) | **Pendiente (tuyo)** |
| 10 | Prueba real de extremo a extremo con el 3108525522 (ver abajo) | **Pendiente (necesita tu teléfono)** |
| 11 | Decidir `ANTHROPIC_CACHE_TTL` según el tráfico real de las primeras semanas | Pendiente (después de observar) |
| 12 | Activar los intents en ACTIVE uno por uno tras revisar los registros en SHADOW | Pendiente (tuyo) |

Veredicto del código y del banco: **listo**. El veredicto de producción es **condicionado** a los puntos pendientes; el 10 es el único que solo se puede cerrar con WhatsApp real.

## Prueba real de extremo a extremo (3108525522)

Solo se escribe a ese número. Con Conduit y Leonice corriendo y WhatsApp conectado:

1. Desde el 3108525522 escribe al número del bot: "Hola, quiero agendar uñas para el próximo lunes a las 9". Responde "sí, confírmala" cuando el bot proponga la hora.
2. Anota la hora aproximada y busca en los registros de Conduit la línea `Turno corr=<id> …`; ese id aparece también en los registros de Leonice como `correlationId` de las llamadas de herramienta.
3. Comprobaciones en la base de Conduit (`conduit_db`): `BotMessage` del chat (entrante y saliente), `OutboundReply` con `status = SENT` y `waMessageId` lleno, y `Message` con el envío proactivo si se disparó un recordatorio.
4. El webhook al backend: si Leonice tiene un endpoint suscrito a `message.sent`, revisa en `WebhookDelivery` que haya una entrega con `deliveredAt` lleno.

## Lo que no se pudo verificar

- WhatsApp real (llegada, doble check azul, `waMessageId` fijo evitando duplicados, vaciado tras una caída): todo está probado con canal simulado.
- El costo con la caché fría en producción: solo hay estimación (arriba).
- El TTL de 1 hora contra la API real: probado que la solicitud lo lleva, no que el proveedor lo aplique.
- Pruebas contra proveedores de IA distintos de Anthropic.
- Una caída real del proveedor de IA o del backend: solo con pruebas unitarias.
- Que el vigilante y los avisos lleguen por correo y webhook en tu entorno.
