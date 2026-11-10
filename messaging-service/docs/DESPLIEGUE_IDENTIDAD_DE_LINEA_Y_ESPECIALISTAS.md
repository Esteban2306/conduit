# Despliegue: identidad de línea, cola resiliente y especialistas

Resume lo que añade la rama `feat/line-identity-and-queue-resilience` y el orden seguro para llevarla a cada entorno.

## 1. Migraciones (aplicar a mano, en este orden, antes del código)

| Migración | Qué hace |
|---|---|
| `20261108180000_stable_keys` | Columna `key` en conexiones y bots, relleno desde el nombre, únicos por tenant y número único por tenant |
| `20261108190000_line_adoption` | Tabla de auditoría `WhatsAppConnectionAudit` e índice por dirección de contacto |
| `20261108200000_message_category` | `Message.category` para revisar la baja de marketing justo antes de enviar |
| `20261108210000_ai_model_owner` | `AiModelConfig` puede pertenecer a un especialista (dueño único con CHECK) |
| `20261108220000_specialists` | `Specialist`, `BotSpecialistBinding` y claves compuestas entre tenants |
| `20261108230000_verification_record` | `VerificationRecord` (veredictos, sin bytes de imagen) |
| `20261109110000_specialist_admin` | Versión y archivado del especialista, tabla `SpecialistVersion` (con la versión 1 de los especialistas existentes), y en `VerificationRecord` la versión usada, el desglose de tokens y los campos de revisión humana |
| `20261109120000_specialist_output_schema` | `outputSchema` en `Specialist` y `SpecialistVersion` (las filas existentes reciben la declaración equivalente a los seis campos anteriores, como datos) y `blockMessage` en `BotSpecialistBinding` |
| `20261110120000_tool_verified_params` | Columna `verifiedParams` (JSONB, por defecto `{}`) en `ToolDefinition`, con restricción de que sea un objeto. Aditiva: las herramientas existentes no cambian |
| `20261111120000_tool_unverified_fallback` | Enum `ToolVerificationFallback` y columna `onTechnicalFailure` (por defecto `REFUSE`) en `ToolDefinition`, con restricción de que `PROCEED_UNVERIFIED` exija `verificationCapability`. Aditiva: las herramientas existentes no cambian |
| `20261112120000_legacy_image_usage` | Tabla `LegacyImageUsage` (conteo por bot y día UTC del análisis de imagen antiguo, sin claves foráneas). Aditiva. La fecha en que se aplica esta migración es la que se usa como "desde cuándo se observa" |
| `20261109100000_attachment_verification` | Huella de campos, versión de hash y marca de consumo en `VerificationRecord`; campos de verificación y CHECK en `ToolDefinition` |

Todas son aditivas. Antes de `stable_keys` en cada base, buscar números duplicados por tenant:

```sql
SELECT "tenantId", "phoneNumber", COUNT(*)
FROM "WhatsAppConnection"
WHERE "phoneNumber" IS NOT NULL
GROUP BY 1, 2 HAVING COUNT(*) > 1;
```

Si devuelve filas, resolverlas antes (la migración falla si hay duplicados).

## 2. Variables de entorno nuevas

| Variable | Por defecto | Efecto |
|---|---|---|
| `LINE_AUTO_ADOPT` | `false` | Une automáticamente una conexión nueva con la anterior del mismo número cuando la anterior está en error o desconectada |
| `QUEUE_DISCONNECT_WAIT_MS` | `21600000` (6 h, tope 20 h) | Cuánto espera un mensaje con la línea desconectada antes de ir a la DLQ |
| `QUEUE_DISCONNECT_POLL_MS` | `30000` | Cada cuánto revisa si la línea volvió |
| `IMAGE_PREFETCH_ENABLED` | `true` | Analiza la imagen al llegar, durante la espera del bot, en vez de al responder. `false` vuelve al análisis al responder sin desplegar |
| `IMAGE_PREFETCH_SETTLE_MS` | `1500` (0 a 10000) | Ventana por conversación antes de arrancar el análisis, para absorber ráfagas y álbumes: solo se analiza la imagen más nueva |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | `10000` (1000 a 60000) | Tiempo máximo para descargar la imagen de WhatsApp |
| `SPECIALISTS_ENABLED` | `false` | Interruptor global de especialistas |
| `SPECIALISTS_RETENTION_DAYS` | `90` | Retención de `VerificationRecord` |
| `SPECIALISTS_GROUNDING_TIMEOUT_MS` | `5000` (500 a 15000) | Tiempo máximo para consultar los datos de referencia de las reglas |
| `SPECIALISTS_DRY_RUN_PER_MINUTE` | `10` (1 a 600) | Pruebas de dry-run por tenant y minuto; la siguiente recibe 429 con `details.retryAfterSeconds` |
| `SPECIALISTS_REVIEW_ALERT_THROTTLE_MINUTES` | `30` (1 a 1440) | Ventana mínima entre dos avisos de revisión de la misma conversación |
| `SPECIALISTS_PRICE_TABLE` | vacío | JSON que reemplaza o amplía la tabla de precios, por prefijo de modelo: `{"claude-haiku":{"inputPerMTok":1,"outputPerMTok":5}}`. Entradas inválidas se ignoran |
| `SPECIALISTS_PASSPORT_TTL_MINUTES` | `60` | Vigencia de un veredicto para habilitar una herramienta y para reutilizarlo desde el caché |

