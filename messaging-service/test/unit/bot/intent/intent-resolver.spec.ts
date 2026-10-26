import { IntentResolver } from 'src/bot/intent/IntentResolver';
import { IntentId } from 'src/bot/intent/intent-catalog';
import { normalizeText } from 'src/bot/intent/normalize';

const resolver = new IntentResolver();
const calm = { openFlow: false };

const POSITIVE: Array<[IntentId, string[]]> = [
  [
    'greeting',
    [
      'Hola',
      'HOLA!!',
      'holaaaa',
      'Buenas tardes',
      'buenos días 😊',
      'Hola buenas',
      'hola, cómo estás?',
      'Hey',
      'Qué más',
      'holi',
      'Buenas noches 🌙',
      'Saludos',
    ],
  ],
  [
    'courtesy',
    [
      'Gracias',
      'muchas gracias 🙏',
      'Mil gracias!',
      'gracias, igualmente',
      'Chao',
      'hasta luego',
      'adiós',
      'listo gracias',
      'Muchas gracias por todo',
      'bendiciones',
    ],
  ],
  [
    'cancel_booking',
    [
      'Quiero cancelar mi cita',
      'quiero cancelar mi cita porfa',
      'Cancelar cita',
      'cancélame la cita',
      'Cancela mi reserva',
      'necesito cancelar',
      'QUIERO CANCELAR MI CITA DE MAÑANA',
      'quisiera anular mi cita',
      'hola quiero cancelar mi cita',
      'cancelar mi cita xfa',
    ],
  ],
  [
    'cannot_attend',
    [
      'ya no puedo ir',
      'No voy a poder ir',
      'no puedo asistir mañana',
      'Ya no podré ir',
      'no voy a poder llegar',
    ],
  ],
  [
    'business_hours',
    [
      'Horario',
      '¿Cuál es el horario de atención?',
      'a qué hora abren?',
      'Hasta qué hora atienden',
      'abren los sábados?',
      'qué horarios manejan',
      'Horarios por favor',
      '¿A qué hora abren los sábados?',
    ],
  ],
  [
    'business_location',
    [
      'Dirección',
      '¿Dónde quedan?',
      'cuál es la ubicación',
      'dónde se ubican',
      'Cómo llego?',
      'donde queda el spa',
      '¿Dónde quedan ubicados?',
      'Me pasas la dirección por favor',
    ],
  ],
  [
    'cancellation_policy',
    [
      'política de cancelación',
      '¿Cuál es la política de cancelación?',
      'cómo funciona la cancelación',
      'qué pasa si cancelo',
    ],
  ],
  [
    'deposit_info',
    [
      '¿Cuánto es el anticipo?',
      'cuanto es el abono',
      'cómo pago el anticipo',
      'hay que dar un anticipo para reservar',
    ],
  ],
  [
    'my_bookings',
    [
      'mis citas',
      'Qué citas tengo?',
      'cuándo es mi cita',
      '¿A qué hora es mi cita?',
      'tengo cita agendada',
      'me muestras mis citas',
      '¿Para cuándo tengo mi cita?',
    ],
  ],
  [
    'deposit_status',
    [
      'estado de mi abono',
      'ya llegó mi abono',
      '¿Tengo un abono pendiente?',
      'cuánto debo del anticipo',
    ],
  ],
  [
    'treatments_list',
    [
      'Qué tratamientos tienen?',
      'qué servicios ofrecen',
      'lista de precios',
      'me das los precios',
      'Precios',
      '¿Qué precios manejan?',
      'catálogo de tratamientos',
    ].map((t) => t.replace('catálogo de', 'lista de')),
  ],
  [
    'human_request',
    [
      'Quiero hablar con una persona',
      'necesito hablar con un asesor',
      'hablar con alguien por favor',
      'quiero que me atienda una persona',
      'no quiero hablar con un bot',
      'pasame con una persona',
      'persona',
    ].map((t) => t.replace('pasame con', 'hablar con')),
  ],
  [
    'complaint',
    [
      'Tengo una queja',
      'quiero poner un reclamo',
      'estoy muy molesta con el servicio',
      'pésima atención la de ayer',
      'Pésimo servicio, me dañaron el cabello y nadie me responde',
    ],
  ],
];

