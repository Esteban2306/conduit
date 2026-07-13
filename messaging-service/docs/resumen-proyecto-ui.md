# Resumen del proyecto y propuesta de interfaz grafica

## Vision general

Este proyecto es un microservicio backend de mensajeria multicanal construido con NestJS, Prisma, PostgreSQL, Redis y BullMQ. Su objetivo principal es recibir solicitudes de envio, renderizar plantillas personalizadas, encolar mensajes, enviarlos por distintos canales y registrar su estado. Ademas incluye un modulo de bot conversacional para WhatsApp con modelos de IA, prompts configurables, memoria de conversacion, analisis de imagenes y takeover humano.

El servicio expone una API REST bajo el prefijo `/api/v1`, protegida con `x-api-key`, y en desarrollo publica Swagger en `/docs`.

## Tecnologias principales

- Backend: NestJS 11 con TypeScript.
- Base de datos: PostgreSQL via Prisma.
- Cola de trabajos: BullMQ sobre Redis.
- Plantillas: Handlebars.
- IA: proveedores OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral y Custom.
- WhatsApp: Baileys como canal principal, con referencias a Green API y WaLink.
- Email: Resend para Gmail/Googlemail y SMTP para otros dominios.
- Archivos masivos: CSV y Excel mediante PapaParse/XLSX.
- Imagenes: Sharp y servicios de analisis IA.
- Observabilidad basica: logs NestJS, estados de mensajes, intentos, dead letters y health check.

## Modulos existentes

### Salud y configuracion base

El sistema tiene un endpoint de health check y validacion de variables de entorno. Requiere llaves como `API_SECRET_KEY`, `DATABASE_URL`, Redis, `WEBHOOK_SIGNING_SECRET` y credenciales opcionales para email, SMTP, WhatsApp y proveedores externos.

### Mensajeria y orquestacion

El modulo de mensajes permite:

- Encolar un mensaje individual.
- Encolar mensajes por lote.
- Enviar mensajes masivos usando una plantilla comun.
- Subir CSV o Excel con destinatarios y variables.
- Programar mensajes con `scheduledAt`.
- Definir prioridad `low`, `normal` o `high`.
- Listar mensajes con filtros por cola, estado, canal, fecha y destinatario.
- Consultar estado detallado de un mensaje.
- Cancelar mensajes pendientes, en cola o fallidos.

Estados soportados:

- `PENDING`
- `QUEUED`
- `PROCESSING`
- `SENT`
- `FAILED`
- `RETRYING`
- `DEAD`
- `CANCELLED`

Canales soportados:

- `WHATSAPP`
- `EMAIL`
- `SMTP`

### Plantillas

El modulo de plantillas permite:

- Crear plantillas HTML con Handlebars.
- Listar plantillas activas.
- Consultar una plantilla por ID.
- Actualizar plantillas.
- Eliminar plantillas.
- Previsualizar el resultado renderizado con variables.

Cada plantilla tiene nombre, descripcion, canal, asunto opcional, cuerpo Handlebars, esquema de variables, estado activo y tags.

### Tags

El sistema incluye etiquetas para organizar plantillas:

- Crear tags.
- Listar tags.
- Consultar tag por ID.
- Actualizar tag.
- Eliminar tag.
- Asignar tags a una plantilla.
- Desasignar tags de una plantilla.

### Bot de WhatsApp con IA

El bot puede configurarse por tenant y tiene estado `ACTIVE`, `INACTIVE` o `PAUSED`. Sus capacidades principales son:

- Escuchar mensajes entrantes de WhatsApp.
- Ignorar grupos y mensajes enviados por el propio usuario.
- Ignorar mensajes antiguos segun `maxMessageAgeMinutes`.
- Ignorar mensajes triviales como "ok", "gracias", "listo", etc.
- Acumular mensajes durante un retraso configurable antes de responder.
- Cancelar la respuesta si detecta actividad humana reciente.
- Registrar takeover humano cuando el duenio responde manualmente.
- Crear o reutilizar conversaciones activas por telefono.
- Guardar mensajes entrantes y salientes.
- Mantener contexto JSON, resumen, ultimo intent y paso actual.
- Aplicar locks de procesamiento para evitar respuestas duplicadas.
- Construir prompts con configuracion, historial, contexto y conocimiento.
- Llamar al orquestador de IA y usar fallback entre modelos si un proveedor falla.
- Evitar respuestas demasiado similares a la respuesta anterior.
- Enviar respuestas al canal mediante eventos.
- Analizar imagenes si `imageAnalysisEnabled` esta activo.

### Configuracion de bots

La API permite:

- Crear configuracion de bot.
- Listar bots.
- Consultar bot por ID.
- Actualizar configuracion.
- Activar/desactivar bot.
- Agregar modelos de IA a un bot.
- Listar modelos configurados.
- Resetear contadores de uso de modelos.
- Eliminar modelos.

Campos relevantes del bot:

- Nombre.
- Prompt de sistema base.
- Analisis de imagenes habilitado.
- URL base de API del cliente.
- Headers para API externa del cliente.
- Endpoints por intent.
- Maximo de mensajes historicos.
- Edad maxima de mensajes entrantes.
- Minutos de takeover humano.
- Retraso antes de responder.
- Timeout de conversacion.

### Modelos de IA

Cada bot puede tener varios modelos con:

- Proveedor.
- Modelo.
- API key.
- Base URL para provider custom.
- Rol: conversacion, analisis de imagen o fallback.
- Tier: free o paid.
- Prioridad.
- Limite diario de tokens.
- Limite de requests por minuto.
- Contadores de uso.

El selector elige modelos por rol y prioridad, registra uso y marca modelos no disponibles cuando fallan.

### Prompts y comportamiento IA

El sistema tiene endpoints para administrar prompts por bot:

- Obtener settings de comportamiento.
- Actualizar settings.
- Listar plantillas de prompt.
- Obtener prompt por tipo.
- Actualizar prompt por tipo.
- Previsualizar prompt renderizado y estimar tokens.

Tipos de prompt:

- `CONVERSATION`
- `IMAGE_ANALYSIS`
- `SUMMARY`
- `SALES`
- `APPOINTMENT`
- `SUPPORT`
- `FALLBACK`

Settings de IA disponibles:

- Nombre del agente.
- Idioma.
- Tono.
- Personalidad.
- Objetivos.
- Verbosidad.
- Formato de respuesta.
- Creatividad.
- Confianza.
- Persuasion.
- Comportamiento fallback.
- Longitud de respuesta.
- Nivel de emojis.
- Markdown permitido.
- Nombre de la empresa.
- Servicios.
- Horarios.
- Saludo.
- Despedida.
- Restricciones.
- Temperatura.
- Max tokens para conversacion, imagen y resumen.

### Conversaciones

Internamente existen conversaciones con:

- Telefono.
- Bot asociado.
- Estado: `ACTIVE`, `WAITING_PAYMENT`, `COMPLETED`, `ABANDONED`.
- Contexto JSON.
- Resumen.
- Ultimo mensaje.
- Ultimo intent.
- Paso actual.
- Lock de procesamiento.
- Mensajes asociados.

El servicio tiene funciones para listar conversaciones por bot, obtener historial, actualizar contexto, resetear contexto, cerrar, reabrir, marcar espera de pago, actualizar resumen, cerrar expiradas y obtener estadisticas. Sin embargo, no se observa un controller HTTP dedicado para estas operaciones.

### Webhooks

Existe servicio de webhooks para:

- Crear endpoints con secreto.
- Listar endpoints activos.
- Desactivar endpoints.
- Consultar entregas recientes.

El modelo de datos tambien registra entregas por webhook. No se observa un controller HTTP dedicado para administrar webhooks desde API.

### Eventos internos

El sistema usa eventos para desacoplar acciones:

- Mensaje recibido.
- Mensaje generado.
- Respuesta de bot solicitada, generada o fallida.
- Conversacion creada, actualizada o cerrada.
- Contexto actualizado.
- Envio por canal solicitado, completado o fallido.
- WhatsApp conectado o desconectado.

### Colas y reintentos

BullMQ gestiona mensajes inmediatos y programados. El sistema guarda intentos, clasifica errores, maneja reintentos y registra dead letters para mensajes que no se pudieron entregar.

## Interfaz grafica recomendada

Una interfaz completa deberia funcionar como panel operativo para configurar bots, crear campanas, revisar conversaciones y monitorear entregas.

### 1. Dashboard

Debe mostrar:

- Mensajes enviados, pendientes, fallidos y muertos.
- Conversaciones activas, en espera de pago, completadas y abandonadas.
- Estado del bot activo.
- Estado de WhatsApp.
- Consumo de tokens por modelo.
- Errores recientes.
- Envios programados proximos.
- Tasa de exito por canal.

Acciones rapidas:

- Crear envio.
- Subir archivo masivo.
- Crear plantilla.
- Abrir conversaciones.
- Configurar bot.

### 2. Bandeja de mensajes enviados

Debe permitir:

- Ver tabla de mensajes con canal, destinatario, plantilla, estado, fecha programada, fecha enviada, proveedor y error.
- Filtrar por estado, canal, cola, destinatario y rango de fechas.
- Consultar detalle de intentos.
- Ver payload renderizado.
- Ver dead letter si existe.
- Cancelar mensajes elegibles.
- Reintentar mensajes fallidos si se implementa endpoint de requeue.

### 3. Creador de envio individual

Debe incluir:

- Selector de canal.
- Destinatario.
- Selector de plantilla o plantilla inline.
- Editor de variables JSON o formulario dinamico desde `variablesSchema`.
- Programacion de fecha/hora.
- Prioridad.
- Vista previa antes de encolar.
- Confirmacion de envio.

### 4. Envios masivos

Debe incluir:

- Selector de plantilla.
- Carga de CSV/XLS/XLSX.
- Mapeo de columnas a variables.
- Validacion de filas.
- Previsualizacion de muestra.
- Resumen de errores de parseo.
- Programacion y prioridad.
- Resultado de filas encoladas/fallidas.

### 5. Plantillas

Debe incluir:

- Listado con filtros por canal, estado y tags.
- Editor de plantilla con syntax highlighting para Handlebars.
- Campo de asunto.
- Editor de esquema de variables.
- Previsualizacion renderizada.
- Duplicar plantilla.
- Activar/desactivar.
- Asignar tags.

### 6. Tags

Debe incluir:

- CRUD de tags.
- Color de tag.
- Asociacion rapida a plantillas.
- Filtro de plantillas por tag.

### 7. Bots

Debe incluir:

- Listado de bots.
- Estado activo/inactivo/pausado.
- Crear y editar bot.
- Toggle de activacion.
- Configurar prompt base.
- Configurar analisis de imagenes.
- Configurar tiempos: delay de respuesta, takeover humano, timeout, edad maxima de mensajes, historial maximo.
- Configurar API externa del cliente: base URL, headers e intent endpoints.

### 8. Modelos de IA

Debe incluir:

- Tabla de modelos por bot.
- Proveedor, modelo, rol, tier, prioridad y estado.
- Limites de tokens/requests.
- Contadores de uso.
- Reset de contadores.
- Crear, editar y eliminar modelos.
- Indicador de fallback y orden de prioridad.
- Prueba de conexion por modelo, si se agrega endpoint.

### 9. Editor de prompts

Debe incluir:

- Tabs por tipo de prompt.
- Editor de contenido.
- Panel de variables disponibles.
- Preview renderizado.
- Estimacion de tokens.
- Restaurar default.
- Historial/versiones, si se decide exponer versiones.

### 10. Ajustes de comportamiento IA

Debe incluir controles para:

- Nombre del agente.
- Idioma.
- Tono.
- Personalidad.
- Objetivos.
- Longitud de respuesta.
- Nivel de emojis.
- Markdown.
- Temperatura.
- Max tokens por caso.
- Informacion de empresa, servicios, horarios, saludo, despedida y restricciones.

### 11. Conversaciones

Esta es una de las pantallas mas importantes para operar el bot. Deberia incluir:

- Inbox por bot.
- Lista de conversaciones con telefono, estado, ultimo mensaje, intent y paso.
- Chat completo con mensajes inbound/outbound.
- Indicador de quien proceso cada salida: bot o humano.
- Envio manual como humano.
- Boton para tomar control humano.
- Boton para devolver al bot.
- Cerrar conversacion como completada o abandonada.
- Marcar como espera de pago.
- Editar contexto JSON.
- Ver resumen.
- Regenerar resumen, si se agrega endpoint.
- Ver imagen verificada y detalles de analisis.

Para esto hace falta exponer controllers HTTP sobre funciones que ya existen en `ConversationService`.

### 12. WhatsApp

Debe incluir:

- Estado de conexion.
- Modo configurado: Baileys, Green API o WaLink.
- QR para conectar sesion Baileys.
- Reconectar/desconectar.
- Ultimo evento de conexion.
- Sesion asociada al bot.
- Indicador de actividad humana reciente por chat, si se desea operar takeover.

Parte de esto parece existir internamente, pero no esta completamente expuesto como API administrativa.

### 13. Webhooks

Debe incluir:

- Crear webhook con URL y eventos.
- Listar webhooks activos.
- Desactivar webhook.
- Ver secreto generado.
- Ver entregas recientes, status HTTP, respuesta y numero de intentos.
- Reenviar entrega fallida, si se implementa endpoint.

Actualmente existe servicio y modelo, pero falta controller HTTP visible.

### 14. Configuracion del sistema

Debe incluir:

- Estado de base de datos y Redis.
- Variables configuradas por entorno sin revelar secretos.
- Configuracion de canales email/SMTP/WhatsApp.
- Health check.
- Informacion de version.