La espera por desconexión **está activa al desplegar** (no depende de una bandera): un mensaje con la línea caída espera sin gastar intentos.

## 3. Especialistas en SHADOW

1. Con `SPECIALISTS_ENABLED=false` el comportamiento es idéntico al anterior.
2. Simular el relleno (no escribe):

   ```bash
   npm run build && npm run specialists:backfill
   ```

3. Aplicarlo: `npm run specialists:backfill -- --apply` (opcional `--tenant=<id>`). Crea, por cada bot con modelo `IMAGE_ANALYSIS` activo, un especialista `ACTIVE` con prompt neutro, **copias** de sus modelos de imagen y de respaldo, y un vínculo en `SHADOW`. Es idempotente.
4. Encender `SPECIALISTS_ENABLED=true` primero en la línea de prueba. En SHADOW el especialista corre en paralelo al análisis actual, no retrasa ni cambia la respuesta y deja un `VerificationRecord` con la comparación.
5. Un vínculo en `ACTIVE` **reemplaza al análisis actual** dentro del turno: el especialista verifica la imagen, el resultado se guarda en `facts` de la conversación y el modelo recibe una línea armada por código (`[imagen verificada por el sistema: VALID, RULES_PASSED]`) más un bloque "Verificaciones del sistema" con las variables que el especialista expone (veredicto, confianza, motivos, un resumen de texto fijo y las variables de tipo cerrado). **El texto libre de la imagen nunca llega al modelo conversacional**, salvo una variable de texto que el especialista declare explícitamente con `exposeToBot`.
   - Con `ERROR` y política `DEGRADE` la conversación continúa y el hecho queda "pendiente de revisión humana". Con `BLOCK` se responde un texto fijo de espera y ese turno no llama al modelo conversacional.
   - `NEEDS_REVIEW` y `ERROR` marcan el hecho como pendiente; `BLOCK` solo corta ante `ERROR`.
   - Un hecho es vigente durante `SPECIALISTS_PASSPORT_TTL_MINUTES`; vencido, deja de mostrarse.
   - Los modelos de un especialista **nunca** usan claves del sistema (`<PROVEEDOR>_DEFAULT_API_KEY`): sin una clave propia válida el modelo falla con un mensaje claro.
   - Si el especialista no llega a ejecutarse (por ejemplo, queda inactivo justo en ese momento), el turno vuelve al análisis actual.
   - Antes de pasar un vínculo a `ACTIVE`, comparar en `SHADOW` los `VerificationRecord` con el comportamiento actual.

Reversión: `SPECIALISTS_ENABLED=false`.

### Si el análisis de la imagen falla

Un fallo del análisis **nunca corta la conversación**: el bot continúa con el aviso `[imagen recibida, no analizada]`, y la imagen llega al panel por el mismo camino de siempre (no depende del análisis). Antes, con el proveedor saturado, el análisis antiguo respondía "intenta de nuevo" y no llamaba al modelo; eso ya no ocurre. La única excepción es un vínculo configurado explícitamente con `onFailure: BLOCK`, que responde su texto de espera.

La conversación queda con una advertencia que el panel recibe en `GET /bots/:botId/conversations`, dentro de cada elemento: `warnings: [{ "code": "IMAGE_NOT_ANALYZED", "reason": "...", "since": "<fecha ISO>" }]` (lista vacía si no hay). `reason` es `NOT_RUN` (no se llegó a analizar), `PROVIDER_UNAVAILABLE`, `ANALYSIS_ERROR` o `SPECIALIST_ERROR`. Se limpia sola cuando una imagen posterior se analiza bien. No se envía ningún mensaje al administrador y el contexto nunca llega al prompt del modelo.

### Uso del análisis antiguo (para decidir su retiro)

Cada imagen analizada con el camino antiguo (bot sin vínculo, o solo con vínculos `SHADOW` u `OFF`) suma 1 en `LegacyImageUsage` por bot y día UTC y deja una línea de aviso en el log. Un vínculo `ACTIVE` no cuenta. El conteo es de mejor esfuerzo: nunca retrasa ni cambia un turno.

`GET /image-analysis/legacy-usage?days=14` (propietario o administrador; `days` de 1 a 90, 14 por defecto, otro valor da 400) devuelve, del tenant: `totalCalls`, `lastUsedAt`, `bots` (con `name`, `calls`, `lastUsedAt`), `observedSince` (cuándo se aplicó la migración), `observedDays` y `retirementReady`. `retirementReady` es verdadero solo si el contador lleva observando **toda la ventana** y hubo **cero** llamadas en ella: cero llamadas sin haber observado el tiempo suficiente no prueba nada.

Para una decisión sobre todos los tenants (el retiro del código es global), consultar la tabla directamente:

```sql
SELECT COALESCE(SUM(calls), 0) AS llamadas, MAX("lastAt") AS ultima
FROM "LegacyImageUsage"
WHERE day > (NOW() AT TIME ZONE 'UTC')::date - 14;
```

Criterio acordado para retirar el camino antiguo: 14 días con `llamadas = 0` desde que se aplicó la migración, y todo bot con `imageAnalysisEnabled` con un especialista ACTIVE.

### Camino rápido de la imagen

