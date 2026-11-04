# Antibloqueo de WhatsApp (Baileys): qué hace Conduit y cuánto permite

Conduit usa una librería no oficial. No existe una configuración que garantice que un número no se bloquee. Lo que se puede hacer es reducir las señales que WhatsApp suele penalizar (ráfagas, mensajes iguales, mucho chat iniciado por el negocio, desconexiones repetidas, mensajes sin lectura) y detectar a tiempo cuando algo va mal.

## 1. Secuencia de una respuesta del bot

1. El cliente escribe. El bot espera `botResponseDelaySeconds` con una variación de ±25 % (ninguna cadencia es exacta).
2. Si el dueño del número está activo en ese chat, o el cliente sigue escribiendo, no se lee ni se responde; se reintenta cuando deje el chat.
3. Al empezar a procesar el turno se marcan como leídos **todos** los mensajes pendientes tras una pausa de 1–4 s, en paralelo con la IA.
4. La respuesta nunca sale antes de esa lectura: el orden siempre es leído → escribiendo → envío.
5. "Escribiendo" dura entre 1,2 y 5 s, proporcional al largo (≈45–70 ms por carácter, distinto en cada mensaje).
6. Las respuestas no llevan caracteres invisibles. Solo los mensajes proactivos conservan la variación invisible al final, hasta que existan variantes reales de plantilla.

Código: `src/channels/whatsapp/baileys/human-timing.ts`, `BotRouter.markTurnRead`, `BaileysPlugin.sendMessage`.

## 2. Límites medidos del limitador

Medidos con el código real y el limitador saturado (1000 respuestas o 400 proactivos en cola), con 3 s de "escribiendo" por mensaje. Los valores salen de `test/unit/channels/limiter-capacity.spec.ts`; si se cambia el limitador, esa prueba los vuelve a calcular.

| Nivel | Respuestas: ritmo habitual | Respuestas: techo absoluto | Ráfaga máxima | Proactivos por hora | Proactivos por día |
|---|---|---|---|---|---|
| FRESH (número nuevo) | 60/h | 90/h | 10/min | 6 | 40 |
| NORMAL | 120/h | 180/h | 10/min | 18 | 180 |
| TRUSTED | 180/h | 270/h | 10/min | 25 | 280 |

- **Separación mínima entre envíos de la conexión:** 6 s medidos (3 s de espacio mínimo más el "escribiendo").
- **Respuestas (el cliente escribió primero):** salen en orden, a cualquier hora. Hasta la mitad del ritmo habitual la separación es la natural; entre la mitad y el ritmo habitual se alarga hasta 3 veces; entre el ritmo habitual y el techo absoluto salen a 1 cada 40 s (FRESH), 20 s (NORMAL) o 13 s (TRUSTED). Solo en el techo absoluto esperan a que la hora lo libere. En ningún punto anterior al techo una respuesta espera más de 43 s (FRESH).
- **Proactivos (inicia el negocio):** solo de 8:00 a 21:00 (America/Bogota), con retraso aleatorio entre mensajes, pausas de sesión de 2–10 min cada 3–20 mensajes, y solo a quien escribió en los últimos 180 días (`campaignPolicy`).
- **Lo que vive el cliente (medido, NORMAL, 2 burbujas por respuesta y 3 s de "escribiendo" por burbuja):** 1 cliente recibe su respuesta completa en 9 s; con 5 clientes escribiendo a la vez, la mitad la tiene en 33 s y el último en 58 s; con 10, el último en 120 s. A esto se suma la espera previa (8 s con variación) y la IA. Es el ritmo de una persona atendiendo varios chats; acelerarlo más es justo lo que parece automatización.
- **Tras una reconexión o reinicio:** 60 s con separación de 8–15 s entre respuestas. El limitador recupera de la base lo enviado en la última hora y día y el riesgo acumulado, que baja un nivel por hora; un reinicio no vuelve los contadores a cero.
- **Riesgo (1 a 5):** sube con fallos de envío reales (por ejemplo un `rate-overlimit` de WhatsApp, que además espera al menos 2 min en la bandeja) y con una conexión que no se sostiene (4 cierres en 10 min). Una conexión caída no cuenta como fallo de envío y los cierres de red o de protocolo ya no lo suben. El riesgo alarga todas las separaciones y a partir del nivel 4 pausa los proactivos.

