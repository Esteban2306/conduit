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
- **Tras una reconexión o reinicio:** 60 s con separación de 8–15 s entre respuestas. El limitador recupera de la base lo enviado en la última hora y día y el riesgo acumulado, que baja un nivel por hora; un reinicio no vuelve los contadores a cero.
- **Riesgo (1 a 5):** sube con fallos de envío reales y desconexiones de riesgo (códigos 405, 408 y 500); una conexión caída no cuenta como fallo de envío. El riesgo alarga todas las separaciones y a partir del nivel 4 pausa los proactivos.

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

- Un solo Conduit puede tener la sesión (lease en base de datos, renovado cada 30 s). Si otra instancia la toma, la local cierra el socket y avisa.
- Cierres 401 (cerrada desde el teléfono), 440 (sesión reemplazada) y 403 (posible bloqueo): no se reconecta solo y se avisa de inmediato.
- Otros cierres: espera creciente de 5 s a 5 min con variación de ±20 %, cuarentena tras 6 fallos en 5 min, y aviso si pasan 10 minutos sin conexión.
- Los mensajes que llegan con más de 60 minutos de antigüedad (por ejemplo tras una caída larga) no se descartan: se guardan sin que el bot los conteste solo y se avisan al equipo.
- **Respaldo de la sesión:** la sesión de Baileys vive en la tabla `WhatsAppSession` de Postgres, no en un volumen. Respaldarla es respaldar la base de datos. Está en JSON sin cifrar; no se ha cifrado porque perder o cambiar `INTEGRATION_ENCRYPTION_KEY` obligaría a escanear un QR nuevo, y volver a vincular el número es en sí una señal de riesgo.

## 6. Avisos al equipo

Los avisos no dependen de WhatsApp, que es el canal que puede estar caído:

- **Webhook** `ops.alert` a los endpoints del tenant suscritos a ese evento (o a `*`). Cuerpo: `{ event, timestamp, data: { kind, subject, lines } }`, con `kind` igual a `connection` o `undelivered`.
- **Correo** a las direcciones de `OPS_ALERT_EMAILS` (separadas por comas), con el SMTP que Conduit ya usa.
- Los avisos críticos (sesión cerrada, posible bloqueo, otra instancia) salen de inmediato y no se repiten en 10 minutos; el resto se agrupa en un solo mensaje por minuto.

## 7. Lo que no está resuelto

- Variantes reales de plantilla para proactivos (hoy solo la variación invisible).
- Cifrado en reposo de la sesión (ver arriba).
- Sin una caída real de WhatsApp en pruebas: la entrega al reconectar está verificada con canal simulado y con la base real, no con el servicio de WhatsApp.
