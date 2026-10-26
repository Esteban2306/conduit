import { Test } from '@nestjs/testing';
import { IntentResolver, compileIntent } from 'src/bot/intent/IntentResolver';
import { normalizeText } from 'src/bot/intent/normalize';
import { TIME_ZONE, spaRecords } from './fixture';

const resolver = new IntentResolver();
const compiled = spaRecords().map(compileIntent);
const calm = { openFlow: false, timeZone: TIME_ZONE };

function decide(text: string, context = calm) {
  return resolver.classify(text, context, compiled);
}

const POSITIVE: Array<[string, string[]]> = [
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
      'Me pasas la dirección por favor',
      '¿Dónde quedan ubicados?',
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
    'payment_methods',
    [
      'medios de pago',
      '¿Cuáles son las formas de pago?',
      'cómo puedo pagar',
      'aceptan nequi',
      'aceptan tarjeta',
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
    ],
  ],
  [
    'treatment_info',
    [
      '¿Cuánto cuesta el alisado orgánico?',
      'qué incluye la hidratación profunda',
      'cuánto dura el spa coreano',
      'de qué se trata la terapia de control',
      'me cuentas sobre el manicure',
      'precio del alisado',
      'información sobre la hidratación',
      'para qué sirve la terapia de control',
    ],
  ],
  [
    'human_request',
    [
      'Quiero hablar con una persona',
      'necesito hablar con un asesor',
      'hablar con alguien por favor',
      'quiero que me atienda una persona',
      'no quiero hablar con un bot',
      'hablar con una persona',
      'persona',
    ],
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
  [
    'booking',
    [
      'Quiero agendar una cita',
      'hola quiero agendar',
      'quiero una cita de nutrición',
      'tienen disponibilidad el sábado?',
      'horario disponible para mañana',
      'quiero cambiar mi cita',
      'quiero reagendar para el viernes',
      'puedo reservar para mañana',
      'buenas, quisiera sacar una cita',
      'cancelé ayer y quiero agendar otra',
      'quiero cancelar mi cita y agendar otra',
    ],
  ],
];

const NO_DECIDE: string[] = [
  '¿Cuánto cuesta cancelar una cita?',
  'puedo cancelar mi cita?',
  'cancelar la cita me cobran?',
  'cancelaron mi cita sin avisarme',
  'no quiero cancelar mi cita',
  'hola, me dices cuánto cuesta el facial?',
  'gracias, pero quiero cambiar la fecha',
  'gracias, ¿y a qué hora abren?',
  'ok',
  'por favor',
  'listo',
  'a qué hora abren y dónde quedan',
  'no tengo ninguna queja, todo excelente',
  'no puedo ir pero quiero reagendar',
  'hablar con una persona y reagendar mi cita',
  'qué tratamiento me recomiendas para cabello graso',
  'ya pagué el anticipo, te envío el comprobante',
  'me pueden decir la dirección y el horario',
  'no sé si ir mañana',
  '¿Ya me quedó la cita o qué me falta pagar?',
  '¿Cuánto es el anticipo y cómo lo pago?',
  'necesito que me atienda alguien del spa, no un bot y que me explique el alisado',
  'me gustaría hablar sobre los precios del tratamiento facial para mi mamá',
  'cuánto cuesta la cita',
  'cuánto cuesta cancelar',
  'precio de todos los tratamientos',
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
  for (const [key, phrases] of POSITIVE) {
    it.each(phrases)(`"%s" → ${key}`, (phrase) => {
      const result = decide(phrase);
      expect(result).toMatchObject({ decided: true });
      expect(result.decided && result.intent.key).toBe(key);
    });
  }
});

describe('IntentResolver · casos negativos (parecen una intención pero no lo son)', () => {
  it.each(NO_DECIDE)('"%s" no se decide', (phrase) => {
    expect(decide(phrase).decided).toBe(false);
  });
});

describe('IntentResolver · entidad', () => {
  it('captura el nombre que la clienta usó', () => {
    const result = decide('¿Cuánto cuesta el alisado orgánico?');
    expect(result.decided && result.entity).toBe('alisado organico');
  });

  it('una consulta que parece de tratamiento pero habla de la cita queda sin decidir', () => {
    expect(decide('cuánto cuesta la cita').decided).toBe(false);
  });
});

describe('IntentResolver · guardas', () => {
  it('varios mensajes en ráfaga no se deciden', () => {
    expect(decide('hola\nquiero agendar')).toEqual({
      decided: false,
      reason: 'multi-message',
    });
  });

  it('con una pregunta abierta, saludo y cortesía no se deciden', () => {
    const open = { ...calm, openFlow: true };
    expect(decide('listo gracias', open)).toMatchObject({
      decided: false,
      reason: 'open-flow',
    });
    expect(decide('hola', open)).toMatchObject({
      decided: false,
      reason: 'open-flow',
    });
  });

  it('las intenciones explícitas atraviesan una pregunta abierta', () => {
    const open = { ...calm, openFlow: true };
    const result = decide('quiero cancelar mi cita', open);
    expect(result.decided && result.intent.key).toBe('cancel_booking');
  });

  it('la cancelación como pregunta con "?" no se decide', () => {
    expect(decide('¿quiero cancelar mi cita?').decided).toBe(false);
  });

  it('un mensaje largo no se decide aunque contenga una frase de intención', () => {
    expect(
      decide(
        'hola buenas tardes quiero cancelar mi cita de mañana por favor muchas gracias',
      ).decided,
    ).toBe(false);
  });

  it('una intención amplia cede ante una específica y las específicas entre sí no se deciden', () => {
    expect(decide('quiero cancelar mi cita').decided).toBe(true);
    const a = spaRecords().map(compileIntent);
    const clash = new IntentResolver().classify('horario disponible', calm, a);
    expect(clash.decided && clash.intent.key).toBe('booking');
  });

  it('una intención programada fuera de su ventana no participa', () => {
    const records = spaRecords();
    const courtesy = records.find((r) => r.key === 'courtesy')!;
    courtesy.schedule = {
      timeZone: TIME_ZONE,
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '03:00', to: '03:01' }],
    };
    const inside = new Date('2026-10-26T08:00:30Z');
    const outside = new Date('2026-10-26T15:00:00Z');
    const set = records.map(compileIntent);
    expect(
      resolver.classify('gracias', { ...calm, now: inside }, set).decided,
    ).toBe(true);
    expect(
      resolver.classify('gracias', { ...calm, now: outside }, set),
    ).toMatchObject({ decided: false, reason: 'no-match' });
  });
});

describe('IntentResolver · inyección', () => {
  it('Nest puede construirlo sin configuración (umbral por defecto)', async () => {
    const module = await Test.createTestingModule({
      providers: [IntentResolver],
    }).compile();
    expect(module.get(IntentResolver)).toBeInstanceOf(IntentResolver);
  });
});
