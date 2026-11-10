# Guía de operación de especialistas

Para quien configura y opera especialistas (verificación de imágenes) en Conduit. Es una guía de **cómo hacerlo, en orden**. El detalle de cada ruta, variable de entorno y migración está en `DESPLIEGUE_IDENTIDAD_DE_LINEA_Y_ESPECIALISTAS.md`; aquí solo se enlaza por nombre de sección.

## 0. Qué es y qué no es

Un **especialista** es una configuración de un tenant que mira una imagen y devuelve **variables** (lo que tú declaras que quieres leer) y un **veredicto** que decide el código, no el modelo. Sirve igual para un comprobante, un paisaje o un documento: Conduit no conoce ningún negocio, solo lo que cada especialista declara.

Piezas que se combinan:

| Pieza | Para qué |
|---|---|
| Variables de salida | Qué se extrae de la imagen |
| Reglas | Cuándo el resultado es válido, inválido o dudoso |
| Modelos propios | Con qué clave y modelo se analiza (nunca claves del sistema) |
| Vínculo bot-especialista | En qué bot corre y en qué modo (`OFF`, `SHADOW`, `ACTIVE`) |
| Herramientas con puerta | Que una acción del bot exija una imagen verificada |
| Webhooks de resultados | Que tu backend reaccione a cada veredicto |

Veredictos: `VALID`, `INVALID`, `NEEDS_REVIEW` (dudoso), `UNREADABLE`, `NOT_APPLICABLE` (no es el tipo de imagen esperado) y `ERROR` (falló el análisis).

## 1. Antes de empezar

- `SPECIALISTS_ENABLED=true` en el servicio. Con `false` todo se comporta como antes de los especialistas.
- Tener aplicadas las migraciones pendientes (sección "Migraciones" de la guía de despliegue).
- Una clave de un proveedor de IA **propia del especialista**. No se usan las claves por defecto del sistema.
- Un usuario con rol propietario o administrador para crear, editar y probar.

## 2. Ruta recomendada: de cero a producción

```
Crear especialista → Agregarle modelo → Probar (dry-run) → Medir (banco) →
Vincular en SHADOW → Observar → Pasar a ACTIVE → Herramientas y webhooks → Operar
```

No te saltes SHADOW: es la única forma de ver el comportamiento con imágenes reales sin afectar a nadie.

### 2.1 Crear el especialista

`POST /specialists`

```json
{
  "name": "Verificador de paisajes",
  "capability": "landscape-check",
  "promptTemplate": "Analizas fotos enviadas por clientes para un portal de turismo.",
  "outputSchema": {
    "version": 1,
    "variables": [
      { "name": "kind", "type": "enum", "values": ["beach", "city", "mountain"], "label": "tipo", "description": "Tipo de paisaje dominante" },
      { "name": "has_people", "type": "boolean", "description": "Hay personas visibles" },
      { "name": "place", "type": "string", "maxLength": 40, "identityMinLength": 3, "description": "Lugar si se puede leer" }
    ],
    "uniqueBy": ["place"]
  },
  "rules": { "version": 1, "rules": [] }
}
```

Puntos que más se equivocan:

- **`capability`** es la clave que luego usan el vínculo y las herramientas (minúsculas, números y guiones). **No se puede cambiar después.**
- **`description` de cada variable** es lo que lee el modelo. Sé concreto: formato, unidades, qué hacer si no se ve. Es la palanca que más mejora la calidad.
- **Máximo 12 variables.** Nombre en minúsculas con guion bajo, hasta 20 caracteres; no pueden llamarse `constructor`, `prototype`, `version`, `confidence`, `legibility` ni `variables`.
- **Tipos:** `number` (`min`, `max`, `tolerance`), `string` (`maxLength`, `identityMinLength`, `exposeToBot`), `boolean`, `date`, `enum` (`values`).
- **`uniqueBy`** son las variables que identifican "el mismo caso". Con ellas, reenviar la misma imagen recomprimida (WhatsApp lo hace) se detecta como duplicado. Solo funciona si todas esas variables se leyeron. Sin `uniqueBy`, solo cuenta el hash exacto de la imagen.
- **`exposeToBot`** (solo texto): deja que el modelo conversacional vea esa variable. **Por defecto el texto leído de una imagen nunca llega al modelo que habla con el cliente**, porque podría contener instrucciones hostiles. Márcalo solo para textos cortos y de formato controlado.