### 15. Logs y auditoria

Debe incluir:

- Eventos recientes.
- Errores de IA.
- Errores de canal.
- Mensajes enviados manualmente por humano.
- Cambios de configuracion de bots, modelos, prompts y plantillas.

Esto requeriria persistir auditoria o conectar una fuente de logs, porque hoy el sistema usa principalmente logs de aplicacion y eventos internos.

## Endpoints existentes utiles para la UI

Base: `/api/v1`

- `GET /health`
- `POST /messages`
- `POST /messages/batch`
- `POST /messages/bulk`
- `POST /messages/upload`
- `GET /messages`
- `GET /messages/:id/status`
- `DELETE /messages/:id`
- `POST /templates`
- `GET /templates`
- `GET /templates/:id`
- `PUT /templates/:id`
- `DELETE /templates/:id`
- `POST /templates/:id/preview`
- `POST /tags`
- `GET /tags`
- `GET /tags/:id`
- `PUT /tags/:id`
- `DELETE /tags/:id`
- `POST /tags/templates/:templateId/assign`
- `DELETE /tags/templates/:templateId/unassign`
- `POST /bot/config`
- `GET /bot/config`
- `GET /bot/config/:id`
- `PUT /bot/config/:id`
- `PATCH /bot/config/:id/toggle`
- `POST /bot/config/:id/models`
- `GET /bot/config/:id/models`
- `PATCH /bot/config/:id/models/:modelId/reset`
- `DELETE /bot/config/:id/models/:modelId`
- `GET /bots/:botId/prompts/settings`
- `PUT /bots/:botId/prompts/settings`
- `POST /bots/:botId/prompts/preview`
- `GET /bots/:botId/prompts`
- `GET /bots/:botId/prompts/:type`
- `PUT /bots/:botId/prompts/:type`

## Endpoints recomendados que faltan para una UI completa

### Conversaciones

- `GET /bots/:botId/conversations`
- `GET /conversations/:id`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages/human`
- `PATCH /conversations/:id/context`
- `DELETE /conversations/:id/context`
- `PATCH /conversations/:id/status`
- `PATCH /conversations/:id/waiting-payment`
- `PATCH /conversations/:id/reopen`
- `PATCH /conversations/:id/summary`
- `GET /bots/:botId/conversations/stats`

### WhatsApp

- `GET /whatsapp/status`
- `GET /whatsapp/qr`
- `POST /whatsapp/connect`
- `POST /whatsapp/disconnect`
- `POST /whatsapp/reconnect`
- `GET /whatsapp/sessions`

### Webhooks

- `POST /webhooks`
- `GET /webhooks`
- `DELETE /webhooks/:id`
- `GET /webhooks/:id/deliveries`
- `POST /webhooks/deliveries/:id/retry`

### Operacion de colas

- `GET /queues/stats`
- `GET /queues/jobs`
- `POST /messages/:id/retry`
- `POST /dead-letter/:id/requeue`
- `PATCH /dead-letter/:id/review`

### IA y pruebas

- `POST /bot/config/:id/models/:modelId/test`
- `POST /bot/config/:id/test-response`
- `POST /bot/config/:id/test-image-analysis`

### Auditoria

- `GET /audit-log`
- `GET /events`

## Prioridad sugerida para construir la interfaz

1. Dashboard operativo.
2. Plantillas y tags.
3. Envio individual y masivo.
4. Bandeja de mensajes y detalle de estado.
5. Configuracion de bots.
6. Modelos de IA.
7. Prompts y settings de comportamiento.
8. Inbox de conversaciones con takeover humano.
9. Estado/conexion WhatsApp.
10. Webhooks, colas, dead letters y auditoria.

## Observaciones tecnicas importantes

- El README actual sigue siendo el starter de NestJS; conviene reemplazarlo con documentacion real del proyecto.
- Hay capacidades internas sin controller visible, especialmente conversaciones y webhooks.
- La UI deberia usar Swagger como referencia inicial, pero no depender solo de Swagger porque varias funciones internas importantes aun no estan expuestas.
- Hay pequenos typos en nombres/campos que podrian impactar DX o API, por ejemplo `variadblesSchema`, `imageVerfied`, `sheduledAt` y algunos textos de validacion.
- La UI debe tratar secretos con cuidado: API keys de modelos, headers del cliente, secretos de webhooks y credenciales de canales no deben mostrarse en claro despues de guardarse.
- Para una experiencia completa de operacion, conviene agregar permisos/roles de usuario; hoy la API parece protegerse solo con una API key global.