## 3. Comparación con prácticas conservadoras

WhatsApp no publica límites. Lo siguiente son heurísticas de la comunidad, no cifras oficiales:

- Número nuevo: menos de 20–50 mensajes iniciados por el negocio por día durante la primera semana, subiendo de a poco.
- Mensajes masivos: separación de al menos 6–10 s entre envíos y pausas largas cada pocas decenas.
- Lo más penalizado: enviar a quien nunca escribió, repetir el mismo texto a muchos, y que los destinatarios bloqueen o reporten.

Frente a eso: los proactivos de FRESH (40/día, 6/h) están en el borde alto de lo conservador para la primera semana de un número realmente nuevo. Para un número recién vinculado conviene bajarlo (por ejemplo 20/día) durante 7–14 días. Las respuestas a quien escribió primero son el uso normal de un negocio y su riesgo es bajo; los techos existen para cortar un bucle, no para el tráfico habitual.

## 4. Bandeja de salida de respuestas

Cada respuesta del bot se guarda en `OutboundReply` (una fila por burbuja, máximo 3) **antes** de enviarse:

- Un despachador del propio proceso las entrega en orden por conversación, solo en las conexiones que esa instancia tiene abiertas, y siempre a través del limitador.
- Cada burbuja tiene un id de mensaje de WhatsApp fijo: un reintento tras un `timed out` reenvía el mismo id y no genera un segundo mensaje.
- Con el canal desconectado esperan sin gastar intentos; al reconectar salen respetando el throttle posterior a la reconexión.
- Reintentos con espera creciente (5 s, 15 s, 45 s, 2 min, 5 min), máximo 6 intentos.
- **Caducan a los 30 minutos.** Una respuesta vieja no se envía sin contexto: queda `EXPIRED`, los mensajes del cliente se marcan para que la recuperación al reconectar no los conteste solos, y se avisa al equipo.
- Una respuesta ya decidida cuenta como dicha para el modelo y para "qué falta por responder", así un mensaje nuevo mientras está en cola no provoca una segunda respuesta a lo mismo.
- Si una burbuja falla para siempre, las siguientes del mismo mensaje no salen sueltas.

## 5. Sesión y reconexión

### Qué es bloqueo y qué es protocolo

Baileys usa 500 como valor por defecto de cualquier error de flujo sin código conocido, y 408/428 son caídas de red. Antes se trataban como "señal de bloqueo" y frenaban las respuestas. Ahora (`disconnect-classifier.ts`):

| Cierre | Qué es | Qué hace Conduit |
|---|---|---|
| 401 | Sesión cerrada (desde el teléfono o por WhatsApp) | Borra la sesión, detiene la conexión y avisa de inmediato: hay que escanear un QR |
| 440 | Sesión reemplazada (otra instancia o dispositivo) | Detiene la reconexión y avisa de inmediato |
| 403 | Cuenta rechazada | **Un solo 403 no se da por bloqueo:** espera ~2 min y reintenta una vez; si el segundo 403 llega en 15 min, marca BANNED y avisa |
| 405 | Versión del protocolo rechazada | Reintenta con la versión vigente; avisa solo al tercer intento seguido (actualizar Baileys) |
| 515 | Reinicio requerido (normal tras emparejar) | Reconecta de inmediato, sin riesgo ni aviso |
| 408, 428, 503, 500 y desconocidos | Red o protocolo | Reconecta con espera creciente y jitter; **no suben el riesgo ni avisan** |

Una conexión que se cae 4 veces en 10 minutos avisa como "inestable (no es una señal de bloqueo)" y sube el riesgo una vez; si pasan 10 minutos sin conexión, avisa. Un cierre de red de segundos no genera ningún aviso.

### Cifrado y persistencia