### 2.2 Reglas: cuándo es válido

Cada regla apunta a una variable (`field`) y tiene un operador según su tipo, una referencia y qué veredicto produce al fallar (`onFail`):

| Tipo | Operadores |
|---|---|
| `number` | `gte`, `lte`, `eq` |
| `date` | `within_days`, `eq` |
| `string` | `eq`, `contains`, `fuzzy`, `in` |
| `boolean` | `eq` |
| `enum` | `eq`, `in` |

La referencia puede ser un literal (`{"literal": 100000}`) o un dato externo del negocio (grounding; ver su sección en la guía de despliegue).

```json
{ "field": "kind", "op": "in", "ref": { "literal": ["beach", "mountain"] }, "onFail": "INVALID" }
```

- Al guardar se rechaza (400, `details.ruleIssues`) una regla con una variable no declarada, un operador que no aplica al tipo o un literal del tipo equivocado.
- Una variable que **no se pudo leer** nunca da `VALID`: pasa a `NEEDS_REVIEW`.
- **Sin reglas, toda imagen legible es `VALID`.** Por eso Conduit no deja pasar a `ACTIVE` un especialista sin reglas.

### 2.3 Agregarle un modelo

`POST /specialists/:id/models`

```json
{ "provider": "ANTHROPIC", "model": "claude-haiku-5-5", "apiKey": "…", "role": "IMAGE_ANALYSIS", "tier": "PAID", "priority": 1 }
```

- `tier`: `FREE` o `PAID`. Roles: `IMAGE_ANALYSIS` (principal) y `FALLBACK` (respaldo si el principal falla). Un respaldo más barato o de otro proveedor reduce los `ERROR`.
- La clave **nunca se devuelve** (solo los últimos 4 caracteres). Para rotarla: `PATCH /specialists/:id/models/:modelId`. Cambios en la clave del bot **no** actualizan la del especialista.
- `POST …/:modelId/reactivate` limpia fallos y confirma con una llamada de prueba (consume un token).
- **Costo:** el análisis de imágenes es rápido y barato con un modelo pequeño. Empieza por el más económico y sube solo si el banco de evaluación muestra que hace falta.

### 2.4 Probar sin guardar nada (dry-run)

`POST /specialists/:id/dry-run` (`multipart/form-data`, campo `file`; opcional `draft` con `promptTemplate`, `outputSchema`, `rules` o `contextSources` para probar cambios sin guardarlos).

- JPEG, PNG o WebP, máximo 5 MB. Devuelve veredicto, variables, razones, modelo, tokens, latencia y costo estimado.
- **Gasta tokens reales.** No guarda resultados, no toca el historial de duplicados y no resuelve datos externos (una regla que dependa de ellos no puede dar `VALID`).
- Úsalo para iterar el prompt y las descripciones antes de gastar más.

### 2.5 Medir con casos reales (banco de evaluación)

Antes de SHADOW, mide con 20–50 imágenes reales donde conoces la respuesta correcta. Detalle de la carpeta y los comandos: sección "Banco de evaluación" de la guía de despliegue.

```bash
npm run build
npm run specialists:eval -- run --dir=./banco --tenant=<tenantId> --specialist=<clave|id>          # solo valida, no gasta
npm run specialists:eval -- run --dir=./banco --tenant=<tenantId> --specialist=<clave|id> --yes     # gasta tokens
npm run specialists:eval -- compare --a=antes.json --b=despues.json --fail-on-regression
```

Lo que importa del informe: **falsos válidos** (esperado distinto de `VALID` y salió `VALID`: el error caro). Si crece al cambiar prompt o reglas, no avances. `compare` lo marca como alerta de seguridad.

### 2.6 Vincular en SHADOW

`PUT /bots/:botId/specialists/:capability`

```json
{ "specialistId": "<id>", "mode": "SHADOW", "timeoutMs": 12000, "onFailure": "DEGRADE" }
```

Modos:

| Modo | Qué hace |
|---|---|
| `OFF` | Nada. El vínculo nace así |
| `SHADOW` | Corre en paralelo y **solo registra**. No cambia ninguna respuesta, no bloquea, no avisa a nadie, no autoriza herramientas |
| `ACTIVE` | El resultado entra al turno del bot, autoriza herramientas con puerta y dispara webhooks |

