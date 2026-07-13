# Especificaciones Técnicas - Proyecto Conduit Messaging Service

**Versión:** 1.0  
**Última actualización:** 3 de julio de 2026  
**Estado:** Producción

---

## Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Stack Tecnológico](#stack-tecnológico)
4. [Módulos Principales](#módulos-principales)
5. [Modelo de Datos](#modelo-de-datos)
6. [Flujos de Procesamiento](#flujos-de-procesamiento)
7. [Sistema de Eventos](#sistema-de-eventos)
8. [Escalabilidad](#escalabilidad)
9. [Seguridad](#seguridad)
10. [Deployment](#deployment)

---

## Visión General

**Conduit Messaging Service** es un servicio backend basado en NestJS que proporciona una plataforma integral de gestión de mensajería multi-canal con capacidades de IA integradas. El sistema está diseñado para:

- **Procesar mensajes** a través de múltiples canales (WhatsApp, Email/SMTP, Resend)
- **Orquestar conversaciones** con bots impulsados por IA
- **Gestionar plantillas** de mensajes con variables dinámicas
- **Integrar proveedores de IA** variados (OpenAI, Anthropic, Gemini, Groq, etc.)
- **Escalar horizontalmente** mediante colas asincrónicas y procesamiento distribuido
- **Manejar webhooks** para notificaciones y eventos externos
- **Inyectar variables externas** desde fuentes de datos dinámicas

---

## Arquitectura del Sistema

### Diagrama de Capas

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway / HTTP                        │
├─────────────────────────────────────────────────────────────┤
│                  Controllers Layer (HTTP/REST)               │
│  (MessageController, TemplateController, BotConfigController) │
├─────────────────────────────────────────────────────────────┤
│                  Service Layer (Business Logic)              │
│  (MessageOrchestrator, ConversationService, AiOrchestrator)  │
├─────────────────────────────────────────────────────────────┤
│              Repository / Data Access Layer                  │
│  (PrismaService, VariableStore, MappingRepository)           │
├─────────────────────────────────────────────────────────────┤
│              Infrastructure Layer                            │
│  (Events, Queues, Webhooks, Channels)                        │
├─────────────────────────────────────────────────────────────┤
│              Data Layer                                      │
│  (PostgreSQL, Redis, External APIs)                          │
└─────────────────────────────────────────────────────────────┘
```

### Componentes Principales

```
CONDUIT MESSAGING SERVICE
│
├─── API Layer
│    ├── Message Controller (REST endpoints para mensajes)
│    ├── Template Controller (CRUD de plantillas)
│    ├── Bot Config Controller (Configuración de bots)
│    ├── Prompt Controller (Gestión de prompts)
│    └── Health Controller (Checks de salud)
│
├─── Core Orchestration
│    ├── MessageOrchestrator (Coordinación central de mensajes)
│    ├── BotRouter (Enrutamiento de mensajes a bots)
│    └── ChannelRouter (Enrutamiento a canales de envío)
│
├─── Modules
│    ├── Bot Module
│    │   ├── ConversationService
│    │   ├── AiOrchestrator
│    │   ├── ImageAnalysisService
│    │   ├── PromptEngine
│    │   └── BotConfigService
│    │
│    ├── Channels Module
│    │   ├── WhatsApp (Baileys, WaLink, GreenApi)
│    │   ├── Email (Resend, SMTP/Brevo)
│    │   └── ChannelRouter (Abstracción)
│    │
│    ├── Queue Module
│    │   ├── Message Processors
│    │   ├── DLQ Handler (Dead Letter Queue)
│    │   └── Job Management
│    │
│    ├── Templates Module
│    │   ├── TemplateService
│    │   ├── TemplateEngine
│    │   └── Tag Management
│    │
│    ├── External Data Module
│    │   ├── ExternalDataService
│    │   ├── VariableStore
│    │   ├── VariableMapper
│    │   └── MappingRepository
│    │
│    ├── Webhooks Module
│    │   ├── WebhookService
│    │   ├── WebhookDispatcher
│    │   └── Event Delivery
│    │
│    └── Prompt Module
│        ├── PromptEngine
│        ├── ContextBuilder
│        ├── VariableResolver
│        └── PromptRenderer
│
├─── Infrastructure
│    ├── Event Bus (Event Emitter)
│    ├── Database (Prisma + PostgreSQL)
│    ├── Cache (Redis)
│    └── Logging
│
└─── Security
     ├── Auth Middleware
     ├── Job Signing
     └── Rate Limiting (Throttler)
```

---

## Stack Tecnológico

### Backend Framework

- **NestJS 11.0.1** - Framework progresivo basado en TypeScript
- **TypeScript 5.7.3** - Lenguaje de programación

### Base de Datos & ORM

- **PostgreSQL** - Base de datos relacional
- **Prisma 5.22.0** - ORM moderno con migraciones automáticas
- **Prisma Postgres Adapter** - Optimizaciones específicas para PostgreSQL

### Cache & Colas

- **Redis** - Cache y broker de mensajes
- **BullMQ 5.77.1** - Sistema de colas para procesamiento asincrónico
- **IORedis 5.11.0** - Cliente de Redis

### Canales de Mensajería

- **@whiskeysockets/baileys 7.0.0-rc12** - WhatsApp Web (sin oficial)
- **Resend 6.12.3** - API de email moderno
- **Nodemailer 8.0.7** - SMTP tradicional

### Proveedores de IA

- **@anthropic-ai/sdk 0.104.1** - Claude (Anthropic)
- **openai 6.42.0** - GPT (OpenAI)
- **@google/generative-ai 0.24.1** - Gemini (Google)
- **@groq/sdk** - Groq LLM

### Utilidades

- **Handlebars 4.7.9** - Renderizado de plantillas
- **Sharp 0.35.2** - Procesamiento de imágenes
- **PapaParse 5.5.3** - Parseo CSV
- **XLSX 0.18.5** - Procesamiento Excel
- **Axios 1.16.1** - Cliente HTTP
- **Joi 18.2.1** - Validación de esquemas
- **Class Validator** - Validación de DTOs
- **QR Code Terminal** - Generación QR para sesiones

### Desarrollo & Testing

- **Jest** - Framework de testing
- **ESLint** - Linting
- **Prettier** - Formateador de código
- **ts-jest** - Soporte TypeScript en Jest

---

## Módulos Principales

### 1. **Módulo Core - Orchestration**

Responsable de la orquestación central de mensajes.

#### Componentes Clave:

- **MessageOrchestrator**: Punto de entrada para envío de mensajes
  - Validación de payloads
  - Creación de registros en BD
  - Encolamiento en Redis
  - Gestión de jobs firmados

#### Flujo:

```
Input API → DataAdapterValidator → MessageOrchestrator
  ↓
  Crear registro Message
  ↓
  Firmar job (seguridad)
  ↓
  Encolar en BullMQ
  ↓
  Retornar messageId + status
```

---

### 2. **Módulo Bot - Conversaciones con IA**

Gestiona conversaciones de bots y procesamiento con IA.

#### Componentes Principales:

**ConversationService**

- Crear/obtener conversaciones
- Gestionar historial de mensajes
- Locks para evitar condiciones de carrera
- Actualización de contexto

**BotRouter**

- Enrutamiento de mensajes entrantes (WhatsApp)
- Detección de imágenes
- Validación de bots activos
- Delegación a AI Orchestrator

**AiOrchestrator**

- Selector de modelo más apropiado
- Factory de proveedores de IA
- Ejecución con fallback automático
- Manejo de límites de tokens

**ImageAnalysisService**

- Análisis de imágenes con IA
- Optimización de imágenes
- Extracción de texto (OCR)

**PromptEngine**

- Compilación de prompts dinámicos
- Integración de contexto
- Inyección de variables externas
- Renderizado de templates

#### Flujo de Conversación:

```
Mensaje WhatsApp → BotRouter
  ↓
ConversationService.getOrCreate()
  ↓
AcquireLock (30s timeout)
  ↓
ImageAnalysisService (si tiene imagen)
  ↓
PromptEngine.buildConversationPrompt()
  ↓
AiOrchestrator.generateResponse()
  ├─ Selector: elige modelo por rol/tier
  ├─ Factory: obtiene provider
  └─ Execute: llama a IA con fallback
  ↓
GuardarResponse + Eventos
  ↓
ChannelRouter → Enviar por WhatsApp
```

---

### 3. **Módulo Channels - Canales de Envío**

Abstracsión para múltiples canales de comunicación.

#### Canales Soportados:

**WhatsApp**

- **Baileys**: Librería open-source, requiere autenticación
- **WaLink**: API alternativa
- **GreenApi**: API comercial

- Componentes:
  - `BaileysSessionManager`: Manejo de sesiones
  - `BaileysAuthState`: Persistencia de autenticación
  - `MessageReceiptTracker`: Confirmación de entrega
  - `BaileysRateLimiter`: Control de velocidad

**Email**

- **Resend**: Para dominios Gmail/Google Workspace
- **SMTP/Brevo**: Para servidores SMTP tradicionales

#### ChannelRouter

```typescript
ChannelRouter.resolve(channel, recipient) → IChannelPlugin
  ↓
  return plugin.send(message)
```

#### Plugin Interface (IChannelPlugin)

```typescript
interface IChannelPlugin {
  send(message: any): Promise<SendResult>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  getStatus?(): Promise<string>;
}
```

---

### 4. **Módulo Templates - Plantillas de Mensajes**

Sistema flexible de plantillas con variables dinámicas.

#### Características:

- **Handlebars**: Soporte para lógica condicional en plantillas
- **Variables Dinámicas**: Placeholder con sintaxis `{{variable}}`
- **Validación de Schema**: JSON Schema para variables
- **Tags**: Clasificación de plantillas
- **Preview**: Renderizado de preview antes de envío
- **Historial**: Versionado de plantillas

#### Estructura Template:

```typescript
Template {
  id: string
  name: string
  channel: MessageChannel (WHATSAPP|EMAIL|SMTP)
  subject?: string (para email)
  bodyHandlebars: string (con {{variables}})
  variablesSchema: JSON (validación)
  tags: Tag[]
  isActive: boolean
}
```

#### Ejemplo Template:

```handlebars
Hola {{customer.name}},

Tu pedido #{{order.id}} ha sido {{order.status}}.

{{#if order.status === 'completed'}}
  Puedes descargarlo en: {{download.url}}
{{/if}}

Gracias por tu compra
```

---

### 5. **Módulo External Data - Variables Dinámicas**

Sistema para inyectar variables desde fuentes externas.

#### Componentes:

**VariableStore**

- Almacenamiento de variables por bot y namespace
- Soporte para TTL (expiración automática)
- Múltiples fuentes (WEBHOOK, POLLING, MANUAL)

**VariableMapper**

- Mapeo de payloads de webhook a variables
- Reglas de transformación JSON
- Validación de tipos

**MappingRepository**

- Persistencia de reglas de mapeo
- CRUD para webhook mappings
- Query por botConfigId y eventType

**ExternalDataService**

- Recepción de webhooks
- Aplicación de reglas de mapeo
- Publicación de eventos
- Inyección directa de variables

#### Flujo de Webhook:

```
POST /webhooks/external-data
  ↓
ExternalDataService.receiveWebhook()
  ↓
MappingRepository.find(botConfigId, eventType)
  ↓
VariableMapper.map(rules, payload)
  ↓
VariableStore.save(botConfigId, variables, source, ttl)
  ↓
EventBus.publish('external_data.variables_updated')
  ↓
Respuesta: { received: true, eventId, mapped }
```

#### Almacenamiento de Variables:

```typescript
ExternalVariable {
  id: string
  botConfigId: string
  namespace: string (default: "vars")
  key: string
  value: string
  source: SourceVariable (WEBHOOK|POLLING|MANUAL)
  expiresAt?: DateTime

  // Acceso: bot.vars.key o bot.namespace.key
}
```

---

### 6. **Módulo Queue - Procesamiento Asincrónico**

Sistema de colas distribuidas para procesamiento de mensajes.

#### Colas Configuradas:

```typescript
QUEUE_NAMES = {
  MESSAGES: 'conduit-messages', // Procesamiento inmediato
  MESSAGES_SCHEDULED: 'conduit-messages-scheduled', // Diferido
  DEAD_LETTER: 'conduit-dead-letter', // Mensajes fallidos
};
```

#### Configuración de Jobs:

```typescript
JobOptions {
  attempts: 3-5 (configurable)
  backoff: exponential (120s inicial)
  removeOnComplete: { count: 1000 }
  removeOnFail: false (preserva para auditoría)
}
```

#### DLQ Handler (Dead Letter Queue)

Cuando un job falla después de todos los reintentos:

1. Mover a tabla `DeadLetterMessage`
2. Actualizar estado a `DEAD`
3. Encolar en DLQ para revisión
4. Permitir requeue manual

#### Flujo de Procesamiento:

```
Job en Queue
  ↓
Worker procesa
  ├─ Success → Marcar SENT, remover job
  ├─ Error Transient → Reintentar (backoff exponencial)
  └─ Error Permanente → Max attempts alcanzados
      ↓
      DLQHandler.handle()
      ↓
      DeadLetterMessage + Auditoría
```

---

### 7. **Módulo Webhooks - Notificaciones Externas**

Sistema para enviar webhooks a endpoints externos.

#### Características:

- **Firmas HMAC**: Validación de origen
- **Retry Logic**: Reintentos automáticos
- **Event Filtering**: Suscripción a eventos específicos
- **Delivery Tracking**: Historial de entregas

#### Eventos Publicables:

- `message.received`
- `message.generated`
- `bot.response.requested`
- `bot.response.generated`
- `conversation.created`
- `channel.send.completed`
- `channel.send.failed`
- `external_data.variables_updated`
- Y más...

#### WebhookEndpoint Schema:

```typescript
WebhookEndpoint {
  id: string
  tenantId: string
  url: string
  secret: string (para firma HMAC)
  events: string[] (eventos subscritos)
  isActive: boolean
}
```

---

### 8. **Módulo Prompt - Engine de Prompts**

Motor avanzado para construcción dinámica de prompts.

#### Componentes:

**PromptEngine**

- Compilación de prompts conversacionales
- Prompts para análisis de imágenes
- Prompts para resumen de conversaciones

**ContextBuilder**

- Construcción de contexto de conversación
- Narrativa del historial de mensajes
- Integración de datos externos

**VariableResolver**

- Resolución de variables desde settings
- Inyección de datos de empresa
- Personalización por bot

**PromptRenderer**

- Renderizado con Handlebars
- Validación de sintaxis
- Integración de templates guardados

#### Flujo de Construcción:

```
Input: userMessage, history, context, summary
  ↓
Paralelo:
  ├─ Cargar BotAiSettings
  ├─ Cargar Template activo
  ├─ Ensamblar Knowledge Base
  └─ Resolver variables externas
  ↓
PromptRenderer: Renderizar template base
  ↓
ContextBuilder: Agregar contexto conversacional
  ↓
Inyectar Knowledge Base (si existe)
  ↓
Inyectar variables externas (si existen)
  ↓
Inyectar historial narrativo
  ↓
Output: BuiltPrompt {
  systemPrompt: string
  maxTokens: number
  temperature: float
}
```

#### Tipos de Prompts:

1. **CONVERSATION**: Respuesta a usuario en conversación
2. **IMAGE_ANALYSIS**: Análisis de imágenes adjuntas
3. **SUMMARY**: Resumen de conversación
4. **SALES/SUPPORT/APPOINTMENT**: Especializados por caso de uso

---

## Modelo de Datos

### Diagrama ER (Relaciones Principales)

```
┌─────────────┐         ┌──────────────┐
│   Tenant    │────────►│   BotConfig  │
└─────────────┘         └──────────────┘
      │                        │
      │                        ├──► BotAiSettings
      │                        ├──► AiModelConfig
      │                        ├──► BotPromptTemplate
      │                        ├──► ExternalVariable
      │                        ├──► Conversation
      │                        └──► WebhookMapping
      │
      ├──► Template ◄──────────┐
      │       │                │
      │       ├──► Message     │
      │       │      │         │
      │       │      ├──► MessageAttempt
      │       │      └──► WebhookDelivery
      │       │
      │       └──► TemplateTag ──► Tag
      │
      ├──► WebhookEndpoint
      │       └──► WebhookDelivery
      │
      └──► ExternalDataEvent

      Conversation
            │
            └──► BotMessage
```

### Entidades Principales

#### 1. **Tenant**

```typescript
Tenant {
  id: string @id @default(uuid())
  name: string
  slug: string @unique
  isActive: boolean @default(true)
  createdAt: DateTime @default(now())

  // Relations
  templates: Template[]
  messages: Message[]
  webhookEndpoints: WebhookEndpoint[]
  tags: Tag[]
  botConfigs: BotConfig[]
}
```

#### 2. **BotConfig**

```typescript
BotConfig {
  id: string @id
  tenantId: string
  name: string
  status: BotStatus (ACTIVE|INACTIVE|PAUSED)

  systemPrompt: string @db.Text
  imageAnalysisEnabled: boolean @default(false)

  // API Configuration
  clientApiBaseUrl: string?
  clientApiHeaders: Json
  intentEndpoints: Json

  // Timeouts & Limits
  maxHistoryMessages: int @default(6)
  maxMessageAgeMinutes: int @default(1440)
  humanTakeoverMinutes: int @default(10)
  botResponseDelaySeconds: int @default(8)
  conversationTimeoutMinutes: int @default(60)

  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  conversations: Conversation[]
  externalVariables: ExternalVariable[]
  webhookMappings: WebhookMapping[]
  aiModels: AiModelConfig[]
  aiSettings: BotAiSettings?
  promptTemplates: BotPromptTemplate[]
  whatsappSession: WhatsAppSession?
}
```

#### 3. **Message**

```typescript
Message {
  id: string @id
  tenantId: string @default("default")
  templateId: string?
  channel: MessageChannel (WHATSAPP|EMAIL|SMTP)
  recipient: string
  variables: Json @default("{}")

  renderedSubject: string
  renderedBody: string?

  status: MessageStatus (PENDING|QUEUED|PROCESSING|SENT|FAILED|RETRYING|DEAD|CANCELLED)
  retryable: boolean @default(true)
  attempts: int @default(0)
  maxAttempts: int @default(5)
  lastError: string?

  provider: string?
  providerMessageId: string?

  nextRetryAt: DateTime?
  scheduledAt: DateTime @default(now())
  resolvedAt: DateTime?
  sentAt: DateTime?
  meta: Json?

  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  attemptLogs: MessageAttempt[]
  webhookDeliveries: WebhookDelivery[]
  deadLetter: DeadLetterMessage?
}
```

#### 4. **Conversation**

```typescript
Conversation {
  id: string @id
  tenantId: string
  botConfigId: string
  phoneNumber: string
  status: ConversationStatus (ACTIVE|WAITING_PAYMENT|COMPLETED|ABANDONED)

  context: Json @default("{}")        // Estado contextual
  summary: string? @db.Text           // Resumen generado

  lastMessageAt: DateTime @default(now())
  lastIntent: string?
  currentStep: string?
  processing: boolean @default(false)

  lockedUntil: DateTime?              // Para evitar condiciones de carrera
  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  botConfig: BotConfig
  messages: BotMessage[]
}
```

#### 5. **BotMessage**

```typescript
BotMessage {
  id: string @id
  conversationId: string
  direction: string (INBOUND|OUTBOUND)
  content: string @db.Text
  hasImage: boolean @default(false)
  imageVerified: boolean?
  processedBy: string @default("bot")  // "bot" o "human"
  intent: string?
  tokenUsed: int?
  createdAt: DateTime @default(now())

  // Relations
  conversation: Conversation
}
```

#### 6. **AiModelConfig**

```typescript
AiModelConfig {
  id: string @id
  botConfigId: string

  provider: AiProvider (ANTHROPIC|OPENAI|GEMINI|OPENROUTER|DEEPSEEK|GROQ|MISTRAL|CUSTOM)
  model: string
  apiKey: string
  baseUrl: string?

  role: AiModelRole (CONVERSATION|IMAGE_ANALYSIS|FALLBACK)
  tier: AiModelTier (FREE|PAID)
  priority: int                        // Para selector

  isActive: boolean @default(true)
  dailyTokenLimit: int?
  minuteRequestLimit: int?

  tokensUsedToday: int @default(0)
  requestsThisMinute: int @default(0)
  lastResetAt: DateTime @default(now())
  lastMinuteResetAt: DateTime @default(now())

  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  botConfig: BotConfig

  // Índices
  @@index([botConfigId, role, priority])
  @@index([botConfigId, isActive])
}
```

#### 7. **ExternalVariable**

```typescript
ExternalVariable {
  id: string @id
  botConfigId: string
  namespace: string @default("vars")   // Para agrupar variables
  key: string
  value: string @db.Text
  source: SourceVariable (MANUAL|WEBHOOK|POLLING)
  expiresAt: DateTime?                 // TTL
  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  botConfig: BotConfig

  // Índices
  @@unique([botConfigId, namespace, key])
  @@index([botConfigId, namespace])
  @@index([expiresAt])
}
```

#### 8. **WebhookMapping**

```typescript
WebhookMapping {
  id: string @id
  botConfigId: string
  eventType: string                    // Ej: "payment.completed"

  rules: Json                          // Reglas de mapeo

  isActive: boolean @default(true)
  description: string?
  createdAt: DateTime @default(now())
  updatedAt: DateTime @updatedAt

  // Relations
  botConfig: BotConfig

  // Índices
  @@unique([botConfigId, eventType])
}
```

#### 9. **DeadLetterMessage**

```typescript
DeadLetterMessage {
  id: string @id
  messageId: string @unique
  reason: string
  lastErrorCode: string?
  lastErrorDetail: string?
  totalAttempts: int
  reviewedBy: string?                  // Usuario que revisó
  reviewedAt: DateTime?
  requeued: boolean @default(false)
  createdAt: DateTime @default(now())

  // Relations
  message: Message
}
```

---

## Flujos de Procesamiento

### 1. Flujo de Envío de Mensaje (Dispatch)

```mermaid
sequenceDiagram
    Client->>API: POST /messages/dispatch
    API->>MessageOrchestrator: dispatch(payload)

    MessageOrchestrator->>DataAdapterValidator: validate(payload)
    DataAdapterValidator-->>MessageOrchestrator: ✓ payload

    MessageOrchestrator->>TemplateService: validateTemplate(id)
    MessageOrchestrator->>PrismaService: create(Message)
    PrismaService-->>MessageOrchestrator: message{id, status:PENDING}

    MessageOrchestrator->>JobSigner: sign(jobPayload)
    JobSigner-->>MessageOrchestrator: signedPayload

    alt Scheduled
        MessageOrchestrator->>ScheduledQueue: add(job, { delay })
    else Immediate
        MessageOrchestrator->>MessageQueue: add(job)
    end

    MessageOrchestrator->>PrismaService: update(status: QUEUED)
    MessageOrchestrator-->>API: {messageId, status}
    API-->>Client: 200 OK
```

### 2. Flujo de Procesamiento de Mensaje (Worker)

```
Worker recibe job de BullMQ
  ↓
JobSigner.verify(signedPayload) → valida integridad
  ↓
ChannelRouter.resolve(channel)
  ↓
switch(channel):

  case WHATSAPP:
    ├─ BaileysPlugin.send(recipient, body, media)
    ├─ MessageReceiptTracker.track(messageId)
    └─ Retry logic si falla

  case EMAIL:
    ├─ EmailPlugin.send(recipient, subject, body, attachments)
    └─ Retry logic si falla

  case SMTP:
    ├─ SmtpPlugin.send(recipient, subject, body)
    └─ Retry logic si falla
  ↓
Success:
  ├─ Update Message.status = SENT
  ├─ Update Message.sentAt = now()
  ├─ Update Message.providerMessageId (si aplica)
  ├─ Publish event 'channel.send.completed'
  └─ Remove job from queue

Failure (Transient):
  ├─ Update Message.status = RETRYING
  ├─ Update Message.attempts++
  ├─ Update Message.nextRetryAt
  └─ Job requeue with exponential backoff

Failure (Permanent/Max Attempts):
  ├─ Update Message.status = DEAD
  ├─ Publish event 'channel.send.failed'
  ├─ DLQHandler.handle(messageId, reason)
  └─ Create DeadLetterMessage record
```

### 3. Flujo de Recepción de Mensaje WhatsApp

```
WhatsApp Webhook (Baileys)
  ↓
BaileysPlugin.onMessage()
  ↓
BotRouter.route(messages[])
  ├─ Validar: no es mensaje del bot (key.fromMe)
  ├─ Validar: no es grupo (jid.endsWith('@g.us'))
  └─ Validar: tiene messageId
  ↓
BotRouter.handleMessage()
  ↓
ConversationService.getOrCreate()
  ├─ Buscar conversación activa
  └─ Crear si no existe
  ↓
MessageDebouncer: evitar procesamiento duplicado
  ↓
AcquireLock(conversationId, 30s timeout)
  │
  ├─ ImageAnalysisService (si tiene imagen)
  │  ├─ Descargar imagen
  │  ├─ Optimizar (Sharp)
  │  └─ Analizar con IA
  │
  ├─ PromptEngine.buildConversationPrompt()
  │  ├─ Cargar BotAiSettings
  │  ├─ Cargar Template activo
  │  ├─ Ensamblar Knowledge Base
  │  ├─ Resolver variables externas
  │  ├─ Inyectar contexto
  │  └─ Inyectar historial
  │
  ├─ AiOrchestrator.generateResponse()
  │  ├─ Selector: elegir modelo (CONVERSATION role)
  │  ├─ Factory: obtener provider
  │  ├─ Execute: llamar API de IA
  │  │  └─ Si falla → Fallback a siguiente modelo
  │  └─ Return: { text, tokensUsed, model }
  │
  ├─ ConversationService.saveOutbound(response)
  │  ├─ Crear BotMessage (OUTBOUND, processedBy: bot)
  │  └─ Update Conversation.lastMessageAt
  │
  ├─ EventBus.publish('bot.response.generated')
  │
  ├─ ReleaseLock()
  │
  └─ ChannelRouter.send(WhatsApp, recipient, response)
     ├─ MessageOrchestrator.dispatch()
     └─ Encolar mensaje
```

### 4. Flujo de Conversación Completa

```
┌─────────────────────────────────────────────────────────────┐
│ 1. MENSAJE ENTRA (Usuario → Bot)                            │
├─────────────────────────────────────────────────────────────┤

Usuario envía: "Hola, quiero saber sobre producto X"
         ↓
WhatsApp Webhook (Baileys)
         ↓
BotRouter (autenticación, validación)
         ↓
ConversationService (obtener/crear)
         ↓
Lock adquirido


├─────────────────────────────────────────────────────────────┤
│ 2. CONSTRUCCIÓN DE CONTEXTO                                 │
├─────────────────────────────────────────────────────────────┤

PromptEngine recibe:
  - userMessage: "Hola, quiero saber sobre producto X"
  - history: [últimos 6 mensajes]
  - context: { currentStep: "info_request", ... }
  - summary: "Resumen de conversación anterior"

Paralelo:
  ├─ BotAiSettings.loadByBot(botId)
  │  └─ Tono, personalidad, idioma, etc.
  │
  ├─ PromptTemplate.loadActive(botId, CONVERSATION)
  │  └─ Template genérico para conversaciones
  │
  ├─ KnowledgeAssembler.assemble(botId)
  │  └─ Información del producto X desde BD/API
  │
  └─ ExternalDataResolver.resolve(botId)
     └─ Variables dinámicas: { campaign: "summer2026", discount: "20%" }


├─────────────────────────────────────────────────────────────┤
│ 3. COMPILACIÓN DEL PROMPT FINAL                             │
├─────────────────────────────────────────────────────────────┤

systemPrompt = """
Eres {personality} de {company}
Hablas {language} con tono {tone}
Tu objetivo: {goals}

INFORMACIÓN DEL PRODUCTO:
{conocimiento_ensamblado}

CONTEXTO DE LA CONVERSACIÓN:
- Cliente lleva 3 mensajes
- Último intent: "product_inquiry"
- Estado actual: "awaiting_response"

VARIABLES DISPONIBLES:
- campaign: summer2026
- discount: 20%

HISTORIAL:
Usuario (hace 2m): "¿Qué capacidades tiene el producto?"
Bot: "El producto tiene X, Y, Z capacidades..."
Usuario: "¿Cuál es el precio?"

NUEVA CONSULTA:
{user_message}

Responde concisamente (máx 150 palabras), en tono amable.
"""


├─────────────────────────────────────────────────────────────┤
│ 4. LLAMADA A IA                                             │
├─────────────────────────────────────────────────────────────┤

AiOrchestrator.generateResponse()

1. Selector: elegir modelo
   - Role: CONVERSATION
   - Prioridades: PAID(tier) > FREE, activos > inactivos
   - Resultados: OpenAI GPT-4 (priority: 1)

2. Factory: obtener provider
   - Provider: OpenAI
   - Model: "gpt-4-turbo"
   - ApiKey: ${OPENAI_API_KEY}

3. Ejecutar
   OpenAI.generateText({
     systemPrompt: [...el compilado],
     userMessage: "Hola, quiero saber sobre producto X",
     maxTokens: 400,
     temperature: 0.7
   })

   Respuesta: "El producto X es ideal para... Con nuestra campaña
              summer2026, tienes un 20% de descuento..."

4. Fallback (si falla)
   - Si timeout/error → Anthropic Claude-3 (priority: 2)
   - Si falla → Groq (priority: 3)
   - Si todas fallan → Error response


├─────────────────────────────────────────────────────────────┤
│ 5. GUARDADO Y ENVÍO                                         │
├─────────────────────────────────────────────────────────────┤

ConversationService.saveOutbound()
  ├─ Crear BotMessage(OUTBOUND)
  ├─ Update Conversation.lastMessageAt
  └─ Extract intent: "product_inquiry"

EventBus.publish('bot.response.generated')
  └─ Trigger webhooks suscritos

ChannelRouter.send()
  └─ MessageOrchestrator.dispatch()
     ├─ Crear Message record
     ├─ Encolar en MessageQueue
     └─ Worker envía por WhatsApp

Lock liberado


├─────────────────────────────────────────────────────────────┤
│ 6. CONFIRMACIÓN                                             │
├─────────────────────────────────────────────────────────────┤

MessageReceiptTracker: esperar confirmación de WhatsApp
  └─ message.status = SENT

Webhook delivery: notificar al cliente (si subscrito)
  └─ POST client_webhook: { event: "channel.send.completed", ... }

fin.
```

---

## Sistema de Eventos

### Event Bus Architecture

El sistema usa **NestJS Event Emitter** para comunicación inter-módulos desacoplada.

#### Configuración:

```typescript
EventEmitterModule.forRoot({
  wildcard: false,
  delimiter: '.',
  maxListeners: 20,
});
```

#### Tipos de Eventos

```typescript
export const EVENT_TYPES = {
  // Mensajes
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_GENERATED: 'message.generated',

  // Bot
  BOT_RESPONSE_REQUESTED: 'bot.response.requested',
  BOT_RESPONSE_GENERATED: 'bot.response.generated',
  BOT_RESPONSE_FAILED: 'bot.response.failed',

  // Conversaciones
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_LOCK_ACQUIRED: 'conversation.lock.acquired',
  CONVERSATION_LOCK_FAILED: 'conversation.lock.failed',
  CONVERSATION_CLOSED: 'conversation.closed',
  CONTEXT_UPDATED: 'context.updated',

  // Canales
  CHANNEL_SEND_REQUESTED: 'channel.send.requested',
  CHANNEL_SEND_COMPLETED: 'channel.send.completed',
  CHANNEL_SEND_FAILED: 'channel.send.failed',

  // WhatsApp
  WHATSAPP_CONNECTED: 'whatsapp.connected',
  WHATSAPP_DISCONNECTED: 'whatsapp.disconnected',

  // Datos externos
  EXTERNAL_DATA_VARIABLES_UPDATED: 'external_data.variables_updated',
} as const;
```

#### Ejemplos de Payloads

```typescript
// message.received
{
  messageId: string
  conversationId: string
  content: string
  hasImage: boolean
}

// bot.response.generated
{
  conversationId: string
  response: string
  intent?: string
  model?: string
  tokensUsed?: number
}

// conversation.created
{
  conversationId: string
  botConfigId: string
  tenantId: string
  phoneNumber: string
}

// external_data.variables_updated
{
  botConfigId: string
  keys: string | string[]
  source: SourceVariable
}
```

#### Suscripción a Eventos

```typescript
// En constructor
constructor(private eventBus: EventBusService) {
  this.eventBus.on(EVENT_TYPES.MESSAGE_RECEIVED,
    (payload) => this.handleMessageReceived(payload)
  );
}

// O con decorador
@OnEvent(EVENT_TYPES.CONVERSATION_CREATED)
handleConversationCreated(payload) {
  // Lógica...
}
```

---

## Escalabilidad

### Estrategias de Escalabilidad

#### 1. **Escalabilidad Horizontal - Colas Distribuidas**

```
┌─────────────────┐
│   Client API    │
└────────┬────────┘
         │
┌────────▼──────────────────────────────────┐
│    Message Orchestrator (Load Balanced)   │
└────────┬──────────────────────────────────┘
         │
┌────────▼───────────────────────────────────┐
│           Redis (Queue Broker)             │
│  ┌──────────────┐  ┌──────────────┐       │
│  │  conduit-ms  │  │   scheduled  │       │
│  │   messages   │  │    messages  │       │
│  │  [Job 1]     │  │   [Job 2]    │       │
│  │  [Job 3]     │  │   [Job 3]    │       │
│  └──────────────┘  └──────────────┘       │
└────────┬─────────────────────────────────┬─┘
         │                                 │
    ┌────▼────┐  ┌────────┐  ┌────────┐   │
    │ Worker 1 │  │Worker 2 │ │Worker 3│   │
    └────┬────┘  └────────┘  └────────┘   │
         │                                 │
    ┌────▼─────────────────────────────────┘
    │
    ├─► WhatsApp Plugin
    ├─► Email Plugin (Resend)
    ├─► SMTP Plugin
    └─► Channel Router
```

**Ventajas:**

- Múltiples workers procesando jobs en paralelo
- Auto-escalado según carga
- Persistencia en Redis
- Reintentos automáticos

#### 2. **Caché en Memoria**

```typescript
// BotConfig cache
LRU Cache {
  maxSize: 1000
  ttl: 5 minutes
}
botConfigService.getBotConfig(id) → cache hit/miss

// Template cache
LRU Cache {
  maxSize: 500
  ttl: 10 minutes
}
templateService.getTemplate(id) → cache

// Variables cache
Redis {
  ttl: variable (ExternalVariable.expiresAt)
}
variableStore.get(botId, namespace)
```

#### 3. **Database Indexing**

```typescript
// Índices críticos en Prisma:

// Message queries
Message @@index([tenantId, status])
Message @@index([scheduledAt, status])

// Conversation queries
Conversation @@unique([botConfigId, phoneNumber])
Conversation @@index([processing, lockedUntil])
Conversation @@index([botConfigId, status])

// ExternalVariable queries
ExternalVariable @@unique([botConfigId, namespace, key])
ExternalVariable @@index([botConfigId, namespace])
ExternalVariable @@index([expiresAt])  // Para cleanup

// AiModelConfig queries
AiModelConfig @@index([botConfigId, role, priority])
AiModelConfig @@index([botConfigId, isActive])
```

#### 4. **Batch Processing**

```
// MessageOrchestrator
async batchDispatch(messages: Message[])
  ├─ Paralelo: validar templates
  ├─ Paralelo: crear Message records (bulk)
  ├─ Paralelo: encolar jobs
  └─ Respuesta: { total, success, failed }
```

#### 5. **Rate Limiting**

```typescript
// Throttler configurado en app.module.ts
ThrottlerModule.forRoot([
  {
    name: 'short',
    ttl: 1000, // 1 segundo
    limit: 10, // 10 requests
  },
  {
    name: 'medium',
    ttl: 60000, // 1 minuto
    limit: 200, // 200 requests
  },
]);
```

#### 6. **Read Replicas (PostgreSQL)**

```
Primary DB (Write)
    ↓
Replica 1 (Read) ← BotConfig queries
Replica 2 (Read) ← Template queries
Replica 3 (Read) ← Report queries
```

#### 7. **CDN para Recursos Estáticos**

```
Cliente
  ↓
CDN (CloudFlare/AWS)
  ├─► Imágenes optimizadas
  ├─► Templates HTML
  └─► Assets estáticos
```

#### 8. **Monitoreo y Auto-scaling**

```
Métricas:
├─ Queue depth (BullMQ)
├─ Worker saturation
├─ Response times
├─ Error rates
├─ Database connections
└─ Redis memory

Auto-scale triggers:
├─ Queue depth > 1000 → spawn 2 workers
├─ Queue depth > 5000 → spawn 4 workers
├─ CPU > 80% → restart workers (graceful)
└─ Memory > 90% → cleanup cache
```

### Límites de Rendimiento

| Métrica                | Valor    | Notas                         |
| ---------------------- | -------- | ----------------------------- |
| Mensajes/segundo       | 500+     | Depende de workers y canales  |
| Conversaciones activas | 10,000+  | Con DB connection pooling     |
| Prompts concurrentes   | 200+     | Limitado por API limits de IA |
| Colas de jobs          | 100,000+ | Con Redis cluster             |
| Templos de plantillas  | 10,000+  | Con caché                     |

---

## Seguridad

### 1. **Autenticación & Autorización**

```typescript
// Auth Middleware
middleware: [
  JwtAuthGuard, // Valida JWT token
  TenantGuard, // Aísla por tenant
  RateLimitGuard, // Throttler
];
```

#### JWT Token Payload:

```typescript
{
  sub: string          // user ID
  tenantId: string
  role: 'admin' | 'user' | 'api'
  scope: string[]      // Permisos
  iat: number
  exp: number
}
```

### 2. **Webhook Signing (HMAC)**

```typescript
// Generación
secret = crypto.randomBytes(32).toString('hex')

// Firma de payload
signature = HMAC-SHA256(JSON.stringify(payload), secret)

// Header enviado
X-Webhook-Signature: sha256={signature}

// Validación en receptor
receivedSignature = hmac(payload, secret)
if (receivedSignature !== headerSignature) {
  throw UnauthorizedException
}
```

### 3. **Job Signing (Message Integrity)**

```typescript
// JobSigner
sign(jobPayload) → {
  payload: jobPayload,
  signature: HMAC-SHA256(JSON.stringify(jobPayload), SECRET_KEY),
  timestamp: Date.now()
}

// Verificación en worker
verify(signedPayload) → throws si inválido

// Protección contra:
- Job tampering
- Replay attacks (por timestamp)
- Man-in-the-middle
```

### 4. **Environment Variables Secretas**

```env
# .env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
WEBHOOK_SECRET_KEY=...

# Nunca en repo (usar .gitignore)
# Usar: hashicorp/vault, AWS Secrets Manager, Google Cloud Secret Manager
```

### 5. **SQL Injection Prevention**

```typescript
// Usando Prisma (parametrized queries automáticas)
prisma.message.findMany({
  where: { recipient: userInput }, // ✓ Safe
});

// Nunca usar:
prisma.$queryRaw`SELECT * FROM Message WHERE recipient = ${userInput}`; // ✗ Vulnerable
```

### 6. **CORS & CSRF**

```typescript
// app.module.ts
app.enableCors({
  origin: process.env.CORS_ORIGINS.split(','),
  credentials: true,
});

// CSRF token validation (si aplica)
```

### 7. **Rate Limiting Avanzado**

```typescript
// Por IP
ThrottlerGuard({ limit: 100/min per IP })

// Por tenant
ThrottlerGuard({ limit: 10000/min per tenant })

// Por endpoint específico
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 5, ttl: 60000 } })
async sendBulkMessages() { }
```

### 8. **Data Encryption**

```typescript
// En reposo
- PostgreSQL: pg_crypto extension
- Sensitive fields: AES-256 encryption

// En tránsito
- HTTPS/TLS 1.3
- WSS para WebSockets (si aplica)
```

### 9. **Audit Logging**

```typescript
// Eventos auditados
- CreateMessage
- UpdateBotConfig
- DeleteTemplate
- ExternalDataWebhook
- ApiKeyRotation

// Storage
- Tabla: AuditLog { action, actor, resource, changes, timestamp }
- Immutable (no permite UPDATE/DELETE)
- Retención: 1 año
```

### 10. **Input Validation**

```typescript
// DTO Validation
class CreateMessageDto {
  @IsString()
  @Length(1, 5000)
  content: string;

  @IsEnum(MessageChannel)
  channel: MessageChannel;

  @IsEmail()
  recipient: string;
}

// Automático con class-validator
@Body() payload: CreateMessageDto  // Valida automáticamente
```

---

## Deployment

### 1. **Arquitectura de Deployment**

```
┌────────────────────────────────────────────────────┐
│               Load Balancer (Nginx)                │
│          (health checks, SSL termination)          │
└────────────────────────────────────────────────────┘
             ↓              ↓              ↓
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ App Pod 1        │ │ App Pod 2        │ │ App Pod 3        │
│ (NestJS)         │ │ (NestJS)         │ │ (NestJS)         │
│ Port: 3000       │ │ Port: 3000       │ │ Port: 3000       │
└──────────────────┘ └──────────────────┘ └──────────────────┘
        ↓              ↓              ↓
┌────────────────────────────────────────────────────┐
│              PostgreSQL (Primary)                  │
│         (with streaming replication)               │
└────────────────────────────────────────────────────┘
             ↓
┌──────────────────┐ ┌──────────────────┐
│   PostgreSQL     │ │   PostgreSQL     │
│   Replica 1      │ │   Replica 2      │
└──────────────────┘ └──────────────────┘

┌────────────────────────────────────────────────────┐
│      Redis Cluster (Queue + Cache)                 │
│  Node 1 (master) | Node 2 (slave)                  │
│  Node 3 (master) | Node 4 (slave)                  │
│  Node 5 (master) | Node 6 (slave)                  │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│         Worker Pool (BullMQ Workers)               │
│  Worker 1  Worker 2  Worker 3  Worker N           │
│  (Stateless, auto-scalable)                        │
└────────────────────────────────────────────────────┘
```

### 2. **Docker Deployment**

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm ci --only=production

# Compilar
COPY . .
RUN npm run build

# Exposer puerto
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Iniciar
CMD ["node", "dist/main.js"]
```

### 3. **docker-compose para Desarrollo**

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - '3000:3000'
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/conduit
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: conduit
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### 4. **Kubernetes Deployment (Production)**

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: conduit-app
  namespace: production
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: conduit
  template:
    metadata:
      labels:
        app: conduit
    spec:
      containers:
        - name: app
          image: myregistry/conduit:latest
          ports:
            - containerPort: 3000
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: conduit-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                configMapKeyRef:
                  name: conduit-config
                  key: redis-url
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '1Gi'
              cpu: '500m'

---
apiVersion: v1
kind: Service
metadata:
  name: conduit-service
  namespace: production
spec:
  selector:
    app: conduit
  ports:
    - protocol: TCP
      port: 80
      targetPort: 3000
  type: LoadBalancer
```

### 5. **Procesos de Migración**

```bash
# Antes de deployment
pnpm run build

# Migraciones Prisma
npx prisma migrate deploy

# Seeders (si aplica)
npx prisma db seed

# Tests
pnpm run test
pnpm run test:integration

# Lint
pnpm run lint

# Deployment
docker build -t myregistry/conduit:v1.0.0 .
docker push myregistry/conduit:v1.0.0

# Rollback (si es necesario)
kubectl rollout undo deployment/conduit-app
```

### 6. **Monitoreo & Observabilidad**

```typescript
// Logging
import * as winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Métricas
import * as promClient from 'prom-client';

const messageCounter = new promClient.Counter({
  name: 'conduit_messages_total',
  help: 'Total messages processed',
  labelNames: ['channel', 'status'],
});

messageCounter.inc({ channel: 'whatsapp', status: 'sent' });

// Traces
import * as jaeger from 'jaeger-client';
```

### 7. **Health Checks**

```typescript
// GET /health
{
  status: 'ok',
  timestamp: '2026-07-03T10:15:30.000Z',
  uptime: 86400,
  database: 'connected',
  redis: 'connected',
  checks: {
    postgresql: { status: 'up', latency: 5 },
    redis: { status: 'up', latency: 2 },
    external_apis: { status: 'up', latency: 150 }
  }
}
```

---

## Anexos

### A. Dependencias Principales

| Paquete                 | Versión    | Propósito           |
| ----------------------- | ---------- | ------------------- |
| @nestjs/core            | 11.0.1     | Framework principal |
| @prisma/client          | 5.22.0     | ORM                 |
| bullmq                  | 5.77.1     | Colas               |
| ioredis                 | 5.11.0     | Redis client        |
| @anthropic-ai/sdk       | 0.104.1    | Anthropic API       |
| openai                  | 6.42.0     | OpenAI API          |
| @google/generative-ai   | 0.24.1     | Gemini API          |
| handlebars              | 4.7.9      | Template rendering  |
| sharp                   | 0.35.2     | Image processing    |
| @whiskeysockets/baileys | 7.0.0-rc12 | WhatsApp            |

### B. Variables de Entorno

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
DATABASE_POOL_SIZE=20

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# App
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# JWT
JWT_SECRET=...
JWT_EXPIRATION=24h

# Tenants
TENANT_DEFAULT_ID=default

# AI Providers
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...

# Canales
WHATSAPP_SESSION_ID=...
RESEND_API_KEY=...
SMTP_HOST=...
SMTP_PORT=...

# Security
WEBHOOK_SECRET_KEY=...
JOB_SIGNING_SECRET=...

# Cors
CORS_ORIGINS=http://localhost:3000,https://app.example.com
```

### C. Comandos Útiles

```bash
# Desarrollo
pnpm install
pnpm run start:dev

# Migraciones
npx prisma migrate dev --name "description"
npx prisma migrate deploy
npx prisma migrate status

# Testing
pnpm run test
pnpm run test:integration
pnpm run test:coverage

# Linting
pnpm run lint
pnpm run format

# Build
pnpm run build
pnpm run start:prod

# Documentación
npx @nestjs/cli swagger:generate
```

---

**Fin del documento**

Última actualización: 3 de julio de 2026
Autor: Esteban Castañeda
Estado: Actualizado