El análisis de la imagen **empieza cuando llega**, no cuando el bot decide responder. El retardo del bot (`botResponseDelaySeconds`, con su variación) no cambia, ni el "visto", ni los tiempos humanos de escritura, ni los reintentos por "está escribiendo": solo se solapa el análisis con esa espera, de modo que al responder el resultado ya está y el modelo conversacional recibe la información completa, no por partes.

- **Qué hace al llegar:** descarga la imagen una vez (con `IMAGE_DOWNLOAD_TIMEOUT_MS`), la prepara una vez (hash y optimización en paralelo) y corre **todos los vínculos `ACTIVE` del bot en paralelo** con esa misma imagen. Los `SHADOW` corren aparte y nunca bloquean. Si no hay ningún `ACTIVE`, también adelanta el análisis actual.
- **Ahorro:** cada conversación espera `IMAGE_PREFETCH_SETTLE_MS` antes de gastar nada y solo corre un análisis a la vez; una ráfaga de imágenes analiza solo la última, y si llega otra con una en curso queda en cola solo la más nueva. No se adelanta si el bot, la conversación o el chat tienen al equipo activo (se comprueba otra vez justo antes de gastar).
- **Al responder:** recoge el resultado. Si aún no termina, espera (acotado por la descarga más el tope de los vínculos) y responde completo. Si el adelantado falló, no existe o se perdió por un reinicio, se analiza en ese momento como antes. El resultado se conserva mientras la imagen siga disponible, así un reintento no analiza dos veces.
- **Varias capacidades `ACTIVE`:** el prompt lleva una línea por capacidad (`[imagen verificada por el sistema · <capacidad>: …]`; con una sola, el formato de siempre) y cada una guarda su hecho. `imageVerified` es falso si alguna es `INVALID`, verdadero solo si todas son `VALID` y indefinido en otro caso. Un `ERROR` con política `BLOCK` en cualquiera responde el texto de espera de ese vínculo (la primera por nombre de capacidad) y ese turno no llama al modelo.
- **Avisos de revisión pendiente** salen cuando termina el análisis, no al responder.
- **Reversión:** `IMAGE_PREFETCH_ENABLED=false`.

## 4. Datos de referencia para las reglas (grounding)

Las reglas pueden compararse con datos del negocio mediante `ref: "grounding.<clave>"`. Cada clave debe declararse en `contextSources` del especialista:

- `TOOL`: una herramienta del mismo bot, **solo de lectura** (GET o HEAD, sin imagen adjunta ni pausa del bot). Exige `valuePath` (por ejemplo `data.anticipo.monto`). Se llama con la identidad verificada del chat (cabeceras `X-Conduit-*` y el teléfono en el parámetro configurado).
- `EXTERNAL_MAPPING`: una variable externa del bot, con nombre `<espacio>.<clave>` (por ejemplo `vars.titular`). Si se da `valuePath`, se lee dentro de un JSON guardado.

Las consultas corren en paralelo al modelo, con tiempo máximo y una caché en memoria por conversación (vigencia `maxAgeSeconds`, 0 la desactiva). Un dato que no se puede obtener nunca produce `VALID`: la regla pide revisión (`GROUNDING_UNAVAILABLE`). Una fuente `required` caída convierte un `VALID` en `NEEDS_REVIEW`. Una regla que cita una clave sin declarar deja al especialista en error (`RULES_INVALID`) y queda en el log.

## 5. Herramientas con puerta de verificación

Una herramienta puede exigir que el comprobante adjunto esté verificado antes de ejecutarse. Se configura al crearla o editarla:

| Campo | Significado |
|---|---|
| `verificationCapability` | Cualquier capacidad que el bot tenga vinculada (clave en minúsculas con guiones). Crear o actualizar la herramienta falla con 400 si el bot no tiene el vínculo |
| `acceptedVerdicts` | `VALID` y/o `NEEDS_REVIEW` (nunca `INVALID` ni `ERROR`) |
| `verificationParamName` | Opcional: campo del cuerpo donde además va el pasaporte. El modelo no lo ve ni puede pisarlo |
| `onTechnicalFailure` | `REFUSE` (por defecto, como siempre) o `PROCEED_UNVERIFIED`: si el análisis falló por motivos técnicos, la herramienta se ejecuta sin pasaporte y se avisa al backend (ver "Seguir sin verificar ante un fallo técnico") |
| `verifiedParams` | Opcional: mapa `ruta del parámetro → variable` (p. ej. `{"monto":"amount","pago.ref":"reference"}`). Conduit escribe en esos campos el valor del registro verificado, pisa lo que envíe el modelo y se los quita del esquema que ve. Solo variables de la capacidad de la propia herramienta |

Reglas que Conduit valida al configurar: la herramienta debe exigir imagen adjunta, no ser de solo lectura, tener `acceptedVerdicts` y tener `authSecret` (con él se firma el pasaporte). La base lo refuerza con un CHECK.

**La puerta vive en el ejecutor de herramientas**, así que ningún flujo puede saltársela. Para ejecutar, tiene que existir un veredicto de un vínculo `ACTIVE`, de esa misma conversación, para esos mismos bytes (hash normalizado), con un veredicto aceptado, dentro de `SPECIALISTS_PASSPORT_TTL_MINUTES` y sin usar. Los veredictos de `SHADOW` nunca autorizan. Si falta cualquier condición, la herramienta no se llama y el modelo recibe `VERIFICATION_REQUIRED` (HTTP 422 simulado, `nextStep: WAIT_FOR_REVIEW`) sin detalle de la causa.

