import { BadRequestException } from '@nestjs/common';
import { BotStatus, PromptTemplateType } from '@prisma/client';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';
import { PromptEngine } from 'src/bot/prompt/PromptEngine';
import { PromptRenderer } from 'src/bot/prompt/PromptRenderer';
import { PromptService } from 'src/bot/prompt/Prompt.service';
import { TemplateRepository } from 'src/bot/prompt/repositories/TemplateRepository';
import { findUnknownToolReferences } from 'src/bot/prompt/tool-references';
import { VariableResolver } from 'src/bot/prompt/VariableResolver';

const REAL_TOOLS = [
  'info_negocio',
  'listar_tratamientos',
  'consultar_disponibilidad',
  'disponibilidad_combo',
  'registrar_cliente',
  'actualizar_perfil_cliente',
  'crear_reserva_whatsapp',
  'reservas_proximas',
  'reagendar_reserva_whatsapp',
  'cancelar_reserva_whatsapp',
  'depositos_pendientes',
  'registrar_comprobante_automatico',
  'pasar_a_persona',
];

describe('findUnknownToolReferences', () => {
  it('acepta una plantilla que solo nombra herramientas reales', () => {
    expect(
      findUnknownToolReferences(
        'Usa listar_tratamientos y luego crear_reserva_whatsapp.',
        REAL_TOOLS,
      ),
    ).toEqual([]);
  });

  it('detecta los nombres inexistentes del prompt heredado, sin repetirlos', () => {
    expect(
      findUnknownToolReferences(
        'Usa consultar_o_crear_cliente, crear_reserva, consultar_depositos_pendientes, actualizar_cliente y otra vez crear_reserva. También listar_tratamientos.',
        REAL_TOOLS,
      ),
    ).toEqual([
      'consultar_o_crear_cliente',
      'crear_reserva',
      'consultar_depositos_pendientes',
      'actualizar_cliente',
    ]);
  });

  it('no confunde variables de plantilla ni constantes con herramientas', () => {
    expect(
      findUnknownToolReferences(
        '{{agentName}} {{#goals}}x{{/goals}} type TERMINOS_SERVICIO purpose=RESCHEDULE policyVersion',
        REAL_TOOLS,
      ),
    ).toEqual([]);
  });

  it('con un bot sin herramientas cualquier nombre de herramienta es inexistente', () => {
    expect(findUnknownToolReferences('Usa info_negocio.', [])).toEqual([
      'info_negocio',
    ]);
  });

  it('las plantillas por defecto de Conduit no nombran ninguna herramienta', () => {
    const repo = new TemplateRepository({} as never);
    for (const type of Object.values(PromptTemplateType)) {
      expect(findUnknownToolReferences(repo.getDefault(type), [])).toEqual([]);
    }
  });
});

describe('PromptEngine.preview de CONVERSATION', () => {
  afterEach(() => jest.useRealTimers());

  function engine() {
    return new PromptEngine(
      {
        findActive: () =>
          Promise.resolve('Eres {{agentName}}. Hoy: {{today}}.'),
      } as never,
      { findByBot: () => Promise.resolve({ agentName: 'Lu' }) } as never,
      new VariableResolver(),
      new ContextBuilder(),
      new PromptRenderer(),
      { assemble: () => Promise.resolve({ compiled: null }) } as never,
      { resolve: () => Promise.resolve({ compiledBlock: null }) } as never,
      { get: () => 'America/Bogota' } as never,
    );
  }

  it('incluye la fecha de hoy en zona Bogotá con día de la semana, al final', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T03:30:00Z'));
    const out = await engine().preview('bot', PromptTemplateType.CONVERSATION);
    expect(out).toContain('jueves, 22 de octubre de 2026');
    expect(out).toContain('2026-10-22');
    expect(out).toContain('America/Bogota');
    expect(out.trimEnd().endsWith(').')).toBe(true);
  });

  it('no añade fecha a las demás plantillas', async () => {
    const out = await engine().preview('bot', PromptTemplateType.SUMMARY);
    expect(out).not.toContain('Fecha y hora actual');
  });

  it('el prompt real pone la fecha en el bloque dinámico y no en el cacheable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T03:30:00Z'));
    const built = await engine().buildConversationPrompt('bot', {
      userMessage: 'hola',
      history: [],
      context: {},
      summary: null,
    });
    expect(built.dynamicPrompt).toContain('2026-10-22');
    expect(built.cacheablePrompt).not.toContain('Fecha y hora actual');
    expect(built.systemPrompt.endsWith(built.dynamicPrompt!)).toBe(true);
  });
});

