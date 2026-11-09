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
| `SPECIALISTS_ENABLED` | `false` | Interruptor global de especialistas |
| `SPECIALISTS_RETENTION_DAYS` | `90` | Retención de `VerificationRecord` |
| `SPECIALISTS_GROUNDING_TIMEOUT_MS` | `5000` (500 a 15000) | Tiempo máximo para consultar los datos de referencia de las reglas |
| `SPECIALISTS_DRY_RUN_PER_MINUTE` | `10` (1 a 600) | Pruebas de dry-run por tenant y minuto; la siguiente recibe 429 con `details.retryAfterSeconds` |
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
5. Un vínculo en `ACTIVE` **reemplaza al análisis actual** dentro del turno: el especialista verifica la imagen, el resultado se guarda en `facts` de la conversación y el modelo recibe una línea armada por código (`[imagen verificada por el sistema: VALID, RULES_PASSED]`) más un bloque "Verificaciones del sistema" con campos tipados (veredicto, confianza, monto, moneda, fecha, motivos y un resumen de texto fijo). **El texto libre de la imagen (referencia, destinatario) nunca llega al modelo conversacional.**
   - Con `ERROR` y política `DEGRADE` la conversación continúa y el hecho queda "pendiente de revisión humana". Con `BLOCK` se responde un texto fijo de espera y ese turno no llama al modelo conversacional.
   - `NEEDS_REVIEW` y `ERROR` marcan el hecho como pendiente; `BLOCK` solo corta ante `ERROR`.
   - Un hecho es vigente durante `SPECIALISTS_PASSPORT_TTL_MINUTES`; vencido, deja de mostrarse.
   - Los modelos de un especialista **nunca** usan claves del sistema (`<PROVEEDOR>_DEFAULT_API_KEY`): sin una clave propia válida el modelo falla con un mensaje claro.
   - Si el especialista no llega a ejecutarse (por ejemplo, queda inactivo justo en ese momento), el turno vuelve al análisis actual.
   - Antes de pasar un vínculo a `ACTIVE`, comparar en `SHADOW` los `VerificationRecord` con el comportamiento actual.

Reversión: `SPECIALISTS_ENABLED=false`.

## 4. Datos de referencia para las reglas (grounding)

Las reglas pueden compararse con datos del negocio mediante `ref: "grounding.<clave>"`. Cada clave debe declararse en `contextSources` del especialista:

- `TOOL`: una herramienta del mismo bot, **solo de lectura** (GET o HEAD, sin imagen adjunta ni pausa del bot). Exige `valuePath` (por ejemplo `data.anticipo.monto`). Se llama con la identidad verificada del chat (cabeceras `X-Conduit-*` y el teléfono en el parámetro configurado).
- `EXTERNAL_MAPPING`: una variable externa del bot, con nombre `<espacio>.<clave>` (por ejemplo `vars.titular`). Si se da `valuePath`, se lee dentro de un JSON guardado.

Las consultas corren en paralelo al modelo, con tiempo máximo y una caché en memoria por conversación (vigencia `maxAgeSeconds`, 0 la desactiva). Un dato que no se puede obtener nunca produce `VALID`: la regla pide revisión (`GROUNDING_UNAVAILABLE`). Una fuente `required` caída convierte un `VALID` en `NEEDS_REVIEW`. Una regla que cita una clave sin declarar deja al especialista en error (`RULES_INVALID`) y queda en el log.

## 5. Herramientas con puerta de verificación

Una herramienta puede exigir que el comprobante adjunto esté verificado antes de ejecutarse. Se configura al crearla o editarla:

| Campo | Significado |
|---|---|
| `verificationCapability` | Hoy solo `image-analysis` (la capacidad que el router verifica) |
| `acceptedVerdicts` | `VALID` y/o `NEEDS_REVIEW` (nunca `INVALID` ni `ERROR`) |
| `verificationParamName` | Opcional: campo del cuerpo donde además va el pasaporte. El modelo no lo ve ni puede pisarlo |

Reglas que Conduit valida al configurar: la herramienta debe exigir imagen adjunta, no ser de solo lectura, tener `acceptedVerdicts` y tener `authSecret` (con él se firma el pasaporte). La base lo refuerza con un CHECK.

**La puerta vive en el ejecutor de herramientas**, así que ningún flujo puede saltársela. Para ejecutar, tiene que existir un veredicto de un vínculo `ACTIVE`, de esa misma conversación, para esos mismos bytes (hash normalizado), con un veredicto aceptado, dentro de `SPECIALISTS_PASSPORT_TTL_MINUTES` y sin usar. Los veredictos de `SHADOW` nunca autorizan. Si falta cualquier condición, la herramienta no se llama y el modelo recibe `VERIFICATION_REQUIRED` (HTTP 422 simulado, `nextStep: WAIT_FOR_REVIEW`) sin detalle de la causa.