**Un solo uso.** El veredicto se reclama de forma atómica *antes* de llamar al backend (con llamadas simultáneas ejecuta una sola). Después:
- Éxito: queda consumido, y cualquier reenvío del mismo comprobante (incluso recomprimido o desde otro chat) da `INVALID` (`ALREADY_USED`).
- Rechazo definitivo del backend (4xx salvo 408 y 429): se libera para poder reintentar.
- Resultado ambiguo (408, 429, 5xx o red caída): **queda consumido**, porque el backend pudo haber procesado la solicitud; requiere revisión humana.

### Parámetros verificados

- Se validan al crear o actualizar: la herramienta debe tener puerta; cada variable debe existir en el especialista vinculado; la ruta no puede coincidir ni colgar de los parámetros de imagen, teléfono o pasaporte; las rutas no pueden solaparse; máximo 12.
- Si la variable no se leyó en la imagen (ausente o nula), el campo **no se envía**, incluso si el modelo lo había enviado. El backend decide qué hacer.
- No se interpreta ninguna plantilla: un texto con `{{...}}` escrito por el cliente o el modelo viaja como texto.
- Si luego se quita esa variable del especialista, actualizar la herramienta falla con 400 hasta corregir el mapa. Mientras tanto, en ejecución el campo simplemente no se envía.

### Seguir sin verificar ante un fallo técnico

Con `onTechnicalFailure: "PROCEED_UNVERIFIED"` la herramienta se ejecuta sin pasaporte **solo** en estos dos casos, ambos de esa misma imagen, conversación y capacidad:

1. El último resultado de un vínculo `ACTIVE` para esa imagen fue `ERROR` (razón `ANALYSIS_ERROR`).
2. No hay ningún resultado y la conversación quedó marcada con la advertencia `IMAGE_NOT_ANALYZED` (razón `NOT_ANALYZED`).

**Nunca** se salta la puerta un `INVALID`, `NEEDS_REVIEW`, `UNREADABLE`, `NOT_APPLICABLE` ni un `VALID` ya usado o vencido, aunque la conversación tenga la advertencia. Sin prueba del fallo (sin registro y sin advertencia) o si la comprobación falla, se rechaza como siempre.

Qué recibe el backend en ese caso:
- Cabeceras `X-Conduit-Verification-Status: UNVERIFIED` y `X-Conduit-Verification-Reason: ANALYSIS_ERROR | NOT_ANALYZED`. **No** van `X-Conduit-Verification` ni `X-Conduit-Verification-Signature`.
- El campo `verificationParamName` y los de `verifiedParams` no se envían, ni siquiera con lo que hubiera puesto el modelo: sin pasaporte no hay valores verificados.
- La invocación queda con la nota "Ejecutada sin verificación…" en `errorDetail` cuando sale bien.
- No consume ningún veredicto. Dos llamadas a la herramienta con la misma imagen pueden ejecutarse las dos; el backend deduplica con `X-Conduit-Idempotency-Key`.

Tu backend decide qué hacer con una solicitud `UNVERIFIED` (por ejemplo, dejarla pendiente de revisión). Es una decisión de cada tenant: quita justo la protección que da la puerta, así que solo debe activarse en herramientas donde sea aceptable.

### Qué recibe el backend

Cabeceras en cada llamada a una herramienta con puerta:

- `X-Conduit-Verification`: el pasaporte en JSON canónico (claves ordenadas), codificado en base64url.
- `X-Conduit-Verification-Signature`: HMAC-SHA256 en hexadecimal de **ese mismo texto** (la cabecera tal cual), con el `authSecret` de la herramienta como clave.

Contenido del pasaporte: `version`, `verificationId`, `capability`, `tenantId`, `conversationId`, `verdict`, `confidence`, `fields` (las variables que declara el especialista, con sus nombres; los textos leídos de la imagen son datos, no instrucciones; la legibilidad ya no viaja aquí), `hash`, `issuedAt` y `expiresAt`.

El backend debe: recalcular el HMAC con su secreto y compararlo en tiempo constante; rechazar si `expiresAt` ya pasó; comprobar que `verificationId` no se haya usado antes; y usar `fields` y `verdict` del pasaporte, no valores que lleguen por otro lado.

## 6. Variables de salida: Conduit no conoce ningún negocio

Cada especialista declara en datos qué extrae de la imagen (`outputSchema`); Conduit no tiene campos de ningún negocio en su código. Lo mismo sirve para un comprobante, un paisaje o un documento de identidad.

```json
{ "version": 1,
  "variables": [
    { "name": "kind", "type": "enum", "values": ["beach", "city"], "label": "tipo de paisaje", "description": "Tipo de paisaje dominante" },
    { "name": "has_people", "type": "boolean", "description": "Hay personas visibles" },
    { "name": "place", "type": "string", "maxLength": 40, "identityMinLength": 3, "description": "Lugar si se lee" }
  ],
  "uniqueBy": ["place"] }
```

