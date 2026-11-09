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
5. Un vínculo en `ACTIVE` todavía no responde por sí solo: se usa el análisis actual y queda un aviso en el log.

Reversión: `SPECIALISTS_ENABLED=false`.

## 4. Límites conocidos

- Los modelos del relleno son **copias**: rotar la clave de un bot no actualiza la del especialista.
- Sin reglas, un especialista legible da `VALID`. Las reglas con valores literales ya se evalúan; las que dependen de datos de contexto dan `NEEDS_REVIEW` hasta que se resuelva ese contexto.
- El hash exacto de la imagen no detecta reenvíos recomprimidos (WhatsApp recomprime); eso lo cubre la huella de campos (referencia, monto, fecha, moneda), que exige referencia de al menos 5 caracteres.
- La detección de reutilización y el caché solo aplican a vínculos en `ACTIVE`; en `SHADOW` solo se registra.
- El análisis legado conserva sus defectos (texto positivo no JSON se acepta como válido; el aviso de "alta demanda" no se muestra cuando caen todos los modelos).
- El proveedor de Anthropic no desactiva el razonamiento: parte de los tokens de salida se gasta en `thinking`.
- Conduit corre en una sola réplica; no escalar horizontalmente.