describe('PromptService.update: coherencia de herramientas', () => {
  function service(toolNames: string[]) {
    const upsert = jest.fn().mockResolvedValue({ id: 't' });
    const svc = new PromptService(
      {} as never,
      { upsert } as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({}) } as never,
      {
        toolDefinition: {
          findMany: jest
            .fn()
            .mockResolvedValue(toolNames.map((name) => ({ name }))),
        },
      } as never,
    );
    return { svc, upsert };
  }

  it('rechaza una plantilla CONVERSATION con herramientas inexistentes y no la guarda', async () => {
    const { svc, upsert } = service(REAL_TOOLS);
    await expect(
      svc.update(
        'bot',
        PromptTemplateType.CONVERSATION,
        'Usa consultar_o_crear_cliente.',
        'tenant',
      ),
    ).rejects.toThrow(/consultar_o_crear_cliente/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('guarda una plantilla coherente', async () => {
    const { svc, upsert } = service(REAL_TOOLS);
    await svc.update(
      'bot',
      PromptTemplateType.CONVERSATION,
      'Usa info_negocio.',
      'tenant',
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('otros tipos de plantilla no se validan contra herramientas', async () => {
    const { svc, upsert } = service([]);
    await svc.update('bot', PromptTemplateType.SUMMARY, 'x_y', 'tenant');
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('BotConfigService.toggle: validación al activar', () => {
  function service(opts: {
    status: BotStatus;
    template: string | null;
    tools: string[];
  }) {
    const update = jest
      .fn()
      .mockImplementation(({ data }: { data: { status: BotStatus } }) =>
        Promise.resolve({ id: 'bot', name: 'b', status: data.status }),
      );
    const prisma = {
      botConfig: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'bot', tenantId: 't', status: opts.status }),
        update,
      },
      botPromptTemplate: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.template === null ? null : { content: opts.template },
          ),
      },
      toolDefinition: {
        findMany: jest
          .fn()
          .mockResolvedValue(opts.tools.map((name) => ({ name }))),
      },
      aiModelConfig: { count: jest.fn().mockResolvedValue(2) },
    };
    const svc = new BotConfigService(prisma as never, {} as never, {} as never);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as never);
    return { svc, update };
  }

  it('no activa un bot sin plantilla CONVERSATION propia', async () => {
    const { svc, update } = service({
      status: BotStatus.INACTIVE,
      template: null,
      tools: REAL_TOOLS,
    });
    await expect(svc.toggle('bot', 't')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('no activa un bot con plantilla vacía', async () => {
    const { svc } = service({
      status: BotStatus.INACTIVE,
      template: '   ',
      tools: REAL_TOOLS,
    });
    await expect(svc.toggle('bot', 't')).rejects.toThrow(/plantilla/);
  });

  it('no activa un bot cuya plantilla nombra herramientas inexistentes', async () => {
    const { svc } = service({
      status: BotStatus.INACTIVE,
      template: 'Usa crear_reserva.',
      tools: REAL_TOOLS,
    });
    await expect(svc.toggle('bot', 't')).rejects.toThrow(/crear_reserva/);
  });

  it('activa un bot con plantilla válida', async () => {
    const { svc } = service({
      status: BotStatus.INACTIVE,
      template: 'Usa crear_reserva_whatsapp.',
      tools: REAL_TOOLS,
    });
    await expect(svc.toggle('bot', 't')).resolves.toMatchObject({
      status: BotStatus.ACTIVE,
    });
  });

  it('desactivar nunca exige plantilla', async () => {
    const { svc } = service({
      status: BotStatus.ACTIVE,
      template: null,
      tools: [],
    });
    await expect(svc.toggle('bot', 't')).resolves.toMatchObject({
      status: BotStatus.INACTIVE,
    });
  });
});