- **Tipos:** `number` (`min`, `max`, `tolerance`), `string` (`maxLength`, `identityMinLength`, `exposeToBot`), `boolean`, `date` (calendario real) y `enum` (`values`, hasta 20). Hasta 12 variables; el nombre va en minúsculas con guion bajo (máx. 20) y no puede ser `constructor`, `prototype`, `version`, `confidence`, `legibility` ni `variables`. `description` es lo que lee el modelo; `label` se usa en los resúmenes.
- **Meta de Conduit, válida para cualquier imagen:** `confidence`, `isExpectedDocument` y `legibility` (`CLEAR`, `PARTIAL`, `UNREADABLE`). La respuesta del modelo tiene la forma `{"version":2,"confidence":…,"isExpectedDocument":…,"legibility":…,"variables":{…}}`, que se genera y se valida desde la declaración.
- **Reglas:** `field` es el nombre de una variable. Los operadores dependen del tipo: `number` (`gte`, `lte`, `eq`), `date` (`within_days`, `eq`), `string` (`eq`, `contains`, `fuzzy`, `in`, `within`), `boolean` (`eq`), `enum` (`eq`, `in`). Al guardar se rechaza una regla que cite una variable no declarada, un operador que no aplica al tipo o un literal del tipo equivocado (400 con `details.ruleIssues`). Las reglas de un especialista ya guardado se vuelven a comprobar al ejecutarlas: si no cuadran, el resultado es `ERROR` con `RULES_INVALID`.
- **`within`** (texto): el valor leído debe aparecer **dentro** del texto de referencia, comparando solo letras y números (sin importar mayúsculas, tildes, espacios ni guiones) y exigiendo al menos 6 caracteres. Sirve para comprobar que un número de cuenta o teléfono leído de la imagen figura en un texto editable del negocio (por ejemplo, las instrucciones de pago). Es la dirección contraria a `contains`, donde el texto leído contiene la referencia. La referencia debe ser un texto (literal o dato de contexto); un valor que no se leyó nunca da `VALID`.
- **Reutilización:** `uniqueBy` lista las variables que identifican un caso único; sin ella solo aplica el hash de la imagen.
- **Qué ve el modelo conversacional:** solo las variables de tipo cerrado (`number`, `boolean`, `date`, `enum`) y las de texto marcadas `exposeToBot`. El resto se guarda y viaja en el pasaporte al backend, pero nunca entra al prompt.
- **Crear un especialista exige `outputSchema`** con al menos una variable. Cambiar las variables versiona el especialista como cualquier otro cambio y las versiones guardan su declaración.
- **Texto de bloqueo:** el vínculo admite `blockMessage` (máx. 300 caracteres, una línea) para lo que se responde cuando `onFailure` es `BLOCK` y la verificación falla; sin él se usa un texto genérico.
- **Cambio frente al contrato anterior:** un texto declarado como `string` ya no tiene un formato fijo (por ejemplo, la moneda en mayúsculas de 3 letras): solo largo máximo y las defensas de texto hostil.
- Un test estático falla si el código de `src/bot/specialists` (salvo `backfill/`) o la puerta de herramientas vuelve a mencionar campos o vocabulario de un negocio. El script de relleno (`specialists:backfill`) conserva la declaración equivalente a los seis campos anteriores porque es la herramienta de migración del flujo antiguo.

## 7. Administración de especialistas (Fase 5)

Todas las rutas usan el tenant del token. Las de consulta piden autenticación; las que modifican piden además rol propietario o administrador (una API key cuenta como administrador).

| Ruta | Efecto |
|---|---|
| `GET /specialists` | Lista (filtros `status`, `capability`, `includeArchived`), con conteo de vínculos y modelos |
| `GET /specialists/:id`, `GET /specialists/by-key/:key` | Detalle |
| `POST /specialists` | Crea (nace `INACTIVE`, versión 1). La clave se genera del nombre si no se envía |
| `PATCH /specialists/:id` | Cambia nombre, prompt, reglas, contexto o estado. Un cambio de prompt, reglas o contexto crea una versión nueva; `expectedVersion` evita pisar la edición de otra persona (409) |
| `GET /specialists/:id/versions`, `GET .../versions/:n` | Historial y contenido de cada versión |
| `POST /specialists/:id/versions/:n/restore` | Restaura una versión anterior **como una versión nueva** (el historial no se reescribe) |
| `POST /specialists/:id/archive`, `.../unarchive` | Archivar exige que no tenga vínculos en `SHADOW` ni `ACTIVE` |

Los errores de validación, de conflicto de versión y de archivado traen un campo `details` con lo que el panel necesita mostrar: `issues` (campo por campo), `undeclaredKeys`, `currentVersion` o `bindings`. El filtro global de errores solo reenvía esa clave y nunca en errores 5xx.

### Modelos de un especialista

| Ruta | Efecto |
|---|---|
| `GET /specialists/:id/models` | Lista con su estado de uso. **La clave nunca se devuelve** (solo los últimos 4 caracteres) |
| `POST /specialists/:id/models` | Alta de un modelo propio. Roles admitidos: `IMAGE_ANALYSIS` y `FALLBACK`. Se rechazan las claves de relleno; `CUSTOM` exige `baseUrl` |
| `PATCH /specialists/:id/models/:modelId` | Cambia el modelo o **rota la clave** (se vuelve a cifrar y se limpia el estado de fallos) |
| `POST /specialists/:id/models/:modelId/reactivate` | Limpia contadores y fallos y confirma con una llamada de prueba (consume 1 token) |
| `DELETE /specialists/:id/models/:modelId` | Elimina el modelo |