`onFailure`: con `DEGRADE` la conversación sigue si el análisis falla y el caso queda marcado como pendiente de revisión; con `BLOCK` el bot responde un texto fijo de espera (`blockMessage`, hasta 300 caracteres) y ese turno no llama al modelo conversacional.

Requisitos: especialista activo y al menos un modelo utilizable. Todos los bloqueos se informan juntos en `details.blockers`.

### 2.7 Observar en SHADOW

Déjalo correr con tráfico real (la guía de despliegue pide al menos 20 verificaciones en 30 días y 80 % de coincidencia con el análisis anterior como advertencia, no como bloqueo).

- `GET /verifications?mode=SHADOW&specialistId=…` para ver casos; `reasonCode`, `verdict` y `from`/`to` para filtrar.
- `GET /verifications/metrics` para ver tasas de veredicto, latencia p50/p95, razones de `ERROR` y `NEEDS_REVIEW`, tokens y costo estimado.
- Revisa los `NEEDS_REVIEW` y los `ERROR` uno por uno: casi siempre revelan una descripción de variable ambigua o una regla demasiado estricta. Ajusta con `PATCH /specialists/:id`: cada cambio genera una **versión** y cada resultado guarda con cuál se hizo.
- Si algo se rompió: `POST /specialists/:id/versions/:version/restore`.

### 2.8 Pasar a ACTIVE

Mismo `PUT` con `"mode": "ACTIVE"`. Requiere al menos una regla. Las advertencias (`LOW_SHADOW_SAMPLE`, `LOW_SHADOW_AGREEMENT`) no bloquean pero **léelas**.

Qué cambia en ACTIVE:

- El resultado se guarda como hecho de la conversación (vigente `SPECIALISTS_PASSPORT_TTL_MINUTES`) y el modelo conversacional recibe una línea armada por código con el veredicto y las variables de tipo cerrado (más las `exposeToBot`).
- Si hay varias capacidades ACTIVE en el bot, corren en paralelo sobre la misma imagen. `imageVerified` es falso si alguna es `INVALID`, verdadero solo si todas son `VALID`.
- El resultado de un reenvío exacto o del mismo caso se reutiliza sin llamar al modelo (ahorra tokens). Una imagen ya usada con éxito en una acción da `INVALID` (`ALREADY_USED`).

## 3. Velocidad y costo

- El análisis **empieza cuando llega la imagen**, en paralelo con la espera normal del bot, de modo que al responder el resultado ya está. La mensajería (retardo del bot, "visto", tiempos de escritura) no cambia.
- Cada conversación espera `IMAGE_PREFETCH_SETTLE_MS` antes de gastar, y una ráfaga de imágenes analiza solo la última. No se adelanta si el equipo tiene la conversación.
- Para apagar el adelantado sin desplegar: `IMAGE_PREFETCH_ENABLED=false`.
- Palancas de costo, de mayor a menor efecto: modelo pequeño primero, `uniqueBy` bien definido (evita reanalizar duplicados), pocas variables y descripciones cortas, respaldo solo si hace falta.
- El costo que muestran las métricas es una **estimación** con precios aproximados por familia de modelo; un modelo sin precio conocido da `null`, no un valor inventado.

## 4. Que una acción exija una imagen verificada (herramientas con puerta)

Para acciones sensibles (registrar un pago, subir un documento): la herramienta no se ejecuta si la imagen adjunta no tiene un veredicto aceptado. `POST /bots/:botId/tools` con:

```json
{
  "name": "subir_documento",
  "description": "Sube el documento verificado del cliente",
  "parametersSchema": { "type": "object", "properties": { "monto": { "type": "number" }, "nota": { "type": "string" } } },
  "endpointUrl": "https://backend.tuempresa.com/documentos",
  "httpMethod": "POST",
  "authHeaderName": "X-Api-Key",
  "authSecret": "<secreto largo>",
  "requiresImageAttachment": true,
  "verificationCapability": "landscape-check",
  "acceptedVerdicts": ["VALID"],
  "verifiedParams": { "monto": "amount" }
}
```

