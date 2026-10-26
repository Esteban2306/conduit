export type HandlerKind =
  | 'TEMPLATE'
  | 'TOOL_DIRECT'
  | 'HANDOFF'
  | 'LLM_SLIM'
  | 'LLM_FULL';

export type IntentId =
  | 'greeting'
  | 'courtesy'
  | 'cancel_booking'
  | 'cannot_attend'
  | 'business_hours'
  | 'business_location'
  | 'cancellation_policy'
  | 'deposit_info'
  | 'my_bookings'
  | 'deposit_status'
  | 'treatments_list'
  | 'human_request'
  | 'complaint';

export interface IntentDefinition {
  id: IntentId;
  handler: HandlerKind;
  /** Regex sobre el texto normalizado, anclados al mensaje completo cuando es posible. */
  patterns: string[];
  /** Si alguno coincide, el mensaje es otra cosa (pregunta de política, pasado, varias intenciones). */
  deny: string[];
  maxTokens: number;
  /** Una pregunta abierta del bot reciente hace que este mensaje sea la respuesta a ella. */
  respectsOpenFlow: boolean;
  /** Las preguntas con signo "?" siguen siendo esta intención. */
  allowsQuestion: boolean;
  /** La negación forma parte de la intención ("ya no puedo ir"). */
  negationOk: boolean;
  tool?: string;
  /** Si no hay teléfono verificado (LID), la intención se resuelve igual sin llamar al backend. */
  identityOptional?: boolean;
  handoffReason?: string;
  cooldownSeconds: number;
  /** Confianza fija para intenciones de palabra clave inequívoca (no penaliza mensajes largos). */
  fixedConfidence?: number;
  /** Textos por defecto; el negocio los sobrescribe en BotQuickReply. */
  variants: Record<string, string[]>;
}

const GREETING_WORDS =
  'hola|holi|hey|buenas|buenos dias|buen dia|buenas tardes|buenas noches|saludos|como estas|como esta|como estan|que tal|que mas|a todos|amiga|feliz dia|por favor';

const COURTESY_WORDS =
  'muchas gracias|mil gracias|tantas gracias|gracias|chao|chau|adios|hasta luego|hasta pronto|nos vemos|bye|igualmente|por todo|por la ayuda|por la informacion|que tengas un buen dia|que tengas buen dia|que tengas un lindo dia|buen dia|feliz dia|feliz tarde|feliz noche|bendiciones|amiga|hermosa|de nada|ok|vale|listo|perfecto|super|genial|por favor';

const vocabulary = (words: string, anchors: string) =>
  `^(?=.*\\b(?:${anchors})\\b)(?:(?:${words})(?: |$))+$`;

const GREETING_ANCHORS =
  'hola|holi|hey|buenas|buenos dias|buen dia|saludos|que mas|que tal|como estas|como esta|como estan';

const COURTESY_ANCHORS =
  'gracias|chao|chau|adios|hasta luego|hasta pronto|nos vemos|bye|bendiciones|de nada';

const UNIVERSAL_DENY_TOPICS =
  'cancel\\w*|anul\\w*|reagend\\w*|reprogram\\w*|agendar|reservar|cambiar|mover|aplaz\\w*';