**Un solo uso.** El veredicto se reclama de forma atómica *antes* de llamar al backend (con llamadas simultáneas ejecuta una sola). Después:
- Éxito: queda consumido, y cualquier reenvío del mismo comprobante (incluso recomprimido o desde otro chat) da `INVALID` (`ALREADY_USED`).
- Rechazo definitivo del backend (4xx salvo 408 y 429): se libera para poder reintentar.
- Resultado ambiguo (408, 429, 5xx o red caída): **queda consumido**, porque el backend pudo haber procesado la solicitud; requiere revisión humana.

### Qué recibe el backend

Cabeceras en cada llamada a una herramienta con puerta:

- `X-Conduit-Verification`: el pasaporte en JSON canónico (claves ordenadas), codificado en base64url.
- `X-Conduit-Verification-Signature`: HMAC-SHA256 en hexadecimal de **ese mismo texto** (la cabecera tal cual), con el `authSecret` de la herramienta como clave.

Contenido del pasaporte: `version`, `verificationId`, `capability`, `tenantId`, `conversationId`, `verdict`, `confidence`, `fields` (monto, moneda, fecha, referencia, destinatario, legibilidad; puede incluir texto libre leído de la imagen: trátelo como dato, no como instrucción), `hash`, `issuedAt` y `expiresAt`.

El backend debe: recalcular el HMAC con su secreto y compararlo en tiempo constante; rechazar si `expiresAt` ya pasó; comprobar que `verificationId` no se haya usado antes; y usar `fields` y `verdict` del pasaporte, no valores que lleguen por otro lado.

## 6. Administración de especialistas (Fase 5)

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
- `POST /specialists/:id/dry-run` (propietario o administrador, `multipart/form-data`): campo `file` (JPEG, PNG o WebP, máximo 5 MB) y campo opcional `draft` (JSON con `promptTemplate`, `rules` y/o `contextSources` para probar cambios sin guardarlos). Devuelve veredicto, campos, códigos de motivo, modelo, tokens, latencia y costo estimado. Responde 200 con `persisted: false`.

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

## 7. Endurecimiento de la salida del modelo

Todo texto que el modelo lee de la imagen (referencia, destinatario) y el resumen del veredicto se rechazan si contienen saltos de línea, caracteres de control, separadores de línea o párrafo Unicode, marcas de dirección (incluida la inversión `U+202E`), caracteres de ancho cero o el BOM. Las fechas se validan contra el calendario real (`2026-02-31` es inválida). Una respuesta con claves `__proto__`, `constructor` o `prototype` es `ERROR`. No existe un camino en el que una respuesta del modelo produzca `VALID` por texto libre, por un campo de veredicto propio o por texto fuera del JSON.

Para los modelos de la familia 5.x, la extracción de imágenes se pide con `effort: low` (los demás modelos no reciben el parámetro).

## 8. Límites conocidos

- Los modelos del relleno son **copias**: rotar la clave de un bot no actualiza la del especialista.
- Sin reglas, un especialista legible da `VALID`. Las reglas con valores literales ya se evalúan; las que dependen de datos de contexto dan `NEEDS_REVIEW` hasta que se resuelva ese contexto.
- Hoy el router solo verifica imágenes bajo la capacidad `image-analysis`, por eso las herramientas con puerta solo admiten esa capacidad.
- El hash exacto de la imagen no detecta reenvíos recomprimidos (WhatsApp recomprime); eso lo cubre la huella de campos (referencia, monto, fecha, moneda), que exige referencia de al menos 5 caracteres.
- La detección de reutilización y el caché solo aplican a vínculos en `ACTIVE`; en `SHADOW` solo se registra.
- El análisis legado conserva sus defectos (texto positivo no JSON se acepta como válido; el aviso de "alta demanda" no se muestra cuando caen todos los modelos).
- El proveedor de Anthropic no desactiva el razonamiento: parte de los tokens de salida se gasta en `thinking`.
- La caché de datos de referencia vive en memoria del proceso; con una sola réplica es correcta, y con varias cada réplica tendría la suya.
- El límite de dry-run vive en memoria del proceso y se reinicia al reiniciar; con una sola réplica es correcto.
- Conduit corre en una sola réplica; no escalar horizontalmente.