- El bot debe tener vinculada esa capacidad (en cualquier modo); si no, 400. Aunque esté en `SHADOW`, **solo un veredicto de un vínculo `ACTIVE` autoriza**.
- `acceptedVerdicts`: `VALID`, y opcionalmente `NEEDS_REVIEW`. Nunca `INVALID` ni `ERROR`.
- **Un solo uso:** el veredicto se consume al ejecutar. Un rechazo definitivo del backend (4xx salvo 408/429) lo libera; un resultado ambiguo (timeout, 5xx, red) lo deja consumido y requiere revisión humana.
- **Pasaporte firmado:** cada llamada lleva `X-Conduit-Verification` (JSON canónico en base64url) y `X-Conduit-Verification-Signature` (HMAC-SHA256 con el `authSecret`). Tu backend debe recalcular la firma en tiempo constante, rechazar si `expiresAt` ya pasó, no aceptar el mismo `verificationId` dos veces y usar `fields` y `verdict` del pasaporte, no valores que lleguen por otro lado.
- **`verifiedParams`**: mapa `ruta del parámetro → variable`. Conduit escribe en esos campos el valor leído y verificado, pisa lo que haya enviado el modelo y los oculta del esquema que ve. Así el monto, la referencia o lo que sea llega sin que el modelo lo copie. Si la variable no se leyó, el campo no se envía. Solo variables de la capacidad de la propia herramienta.
- No puedes quitar un vínculo mientras una herramienta lo use (409).

## 5. Que tu backend reaccione al resultado (webhooks)

Si tu backend necesita actuar sobre cada resultado (aprobar, avisar, abrir un caso), suscribe un webhook: `POST /webhooks` con `url` y `events`.

| Evento | Cuándo |
|---|---|
| `verification.valid`, `.invalid`, `.needs_review`, `.unreadable`, `.not_applicable`, `.error` | Tras guardar un análisis nuevo de un vínculo `ACTIVE` |
| `verification.reviewed` | Cuando una persona decide un caso dudoso |

Suscríbete a los que necesites, o a `*`. Cada aviso trae `verificationId`, `conversationId`, `capability`, `verdict`, `confidence`, `reasonCodes`, `humanSummary` y `variables` completas (nunca la imagen). El cuerpo va firmado con el secreto del endpoint, con `X-Conduit-Event-Id` para deduplicar, y se reintenta hasta 8 veces. Historial de entregas: `GET /webhooks/:id/deliveries`.

Tu receptor debe: verificar la firma, deduplicar por `X-Conduit-Event-Id` (la entrega es al menos una vez) y responder rápido (2xx).

No avisa desde `SHADOW`, ni cuando se reutiliza un veredicto ya registrado, ni cuesta tokens.

## 6. Operación diaria

### Casos dudosos y errores

- `GET /verifications?pendingReview=true` lista los `NEEDS_REVIEW` y `ERROR` sin revisar.
- Para que el equipo se entere solo: agrega el disparador **`VERIFICATION_REVIEW`** a un contacto de escalamiento (`POST /bots/:botId/escalation-contacts` con `"notifyOn": ["VERIFICATION_REVIEW"]`). Es opt-in. El aviso lleva cliente, resultado, motivos e id, **sin** los datos de la imagen, y sale como máximo una vez por conversación y ventana.
- `POST /verifications/:id/review` con `{"decision": "APPROVED" | "REJECTED", "note": "…"}` deja constancia (una sola vez por caso). **Es auditoría**: no cambia el veredicto ni habilita nada. Para que una imagen dudosa llegue a una herramienta estricta, la persona debe reenviarla y obtener `VALID`, o la herramienta debe aceptar `NEEDS_REVIEW` explícitamente.

### Si el análisis falla

La conversación **nunca se detiene** por un fallo de análisis: el bot sigue y la imagen llega al panel como siempre para que una persona la vea. El panel recibe `warnings` en cada conversación del listado (`GET /bots/:botId/conversations`) con `code: IMAGE_NOT_ANALYZED` y el motivo; úsalo para mostrar una advertencia. No se manda ningún mensaje al administrador. Las acciones con puerta de verificación sí quedan sin ejecutar mientras no haya un veredicto aceptado: esa es la protección, y la conversación sigue.

### Qué mirar en las métricas