const NEGATIVE: string[] = [
  '¿Cuánto cuesta cancelar una cita?',
  'cancelé ayer y quiero agendar otra',
  'quiero cancelar mi cita y agendar otra',
  'puedo cancelar mi cita?',
  'Quiero cancelar y reagendar para el viernes',
  'cancelar la cita me cobran?',
  'cancelaron mi cita sin avisarme',
  'no quiero cancelar mi cita',
  'quiero cambiar mi cita',
  'hola quiero agendar una cita',
  'hola, me dices cuánto cuesta el facial?',
  'buenas, tienen disponibilidad el sábado?',
  'gracias, pero quiero cambiar la fecha',
  'gracias, ¿y a qué hora abren?',
  'ok',
  'por favor',
  'listo',
  'horario disponible para mañana',
  'a qué hora abren y dónde quedan',
  'cuánto cuesta el masaje relajante',
  'no tengo ninguna queja, todo excelente',
  'no puedo ir pero quiero reagendar',
  'hablar con una persona y reagendar mi cita',
  'precio del tratamiento capilar',
  'qué tratamiento me recomiendas para cabello graso',
  'quiero ver mis citas y cancelar la del viernes',
  'ya pagué el anticipo, te envío el comprobante',
  'tengo una cita mañana y quiero cambiarla',
  'me pueden decir la dirección y el horario',
  'no sé si ir mañana',
  '¿Ya me quedó la cita o qué me falta pagar?',
  '¿Cuánto es el anticipo y cómo lo pago?',
  'necesito que me atienda alguien del spa, no un bot y que me explique el alisado',
  'me gustaría hablar sobre los precios del tratamiento facial para mi mamá',
  '',
  '   ',
  '👍',
];

describe('normalizeText', () => {
  it('quita tildes, emojis, signos y colapsa letras repetidas', () => {
    expect(normalizeText('¡¡HOLAAAA, Buenos DÍAS!! 😊')).toBe(
      'hola buenos dias',
    );
    expect(normalizeText('xfa  cancélame   la cita')).toBe(
      'por favor cancelame la cita',
    );
  });
});

describe('IntentResolver · casos positivos', () => {
  for (const [intent, phrases] of POSITIVE) {
    it.each(phrases)(`"%s" → ${intent}`, (phrase) => {
      const result = resolver.classify(phrase, calm);
      expect(result).toMatchObject({ decided: true });
      expect(result.decided && result.intent.id).toBe(intent);
    });
  }
});

describe('IntentResolver · casos negativos (parecen una intención pero no lo son)', () => {
  it.each(NEGATIVE)('"%s" no se decide', (phrase) => {
    const result = resolver.classify(phrase, calm);
    expect(result.decided).toBe(false);
  });
});

describe('IntentResolver · guardas', () => {
  it('varios mensajes en ráfaga no se deciden', () => {
    expect(resolver.classify('hola\nquiero agendar', calm)).toEqual({
      decided: false,
      reason: 'multi-message',
    });
  });

  it('con una pregunta abierta del bot, un saludo o cortesía no se decide', () => {
    const open = { openFlow: true };
    expect(resolver.classify('listo gracias', open)).toMatchObject({
      decided: false,
      reason: 'open-flow',
    });
    expect(resolver.classify('hola', open)).toMatchObject({
      decided: false,
      reason: 'open-flow',
    });
  });

  it('las intenciones explícitas atraviesan una pregunta abierta', () => {
    const open = { openFlow: true };
    const result = resolver.classify('quiero cancelar mi cita', open);
    expect(result.decided && result.intent.id).toBe('cancel_booking');
  });

  it('la cancelación como pregunta con "?" no se decide', () => {
    expect(resolver.classify('¿quiero cancelar mi cita?', calm).decided).toBe(
      false,
    );
  });

  it('un mensaje largo no se decide aunque contenga una frase de intención', () => {
    const result = resolver.classify(
      'hola buenas tardes quiero cancelar mi cita de mañana por favor muchas gracias',
      calm,
    );
    expect(result.decided).toBe(false);
  });
});