Los modelos que copió el script de relleno conservan la clave que tenía el bot en ese momento: **rotar la clave del bot no cambia la de la copia**; hay que rotarla aquí. Un cambio que dejaría sin modelo utilizable (activo, con credencial válida, rol `IMAGE_ANALYSIS` o `FALLBACK`) a un especialista con vínculos en `SHADOW` o `ACTIVE` se rechaza (409).

### Vínculos bot-especialista

| Ruta | Efecto |
|---|---|
| `GET /bots/:botId/specialists` | Vínculos del bot con un resumen del especialista |
| `PUT /bots/:botId/specialists/:capability` | Crea o cambia el vínculo (`specialistId`, `mode`, `timeoutMs`, `onFailure`). Nace en `OFF` |
| `DELETE /bots/:botId/specialists/:capability` | Elimina un vínculo apagado |

Topes: **`SHADOW` y `ACTIVE`** exigen especialista activo y un modelo utilizable; **`ACTIVE`** exige además al menos una regla (sin reglas toda imagen legible saldría válida). Todos los bloqueos se informan juntos en `details.blockers`. Al pasar a `ACTIVE` se devuelven **advertencias** que no bloquean: menos de 20 verificaciones en `SHADOW` en los últimos 30 días (`LOW_SHADOW_SAMPLE`) o coincidencia menor al 80 % con el análisis actual cuando hay al menos 5 casos comparados (`LOW_SHADOW_AGREEMENT`). Un vínculo en uso (`SHADOW` o `ACTIVE`) no se elimina.

La clave y la capacidad son **inmutables**. Las reglas que citan un dato de contexto sin declararlo en `contextSources` se rechazan al guardar. Cada `VerificationRecord` guarda con qué versión del especialista se generó.

### Consulta de verificaciones y dry-run

- `GET /verifications` (cualquier usuario del tenant): filtros `specialistId`, `botConfigId`, `conversationId`, `capability`, `verdict`, `mode`, `reasonCode`, `pendingReview=true` (veredicto `NEEDS_REVIEW` o `ERROR` sin revisar), `from`, `to` (rango máximo 366 días), `limit` (1 a 100, por defecto 25) y `cursor`. Orden: más reciente primero, con cursor estable (fecha e id). Un filtro desconocido, incluido `tenantId`, da 400. Nunca devuelve imágenes: no se guardan.
- `GET /verifications/:id`: una verificación del tenant (404 si es de otro).
- Cada resultado trae `tokens: {total, input, output}` y `estimatedCostUsd`. Los registros anteriores a la 5c y los modelos que no informan el desglose tienen `input`/`output` en `null` y costo `null`; no se rellenan con ceros.
- `POST /specialists/:id/dry-run` (propietario o administrador, `multipart/form-data`): campo `file` (JPEG, PNG o WebP, máximo 5 MB) y campo opcional `draft` (JSON con `promptTemplate`, `outputSchema`, `rules` y/o `contextSources` para probar cambios sin guardarlos). Devuelve veredicto, campos, códigos de motivo, modelo, tokens, latencia y costo estimado. Responde 200 con `persisted: false`.

El dry-run gasta tokens reales del modelo del especialista. No guarda resultados, no consulta ni marca el historial de reutilización, no resuelve datos de contexto (`groundingSkipped: true`: una regla que dependa de contexto no puede dar `VALID`) y la imagen solo vive en memoria durante la petición. Las peticiones inválidas también cuentan para el límite por minuto.

El costo es una estimación: la tabla base cubre por familia (`claude-haiku`, `claude-sonnet`, `claude-opus`) con valores aproximados que conviene contrastar con la tarifa vigente del proveedor; un modelo sin precio conocido da costo `null` en lugar de un valor inventado.

### Métricas

`GET /verifications/metrics` (cualquier usuario del tenant) agrega con SQL sobre `VerificationRecord`. Filtros: `specialistId`, `botConfigId`, `capability`, `mode`, `from`, `to` (por defecto los últimos 7 días, máximo 366). Devuelve:

- `verdicts`: cantidad y tasa de `VALID`, `INVALID`, `NEEDS_REVIEW` y `ERROR` (tasa `null` si no hay datos).
- `latencyMs`: p50 y p95 solo sobre llamadas reales al modelo (`sample` indica cuántas); los resultados de reutilización, que no llaman al modelo, no sesgan los percentiles.
- `degradationsByReason` (códigos de los `ERROR`) y `reviewsByReason` (códigos de los `NEEDS_REVIEW`), las 20 primeras por frecuencia.
- `reuse`: `ALREADY_USED`, `REUSED_OTHER_CONTACT`, `RESENT_SAME_IMAGE`, `RESENT_SAME_RECEIPT`.
- `tokens` y `estimatedCostUsd` (total y por modelo). Las llamadas sin desglose de tokens o con un modelo sin precio no se estiman: se cuentan en `callsWithoutBreakdown` y `callsExcludedFromCost`, así que el costo total es un mínimo cuando hay registros anteriores a la 5c.
- `shadowAgreement`: coincidencia con el análisis actual, solo sobre los casos `SHADOW` que tienen comparación.