| Señal | Qué suele significar |
|---|---|
| Muchos `NEEDS_REVIEW` por `*_MISSING` | Una variable que el modelo no logra leer: mejora su `description` o relaja la regla |
| Muchos `ERROR` con `PROVIDER_ERROR` o `TIMEOUT` | Clave, límite del proveedor o `timeoutMs` bajo; agrega un respaldo |
| `ERROR` con `NO_MODEL` | El especialista no tiene un modelo utilizable (clave inválida o desactivada) |
| `ALREADY_USED` / `REUSED_OTHER_CONTACT` | Reenvíos o intentos de reutilizar una imagen; revisa los casos `REUSED_OTHER_CONTACT` |
| `RULES_INVALID` | Las reglas guardadas ya no cuadran con las variables; corrígelas |
| Advertencia `IMAGE_NOT_ANALYZED` en una conversación del panel | La imagen llegó pero no se analizó (ver `reason`). El bot siguió y la imagen está en el panel para revisarla a mano. Se limpia sola con el siguiente análisis correcto |

### Cambiar un especialista en producción

1. Prueba el cambio con `dry-run` y `draft`, y mide con el banco (`compare`).
2. Aplica con `PATCH /specialists/:id` (crea una versión nueva).
3. Vigila las métricas. Si empeora, `POST /specialists/:id/versions/:version/restore`.

### Apagar o revertir

| Quiero | Hago |
|---|---|
| Dejar de usar un especialista en un bot | `PUT` del vínculo con `"mode": "OFF"` (la puerta rechaza entonces las herramientas que lo exigen, que es el lado seguro) |
| Pasar de ACTIVE a observación | `PUT` con `"mode": "SHADOW"` |
| Apagar todo | `SPECIALISTS_ENABLED=false` (vuelve el comportamiento anterior) |
| Apagar solo el análisis adelantado | `IMAGE_PREFETCH_ENABLED=false` |
| Archivar un especialista | `POST /specialists/:id/archive` (409 si tiene vínculos en `SHADOW` o `ACTIVE`: ponlos en `OFF` antes) |
| Eliminar un vínculo | Primero `OFF`; y solo si ninguna herramienta lo usa |

## 7. Errores frecuentes

| Síntoma | Causa probable |
|---|---|
| 400 al guardar una regla | Variable no declarada, operador que no aplica al tipo o literal del tipo equivocado (`details.ruleIssues`) |
| 409 al pasar a `ACTIVE` | Falta una regla, el especialista está inactivo o no tiene un modelo utilizable (`details.blockers`) |
| 400 al crear una herramienta con `verificationCapability` | El bot no tiene un vínculo para esa capacidad |
| 400 en `verifiedParams` | Variable inexistente en el especialista, ruta que choca con imagen/teléfono/pasaporte, o rutas solapadas |
| 409 al eliminar un vínculo | Sigue en `SHADOW`/`ACTIVE` o una herramienta lo usa |
| La herramienta responde `VERIFICATION_REQUIRED` | No hay veredicto `ACTIVE` aceptado, vigente y sin usar para esa misma imagen en esa conversación; o la imagen fue reenviada y ya se consumió |
| El bot no ve una variable de texto | Es lo esperado: solo ve las de tipo cerrado y las marcadas `exposeToBot` |
| No llegan webhooks de resultados | El vínculo está en `SHADOW`, no estás suscrito al evento, o fue una reutilización de un veredicto ya registrado |

## 8. Lista de verificación antes de producción

- [ ] Descripciones de variables concretas (formato, unidades, qué hacer si no se ve).
- [ ] Reglas definidas y probadas con casos que deben dar `VALID`, `INVALID` y `NEEDS_REVIEW`.
- [ ] Banco de evaluación con casos reales; falsos válidos en cero o aceptados explícitamente.
- [ ] Modelo principal más económico que cumple; respaldo configurado.
- [ ] Al menos una semana o 20 casos en `SHADOW` revisados.
- [ ] `blockMessage` y `onFailure` decididos para el caso de fallo.
- [ ] Herramientas sensibles con puerta, `authSecret` y verificación del pasaporte probada en tu backend.
- [ ] Receptor de webhooks con verificación de firma y deduplicación.
- [ ] Contacto de escalamiento con `VERIFICATION_REVIEW` si el equipo atenderá los casos dudosos.
- [ ] Retención definida para los cuerpos de `WebhookDelivery` (guardan las variables del resultado).
- [ ] Conocidos los límites (sección "Límites conocidos" de la guía de despliegue): una sola réplica, estado en memoria del proceso para el adelantado y varios límites.