export const DEFAULT_INTENTS: IntentDefinition[] = [
  {
    id: 'greeting',
    handler: 'TOOL_DIRECT',
    tool: 'consultar_cliente',
    identityOptional: true,
    patterns: [vocabulary(GREETING_WORDS, GREETING_ANCHORS)],
    deny: [],
    maxTokens: 6,
    respectsOpenFlow: true,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 60,
    variants: {
      registered: [
        '¡Hola {{nombre}}! 😊 Soy {{agente}} de {{negocio}}. ¿En qué te puedo ayudar hoy?',
        '¡Hola {{nombre}}! 🌿 Soy {{agente}} de {{negocio}}. Cuéntame, ¿qué necesitas?',
        '¡Qué gusto saludarte, {{nombre}}! Soy {{agente}} de {{negocio}}. ¿En qué te ayudo?',
      ],
      default: [
        '¡Hola! 😊 Soy {{agente}} de {{negocio}}. ¿En qué te puedo ayudar hoy?',
        '¡Hola! 🌿 Soy {{agente}} de {{negocio}}. Cuéntame, ¿qué necesitas?',
        '¡Qué gusto saludarte! Soy {{agente}} de {{negocio}}. ¿En qué te ayudo?',
      ],
    },
  },
  {
    id: 'courtesy',
    handler: 'TEMPLATE',
    patterns: [vocabulary(COURTESY_WORDS, COURTESY_ANCHORS)],
    deny: [],
    maxTokens: 8,
    respectsOpenFlow: true,
    allowsQuestion: false,
    negationOk: false,
    cooldownSeconds: 60,
    variants: {
      default: [
        '¡Con gusto! 🌿 Si necesitas algo más, aquí estoy.',
        '¡Para eso estoy! 😊 Cuando quieras, me escribes.',
        '¡Un gusto ayudarte! 🌿 Que tengas un lindo día.',
      ],
    },
  },
  {
    id: 'cancel_booking',
    handler: 'TOOL_DIRECT',
    tool: 'enlace_cancelacion',
    patterns: [
      '^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches) )?(?:quiero |necesito |quisiera |deseo )?(?:cancelar|anular) (?:mi |la |una |esa |mis )?(?:cita|citas|reserva|reservas|turno|sesion)(?: por favor)?(?: (?:de )?(?:hoy|manana|este \\w+|el \\w+))?$',
      '^(?:cancela|cancelame|anula|anulame) (?:mi |la |esa |mis )?(?:cita|citas|reserva|reservas|turno|sesion)(?: por favor)?$',
      '^(?:quiero|necesito|quisiera) cancelar(?: por favor)?$',
    ],
    deny: [
      '\\b(?:puedo|podria|se puede|es posible|politica|penalidad|multa|cobran|cobro|devuelven|devolucion|reembolso|anticipo|abono|deposito|cuanto|cuesta|como|ayer|cancele|cancelo|cancelaron|cancelaste|y|pero)\\b',
      `\\b(?:reagend\\w*|reprogram\\w*|agendar|cambiar|mover|aplaz\\w*|otra)\\b`,
    ],
    maxTokens: 14,
    respectsOpenFlow: false,
    allowsQuestion: false,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      link: [
        'Claro 🌿 Aquí tienes el enlace seguro para cancelar tu cita de *{{tratamiento}}* del {{fecha}}:\n\n{{enlace}}\n\nSi prefieres reagendar, dime la nueva fecha y te ayudo por aquí.',
        'Listo 🙌 Con este enlace puedes cancelar tu cita de *{{tratamiento}}* del {{fecha}}:\n\n{{enlace}}\n\nY si mejor quieres cambiarla de fecha, escríbeme el día y lo vemos.',
      ],
      linkMany: [
        'Claro 🌿 Aquí tienes el enlace para gestionar tus citas del {{fecha}} (empezando por *{{tratamiento}}*):\n\n{{enlace}}\n\nSi quieres cancelar otra de tus citas, dime cuál.',
      ],
      none: [
        'No encuentro citas próximas con este número 🤔 Si quieres agendar, dime qué tratamiento te interesa y la fecha que prefieres.',
      ],
    },
  },
  {
    id: 'cannot_attend',
    handler: 'TOOL_DIRECT',
    tool: 'enlace_cancelacion',
    patterns: [
      '^(?:ya )?no (?:voy a )?(?:puedo|podre|podria) (?:ir|asistir|llegar|ir hoy|asistir hoy)(?: (?:hoy|manana))?$',
      '^no voy a poder (?:ir|asistir|llegar)(?: (?:hoy|manana))?$',
      '^(?:me )?surgio algo(?: y)? no (?:voy a )?(?:puedo|podre) (?:ir|asistir|llegar)$',
    ],
    deny: ['\\b(?:y|pero|reagend\\w*|otra|cuando)\\b'],
    maxTokens: 14,
    respectsOpenFlow: false,
    allowsQuestion: false,
    negationOk: true,
    cooldownSeconds: 0,
    variants: {
      link: [
        'Gracias por avisarme 🌿 Tienes dos opciones para tu cita de *{{tratamiento}}* del {{fecha}}:\n\n1) Cancelarla con este enlace:\n{{enlace}}\n\n2) Reagendarla: dime la fecha que prefieres y la cambio por ti.',
      ],
      linkMany: [
        'Gracias por avisarme 🌿 Tienes dos opciones para tus citas del {{fecha}} (empezando por *{{tratamiento}}*):\n\n1) Cancelarlas con este enlace:\n{{enlace}}\n\n2) Reagendarlas: dime la fecha que prefieres.',
      ],
      none: [
        'Gracias por avisarme 🌿 No encuentro citas próximas con este número. Si necesitas agendar, dime el tratamiento y la fecha que prefieres.',
      ],
    },
  },
  {
    id: 'business_hours',
    handler: 'TOOL_DIRECT',
    tool: 'info_negocio',
    patterns: [
      '^(?:cual es |cuales son |me dices |me das |me regalas )?(?:el |los )?(?:horario|horarios)(?: de atencion| de servicio| de apertura)?(?: por favor)?$',
      '^(?:a que hora|hasta que hora|desde que hora) (?:abren|cierran|atienden|abre|cierra|atiende)(?: hoy| manana| (?:los |el )?(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|festivos?))?(?: por favor)?$',
      '^(?:abren|atienden|trabajan) (?:los |el )?(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|festivos?)(?: por favor)?$',
      '^que horarios? (?:manejan|tienen|atienden)$',
    ],
    deny: [
      `\\b(?:${UNIVERSAL_DENY_TOPICS}|y|pero|disponibilidad|cupo|espacio|libre)\\b`,
    ],
    maxTokens: 10,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: [
        'Nuestro horario de atención 🕘\n\n{{horario}}\n\n¿Quieres que te ayude a agendar una cita?',
      ],
    },
  },
  {
    id: 'business_location',
    handler: 'TOOL_DIRECT',
    tool: 'info_negocio',
    patterns: [
      '^(?:cual es |me dices |me das |me regalas |me compartes |me pasas |me envias |me puedes pasar |me puedes dar |me podrias dar )?(?:la |su )?(?:direccion|ubicacion)(?: del spa| del local| exacta)?(?: por favor)?$',
      '^donde (?:queda|quedan|estan|esta|se ubican|se encuentran|los encuentro)(?: el spa| el local| ustedes| ubicados| ubicadas)?(?: por favor)?$',
      '^como (?:llego|puedo llegar)(?: al spa| al local)?$',
    ],
    deny: [`\\b(?:${UNIVERSAL_DENY_TOPICS}|y|pero)\\b`],
    maxTokens: 10,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: [
        'Nos encuentras en 📍\n\n{{direccion}}\n\n¿Te ayudo a agendar tu cita?',
      ],
    },
  },
  {
    id: 'cancellation_policy',
    handler: 'TOOL_DIRECT',
    tool: 'info_negocio',
    patterns: [
      '^(?:cual es |me dices |me explicas )?(?:la |su )?politicas? de cancelacion(?: por favor)?$',
      '^como funciona (?:la )?cancelacion(?: de (?:una |la )?cita)?$',
      '^(?:que pasa|que sucede) si cancelo(?: mi cita| una cita)?$',
    ],
    deny: ['\\b(?:y|pero|quiero|necesito)\\b'],
    maxTokens: 12,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: ['Sobre cancelaciones 🌿\n\n{{politica}}'],
    },
  },
  {
    id: 'deposit_info',
    handler: 'TOOL_DIRECT',
    tool: 'info_negocio',
    patterns: [
      '^(?:de )?cuanto es (?:el )?(?:anticipo|abono|deposito)(?: para reservar| para agendar)?$',
      '^(?:cual es |me dices |me explicas )?(?:el |la )?(?:valor del |monto del )?(?:anticipo|abono|deposito)(?: para reservar| para agendar)?$',
      '^como (?:pago|hago|se paga) (?:el )?(?:anticipo|abono|deposito)$',
      '^hay que (?:dar|pagar) (?:un )?(?:anticipo|abono|deposito)(?: para reservar)?$',
    ],
    deny: ['\\b(?:y|pero|pague|pagado|ya|estado|llego|confirm\\w*)\\b'],
    maxTokens: 12,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: ['Sobre el anticipo 🌿\n\n{{anticipo}}'],
    },
  },
  {
    id: 'my_bookings',
    handler: 'TOOL_DIRECT',
    tool: 'reservas_proximas',
    patterns: [
      '^(?:cuales son |me dices |me muestras |me recuerdas |quiero ver |puedes ver )?(?:mis |mi )(?:citas|cita|reservas|reserva)(?: agendadas| programadas| proximas)?(?: por favor)?$',
      '^(?:que|cuales) (?:citas|reservas) tengo(?: agendadas| programadas)?$',
      '^(?:cuando|a que hora) es mi (?:cita|reserva|proxima cita)$',
      '^tengo (?:alguna )?(?:cita|reserva)(?: agendada| programada)?$',
      '^cuando tengo (?:mi )?(?:cita|reserva)$',
      '^para cuando (?:tengo|es) mi (?:cita|reserva)$',
    ],
    deny: [`\\b(?:${UNIVERSAL_DENY_TOPICS}|y|pero)\\b`],
    maxTokens: 10,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      some: [
        'Estas son tus próximas citas 🌿\n\n{{citas}}\n\n¿Necesitas cambiar o cancelar alguna?',
      ],
      none: [
        'No encuentro citas próximas con este número 🤔 Si quieres agendar, dime qué tratamiento te interesa y la fecha que prefieres.',
      ],
    },
  },
  {
    id: 'deposit_status',
    handler: 'TOOL_DIRECT',
    tool: 'depositos_pendientes',
    patterns: [
      '^(?:cual es |me dices )?(?:el )?estado (?:de |del )(?:mi |el )?(?:abono|anticipo|deposito|pago)$',
      '^(?:ya )?(?:me )?(?:llego|confirmaron|registraron|recibieron|reflejo) (?:mi |el )?(?:abono|anticipo|deposito|pago)$',
      '^(?:tengo|hay) (?:algun |un )?(?:abono|anticipo|deposito) pendiente$',
      '^cuanto (?:debo|me falta|falta) (?:de |del )?(?:abono|anticipo|deposito)$',
    ],
    deny: [`\\b(?:${UNIVERSAL_DENY_TOPICS}|y|pero)\\b`],
    maxTokens: 12,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      some: [
        'Tienes pendiente el abono de:\n\n{{pendientes}}\n\nPara confirmarla, envíame por aquí la foto del comprobante de pago 📸',
      ],
      none: [
        'No tienes abonos pendientes en este momento 🌿 ¿Te ayudo con algo más?',
      ],
    },
  },
  {
    id: 'treatments_list',
    handler: 'TOOL_DIRECT',
    tool: 'listar_tratamientos',
    patterns: [
      '^(?:que|cuales) precios (?:manejan|tienen)$',
      '^(?:que |cuales )?(?:tratamientos|servicios|procedimientos) (?:tienen|ofrecen|manejan|hay|son)(?: disponibles)?$',
      '^(?:cuales son )?(?:sus |los |nuestros )?(?:tratamientos|servicios)(?: que tienen| disponibles)?$',
      '^(?:me das |me pasas |me envias |me compartes |quiero ver |quisiera ver )?(?:la |el )?(?:lista|listado|catalogo) de (?:precios|tratamientos|servicios)(?: por favor)?$',
      '^(?:me das |me dices |me pasas )?(?:los |sus )?precios(?: por favor)?$',
      '^que (?:tratamientos|servicios) (?:tienen|ofrecen|manejan) y (?:sus |los )?precios$',
    ],
    deny: [
      `\\b(?:${UNIVERSAL_DENY_TOPICS}|pero|facial|capilar|masaje|keratina|alisado|botox)\\b`,
    ],
    maxTokens: 12,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: [
        'Estos son nuestros tratamientos 🌿\n\n{{lista}}{{nota}}\n\n¿Te cuento más de alguno o te ayudo a agendar?',
      ],
    },
  },
  {
    id: 'human_request',
    handler: 'HANDOFF',
    tool: 'pasar_a_persona',
    handoffReason: 'La clienta pidió hablar con una persona',
    patterns: [
      '^(?:quiero |necesito |quisiera |puedo |me gustaria |deseo )?(?:hablar|comunicarme|contactarme|escribirle|escribir|comunicar|pasarme|que me pasen|que me comuniquen) (?:con )?(?:una |un |alguna |algun )?(?:persona|humano|humana|asesor|asesora|alguien|agente|encargado|encargada|administrador|administradora|recepcion)(?: real| del spa| de verdad)?(?: por favor)?$',
      '^(?:quiero |necesito |prefiero )?(?:que )?(?:me )?(?:atienda|atiende|responda) (?:una |un )?(?:persona|humano|humana|asesor|asesora)(?: por favor)?$',
      '^(?:no quiero|no deseo|prefiero no) hablar con (?:un )?(?:bot|robot|asistente|maquina)$',
      '^(?:una |un )?(?:persona|humano|asesor|asesora|agente)(?: por favor)?$',
    ],
    deny: [`\\b(?:${UNIVERSAL_DENY_TOPICS}|y|pero)\\b`],
    maxTokens: 12,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: true,
    cooldownSeconds: 0,
    variants: {
      default: [
        'Listo 🙌 Ya avisé al equipo. Una persona te escribirá por este mismo chat lo antes posible.',
        'Claro, ya le pasé tu mensaje al equipo 🌿 Una persona continuará la conversación por aquí en breve.',
      ],
    },
  },
  {
    id: 'complaint',
    handler: 'HANDOFF',
    fixedConfidence: 0.9,
    tool: 'pasar_a_persona',
    handoffReason: 'La clienta expresa una queja o inconformidad',
    patterns: [
      '\\b(?:queja|reclamo|mal servicio|pesimo servicio|pesima atencion|mala atencion|inconforme|estoy molesta|estoy muy molesta|estoy molesto|estoy muy molesto|estoy indignada|estoy indignado)\\b',
    ],
    deny: [
      '\\b(?:ninguna|ningun|sin|gracias|felicitar|felicitaciones|excelente|buen servicio|buena atencion)\\b',
    ],
    maxTokens: 30,
    respectsOpenFlow: false,
    allowsQuestion: true,
    negationOk: false,
    cooldownSeconds: 0,
    variants: {
      default: [
        'Lamento mucho lo que pasó 🙏 Ya avisé al equipo para que una persona te escriba por este chat y lo revise contigo cuanto antes.',
      ],
    },
  },
];