Los resultados guardados en `ACTIVE` por reutilización (`ALREADY_USED`, `REUSED_OTHER_CONTACT`) cuentan en los veredictos pero no en latencia ni tokens. Los retenidos más allá de `SPECIALISTS_RETENTION_DAYS` ya no existen, así que un rango mayor a la retención muestra solo lo que quedó.

### Webhooks de resultados (reacciones del backend)

Cada resultado de un vínculo `ACTIVE` se avisa a los endpoints del tenant con el sistema de webhooks existente (cuerpo congelado y firmado con el secreto del endpoint, `X-Conduit-Event-Id` para deduplicar, hasta 8 reintentos). Se suscribe con la lista `events` del endpoint, o con `*`:

| Evento | Cuándo |
|---|---|
| `verification.valid` / `.invalid` / `.needs_review` / `.unreadable` / `.not_applicable` / `.error` | Tras guardar un análisis nuevo con ese veredicto |
| `verification.reviewed` | Cuando una persona decide una verificación dudosa o con error |

- **Contenido:** `verificationId`, `conversationId`, `botConfigId`, `specialistId`, `capability`, `mode`, `verdict`, `confidence`, `reasonCodes`, `humanSummary` y `variables` (todas las leídas, incluidos los textos libres; `exposeToBot` solo protege al modelo conversacional). La revisión lleva `reviewDecision`, `reviewNote` y `reviewedAt`, sin el usuario que revisó. Nunca va la imagen.
- **No se avisa** desde `SHADOW`, ni cuando se reutiliza un veredicto ya registrado (mismo reenvío), ni si el registro no se pudo guardar.
- No consume el veredicto ni usa la puerta de las herramientas: es solo una notificación. Entrega al menos una vez; el receptor debe deduplicar por `X-Conduit-Event-Id`.
- No espera la entrega ni puede fallar la respuesta al cliente: un problema registrando el webhook queda en el log.
- Costo: cero tokens (una fila y un trabajo en cola por endpoint suscrito).

### Imágenes pendientes de revisión

Cuando un vínculo en `ACTIVE` produce `NEEDS_REVIEW` o `ERROR` (incluidos los casos de reutilización con otro contacto), el bot avisa a los contactos de escalamiento del bot. Es un disparador nuevo, **`VERIFICATION_REVIEW`**, que es **opt-in**: los contactos existentes solo reciben `TECHNICAL_ERROR` y no recibirán nada hasta que se les agregue (`POST /bots/:botId/escalation-contacts` con `"notifyOn": ["VERIFICATION_REVIEW"]`). No hay migración: `notifyOn` ya es JSON.

- El aviso incluye cliente, resultado, códigos de motivo y el id de la verificación; **no** incluye los datos extraídos de la imagen.
- Se envía como máximo uno por conversación y ventana. Si nadie pudo recibirlo (sin contactos o con la entrega fallida), no consume la ventana y se reintenta con la siguiente imagen.
- En `SHADOW` nunca avisa.
- El aviso es de mejor esfuerzo: si falla, la conversación continúa.

`POST /verifications/:id/review` (propietario o administrador) registra la decisión de una persona sobre un resultado `NEEDS_REVIEW` o `ERROR`: `{"decision": "APPROVED" | "REJECTED", "note": "..."}`. Guarda `reviewedAt`, `reviewedBy` (el usuario del token), `reviewDecision` y `reviewNote`, y nada más. **Es solo constancia de auditoría**: no cambia el veredicto, no consume ni habilita nada, y la puerta de las herramientas no lee esos campos (hay una prueba que lo garantiza). Una verificación se revisa una sola vez (409 `ALREADY_REVIEWED`; dos peticiones simultáneas resuelven con una sola ganadora) y solo si es `NEEDS_REVIEW` o `ERROR` (409 `NOT_REVIEWABLE`). Las revisadas salen de `?pendingReview=true`. Para que una imagen dudosa llegue a una herramienta estricta, la clienta debe reenviarla y obtener un `VALID`, o la herramienta debe aceptar `NEEDS_REVIEW` de forma explícita.

### Banco de evaluación (línea de comandos)

Sirve para medir un especialista (o un cambio de prompt o reglas) contra casos reales antes de pasarlo a `ACTIVE`, y para comparar dos versiones. Las imágenes viven en una carpeta tuya; **no se guardan en la base ni en los resultados** (solo su huella SHA-256).

Carpeta del banco: por cada `caso.jpg|png|webp` (máximo 5 MB, hasta 200 casos) un `caso.expected.json`:

```json
{ "verdict": "VALID", "fields": { "amount": 150000, "reference": "TRX-48210377" } }
```

`verdict` es uno de `VALID`, `INVALID`, `NEEDS_REVIEW`, `UNREADABLE`, `NOT_APPLICABLE`, `ERROR`. `fields` es opcional y solo se revisan los campos que listes, que deben ser variables declaradas por el especialista (se valida nombre y tipo antes de gastar nada); los números usan la tolerancia declarada, los booleanos, fechas y enums se comparan exactos y los textos sin importar mayúsculas ni espacios repetidos. Un banco con problemas (imagen sin esperado, JSON inválido, nombres repetidos, imagen ilegible) se rechaza completo antes de gastar nada.

Se usa desde el código compilado (`npm run build` primero), con las variables de entorno del servicio (`DATABASE_URL`, `INTEGRATION_ENCRYPTION_KEY`):