- Un solo Conduit puede tener la sesión (lease en base de datos, renovado cada 30 s). Si otra instancia la toma, la local cierra el socket y avisa.
- **La sesión de Baileys vive en la tabla `WhatsAppSession` de Postgres**, no en un volumen. Cada valor (credenciales y claves Signal) se guarda cifrado con AES-256-GCM y la clave maestra `INTEGRATION_ENCRYPTION_KEY` (campo `__enc`). Las filas anteriores se siguen leyendo y la migración de arranque las cifra con compare-and-set, sin pisar lo que un socket escriba al mismo tiempo.
- **Si la clave maestra cambia o se pierde, no se crea una sesión nueva** (eso obligaría a escanear otro QR y volver a vincular el número es en sí una señal de riesgo): la conexión pasa a ERROR, se avisa y se espera a que se restaure la clave. **Guarda `INTEGRATION_ENCRYPTION_KEY` en un gestor de secretos, aparte del respaldo de la base**: sin ella, la sesión respaldada no sirve.
- Las claves se escriben por lotes en una sola transacción (o no se escribe nada) y se reintentan si la base falla un instante. Las credenciales se escriben en cola.
- Unas credenciales sin registrar nunca pisan unas registradas.
- Copia de las credenciales (la identidad del dispositivo) cada 30 minutos como máximo. Si las principales se dañan se restaura la copia y se avisa; si no hay copia válida se avisa de que habrá que escanear un QR.
- **Varias líneas por tenant:** cada conexión tiene su propio lease, limitador, estado recuperado, bandeja de salida, claves de sesión y alertas; una conexión caída no frena a otra del mismo tenant (probado).
- **Respaldo:** respaldar la sesión es respaldar la tabla `WhatsAppSession` y custodiar la clave maestra por separado.
- Otros cierres: espera creciente de 5 s a 5 min con variación de ±20 %, cuarentena tras 6 fallos en 5 min.
- Los mensajes que llegan con más de 60 minutos de antigüedad (por ejemplo tras una caída larga) no se descartan: se guardan sin que el bot los conteste solo y se avisan al equipo.

## 6. Avisos al equipo

Los avisos no dependen de WhatsApp, que es el canal que puede estar caído:

- **Webhook** `ops.alert` a los endpoints del tenant suscritos a ese evento (o a `*`). Cuerpo: `{ event, timestamp, data: { kind, subject, lines } }`, con `kind` igual a `connection` o `undelivered`.
- **Correo** a las direcciones de `OPS_ALERT_EMAILS` (separadas por comas), con el SMTP que Conduit ya usa.
- Los avisos críticos (sesión cerrada, posible bloqueo, otra instancia) salen de inmediato y no se repiten en 10 minutos; el resto se agrupa en un solo mensaje por minuto.

## 7. Variantes de plantilla en mensajes proactivos

Una plantilla puede llevar hasta 3 redacciones alternativas (`bodyVariants`) con **exactamente las mismas variables** que la principal; el servicio rechaza una variante que pierda una variable, repetidas o con sintaxis inválida, y revalida las variantes si cambia el texto principal. Cada mensaje usa una de ellas de forma estable (según su id), así un reintento no cambia el texto y los destinatarios se reparten entre las redacciones. Leonice ya trae 2 variantes para el recordatorio de cita y las dos reactivaciones; se activan con `CONDUIT_TEMPLATES_OVERWRITE=true`. La variación invisible al final se mantiene encima de las variantes en los mensajes proactivos.

## 8. Migraciones sin aplicar

Al arrancar, Conduit compara las migraciones de `prisma/migrations` con las aplicadas y registra un error claro si falta alguna; `/health` también se marca degradado y lista las pendientes. Antes, una migración sin aplicar solo se notaba por errores 500 de las consultas que usaban columnas nuevas. Si el servidor corre en modo watch, el código nuevo se carga al guardar: aplica `npx prisma migrate deploy` antes de usar lo nuevo.

## 9. Lo que no está resuelto

- Sin una caída real de WhatsApp en pruebas: la entrega al reconectar está verificada con canal simulado y con la base real, no con el servicio de WhatsApp.
- La rotación de `INTEGRATION_ENCRYPTION_KEY` no está automatizada: cambiarla exige volver a cifrar las sesiones con la clave anterior antes de retirarla.