```bash
npm run specialists:eval -- run --dir=./banco --tenant=<tenantId> --specialist=<clave|id>
```

Sin `--yes` solo valida el banco y el especialista y **no llama al modelo**. Con `--yes` ejecuta la evaluación y **gasta tokens reales** del modelo propio del especialista (exige al menos un modelo activo de análisis de imágenes). La corrida se detiene al alcanzar `--max-cost-usd` (0.5 por defecto) o `--max-tokens` (300000); los casos restantes quedan como omitidos y el informe lo advierte. `--draft=<archivo.json>` prueba un borrador de `promptTemplate`, `rules` y/o `contextSources` sin guardarlo; `--out` fija el archivo de resultado (por defecto `eval-<clave>-<fecha>.json`, permisos 0600).

El informe trae acierto de veredicto, **falsos válidos** (esperado distinto de `VALID` y salió `VALID`, el error caro), falsos rechazos, matriz de confusión, acierto por campo, latencia p50/p95, tokens y costo estimado, y la lista de casos con diferencias. Una evaluación usa `dryRun`: no escribe resultados ni toca el historial de reutilización, y no resuelve datos de contexto (una regla que dependa de ellos no puede dar `VALID`). Los contadores de uso del modelo (`tokensUsedToday`) sí avanzan, porque el gasto es real.

```bash
npm run specialists:eval -- compare --a=antes.json --b=despues.json [--json] [--fail-on-regression]
```

Compara solo los casos comunes con la misma imagen (avisa de los demás), lista regresiones, mejoras y cambios que siguen mal, y lanza una **alerta de seguridad** si B deja pasar más falsos válidos. Con `--fail-on-regression` el comando termina con código 2 si B es peor o no mejora (más falsos válidos, menor acierto, o más regresiones que mejoras).

## 8. Endurecimiento de la salida del modelo

Todo texto que el modelo lee de la imagen (cualquier variable de tipo texto) y el resumen del veredicto se rechazan si contienen saltos de línea, caracteres de control, separadores de línea o párrafo Unicode, marcas de dirección (incluida la inversión `U+202E`), caracteres de ancho cero o el BOM. Las fechas se validan contra el calendario real (`2026-02-31` es inválida). Una respuesta con claves `__proto__`, `constructor` o `prototype` es `ERROR`. No existe un camino en el que una respuesta del modelo produzca `VALID` por texto libre, por un campo de veredicto propio o por texto fuera del JSON.

Para los modelos de la familia 5.x, la extracción de imágenes se pide con `effort: low` (los demás modelos no reciben el parámetro).

## 9. Límites conocidos

- Los modelos del relleno son **copias**: rotar la clave de un bot no actualiza la del especialista.
- Sin reglas, un especialista legible da `VALID`. Las reglas con valores literales ya se evalúan; las que dependen de datos de contexto dan `NEEDS_REVIEW` hasta que se resuelva ese contexto.
- Una herramienta con puerta exige que el bot tenga vínculo para su capacidad (cualquier modo). Eliminar ese vínculo responde 409 mientras alguna herramienta lo use. Pasarlo a OFF sí se permite: la puerta rechaza entonces la herramienta, que es el lado seguro.
- El hash exacto de la imagen no detecta reenvíos recomprimidos (WhatsApp recomprime); eso lo cubre la huella de variables (`uniqueBy` del especialista), que solo existe si todas sus variables se leyeron y cada texto cumple su `identityMinLength`.
- La detección de reutilización y el caché solo aplican a vínculos en `ACTIVE`; en `SHADOW` solo se registra.
- El análisis legado conserva sus defectos (texto positivo no JSON se acepta como válido).
- El proveedor de Anthropic no desactiva el razonamiento: parte de los tokens de salida se gasta en `thinking`.
- La caché de datos de referencia vive en memoria del proceso; con una sola réplica es correcta, y con varias cada réplica tendría la suya.
- Cada análisis adelantado gasta tokens aunque después el bot no responda (por ejemplo, si la persona escribe otra cosa o el equipo toma la conversación); la ventana de `IMAGE_PREFETCH_SETTLE_MS` y el "un análisis a la vez" acotan ese gasto, no lo eliminan. Una imagen que llega con otra ya analizándose no cancela la primera: su costo ya se gastó.
- El adelantado vive en memoria del proceso: tras un reinicio se pierde y se analiza al responder.
- El límite de dry-run vive en memoria del proceso y se reinicia al reiniciar; con una sola réplica es correcto.
- El banco de evaluación mide la extracción y las reglas con los datos del banco, pero no el contexto externo (grounding); las reglas que lo necesiten no se pueden evaluar ahí.
- La ventana de los avisos de revisión vive en memoria del proceso: al reiniciar se pierde y puede repetirse un aviso.
- Los cuerpos de `WebhookDelivery` se guardan en la base con las variables del resultado (datos del negocio). No hay una limpieza automática de esa tabla: definir una retención antes de usar estos eventos con datos sensibles.
- El aviso se registra después de guardar el resultado, sin outbox transaccional: si el proceso se cae en esa ventana, ese aviso se pierde.
- El conteo del camino antiguo no tiene claves foráneas: las filas de un bot borrado quedan huérfanas (pocas y pequeñas).
- Conduit corre en una sola réplica; no escalar horizontalmente.
