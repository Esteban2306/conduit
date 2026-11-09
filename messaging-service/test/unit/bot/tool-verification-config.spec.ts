import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateToolDefinitionDto } from 'src/bot/tools/dto/create-tool-definition.dto';
import { ToolDefinitionService } from 'src/bot/tools/ToolDefinitionService';

const base = {
  name: 'subir_comprobante',
  description: 'Sube el comprobante',
  parametersSchema: { type: 'object', properties: {} },
  endpointUrl: 'https://backend.test/subir',
  httpMethod: 'POST',
  authHeaderName: 'X-Api-Key',
  authSecret: 'secreto-largo-de-prueba',
  requiresImageAttachment: true,
  imageParamName: 'imageBase64',
};

const gated = {
  ...base,
  verificationCapability: 'image-analysis',
  acceptedVerdicts: ['VALID'],
};

const errorsOf = async (input: Record<string, unknown>) =>
  (await validate(plainToInstance(CreateToolDefinitionDto, input))).map(
    (e) => e.property,
  );

function build(
  existing: Record<string, unknown> | null = null,
  binding: Record<string, unknown> | null = { id: 'b1' },
) {
  const prisma = {
    toolDefinition: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 't1', ...data }),
      ),
      findFirst: jest.fn().mockResolvedValue(existing),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 't1', ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    botSpecialistBinding: {
      findFirst: jest.fn().mockResolvedValue(
        binding && {
          specialist: {
            outputSchema: {
              version: 1,
              variables: [
                { name: 'amount', type: 'number', description: 'valor' },
                { name: 'reference', type: 'string', description: 'código' },
              ],
              uniqueBy: [],
            },
          },
          ...binding,
        },
      ),
    },
  };
  const service = new ToolDefinitionService(
    prisma as never,
    { findOne: jest.fn().mockResolvedValue({ id: 'bot' }) } as never,
    { encrypt: (value: string) => `enc:${value}` } as never,
  );
  return { service, prisma };
}

describe('validación de los campos de verificación (DTO)', () => {
  it('acepta una configuración válida', async () => {
    expect(await errorsOf(gated)).toEqual([]);
  });

  it('las herramientas normales no necesitan nada de esto', async () => {
    expect(await errorsOf(base)).toEqual([]);
  });

  it('acepta cualquier capacidad con formato de clave válido', async () => {
    expect(
      await errorsOf({ ...gated, verificationCapability: 'landscape-check' }),
    ).toEqual([]);
  });

  it.each(['A', 'con espacio', 'a--b', 'x'.repeat(80)])(
    'rechaza la capacidad con formato inválido %j',
    async (capability) => {
      expect(
        await errorsOf({ ...gated, verificationCapability: capability }),
      ).toContain('verificationCapability');
    },
  );

  it.each([
    [['VALID', 'NEEDS_REVIEW'], true],
    [['NEEDS_REVIEW'], true],
    [['INVALID'], false],
    [['ERROR'], false],
    [['UNREADABLE'], false],
    [['NOT_APPLICABLE'], false],
    [['VALID', 'VALID'], false],
    [[], false],
    ['VALID', false],
  ])('acceptedVerdicts %j es válido: %s', async (verdicts, ok) => {
    const errors = await errorsOf({ ...gated, acceptedVerdicts: verdicts });
    expect(errors.includes('acceptedVerdicts')).toBe(!ok);
  });

  it.each(['verificacion', 'meta.verificacion', 'a_b'])(
    'acepta el nombre de parámetro %s',
    async (name) => {
      expect(await errorsOf({ ...gated, verificationParamName: name })).toEqual(
        [],
      );
    },
  );

  it.each(['1abc', 'a b', 'a..b', '../x', ''])(
    'rechaza el nombre de parámetro "%s"',
    async (name) => {
      expect(
        await errorsOf({ ...gated, verificationParamName: name }),
      ).toContain('verificationParamName');
    },
  );
});

describe('ToolDefinitionService: coherencia de la verificación', () => {
  it('crea una herramienta válida guardando los campos', async () => {
    const w = build();
    const created = await w.service.create('bot', 'tenant', gated);
    expect(created).toMatchObject({
      verificationCapability: 'image-analysis',
      acceptedVerdicts: ['VALID'],
    });
  });

  it('una herramienta normal guarda veredictos vacíos y sin capacidad', async () => {
    const w = build();
    const created = await w.service.create('bot', 'tenant', base);
    expect(created).toMatchObject({ acceptedVerdicts: [] });
    expect(
      (created as { verificationCapability?: string }).verificationCapability,
    ).toBeUndefined();
  });

  it.each([
    [
      'sin imagen adjunta',
      { requiresImageAttachment: false },
      /imagen adjunta/,
    ],
    ['de solo lectura', { httpMethod: 'GET' }, /solo lectura/],
    ['sin veredictos aceptados', { acceptedVerdicts: [] }, /acceptedVerdicts/],
    ['sin secreto para firmar', { authSecret: undefined }, /authSecret/],
  ])('rechaza al crear una herramienta %s', async (_name, over, message) => {
    const w = build();
    await expect(
      w.service.create('bot', 'tenant', { ...gated, ...over }),
    ).rejects.toThrow(message);
    expect(w.prisma.toolDefinition.create).not.toHaveBeenCalled();
  });

  const existing = {
    id: 't1',
    botConfigId: 'bot',
    verificationCapability: 'image-analysis',
    acceptedVerdicts: ['VALID'],
    requiresImageAttachment: true,
    httpMethod: 'POST',
    authSecretEncrypted: 'enc',
  };

  it('editar sin tocar la verificación no la rompe', async () => {
    const w = build(existing);
    await expect(
      w.service.update('bot', 't1', 'tenant', {
        description: 'nueva',
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      'quitarle la imagen adjunta',
      { requiresImageAttachment: false },
      /imagen adjunta/,
    ],
    ['volverla de solo lectura', { httpMethod: 'GET' }, /solo lectura/],
    ['borrarle el secreto', { clearAuth: true }, /authSecret/],
    [
      'vaciar los veredictos aceptados',
      { acceptedVerdicts: [] },
      /acceptedVerdicts/,
    ],
  ])(
    'rechaza %s a una herramienta con verificación',
    async (_n, change, message) => {
      const w = build(existing);
      await expect(
        w.service.update('bot', 't1', 'tenant', change as never),
      ).rejects.toThrow(message);
      expect(w.prisma.toolDefinition.update).not.toHaveBeenCalled();
    },
  );

  it('se puede quitar la verificación y entonces las demás condiciones ya no aplican', async () => {
    const w = build(existing);
    await expect(
      w.service.update('bot', 't1', 'tenant', {
        verificationCapability: null,
        requiresImageAttachment: false,
      } as never),
    ).resolves.toBeDefined();
  });

  it('se puede cambiar el secreto sin perder la verificación', async () => {
    const w = build(existing);
    await expect(
      w.service.update('bot', 't1', 'tenant', {
        authSecret: 'otro-secreto-nuevo',
      }),
    ).resolves.toBeDefined();
  });

  it('añadir verificación a una herramienta existente exige todo lo necesario', async () => {
    const plain = {
      ...existing,
      verificationCapability: null,
      acceptedVerdicts: [],
      authSecretEncrypted: null,
    };
    const w = build(plain);
    await expect(
      w.service.update('bot', 't1', 'tenant', {
        verificationCapability: 'image-analysis',
        acceptedVerdicts: ['VALID'],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ToolDefinitionService.getActiveToolsForBot con verificación', () => {
  it('expone la capacidad y oculta al modelo el parámetro del pasaporte', async () => {
    const w = build();
    w.prisma.toolDefinition.findMany.mockResolvedValue([
      {
        id: 'd1',
        name: 'subir_comprobante',
        description: 'x',
        parametersSchema: {
          type: 'object',
          properties: {
            nota: { type: 'string' },
            verificacion: { type: 'object' },
          },
          required: ['verificacion'],
        },
        httpMethod: 'POST',
        requiresImageAttachment: true,
        imageParamName: 'imageBase64',
        verificationCapability: 'image-analysis',
        verificationParamName: 'verificacion',
        maxImageSizeBytes: null,
        injectPhoneParamName: null,
        pausesBotMinutes: null,
      },
    ] as never);

    const [tool] = await w.service.getActiveToolsForBot('bot');

    expect(tool.verificationCapability).toBe('image-analysis');
    const schema = tool.spec.parametersSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['nota']);
    expect(schema.required ?? []).not.toContain('verificacion');
  });
});

describe('la capacidad exigida debe estar vinculada al bot', () => {
  it('crea la herramienta si el bot tiene el vínculo', async () => {
    const w = build(null, { id: 'b1' });
    await w.service.create('bot', 'tenant', {
      ...gated,
      verificationCapability: 'landscape-check',
    });
    expect(w.prisma.botSpecialistBinding.findFirst).toHaveBeenCalledWith({
      where: { botConfigId: 'bot', capability: 'landscape-check' },
      select: { id: true, specialist: { select: { outputSchema: true } } },
    });
    expect(w.prisma.toolDefinition.create).toHaveBeenCalled();
  });

  it('rechaza crear si el bot no tiene vínculo para esa capacidad', async () => {
    const w = build(null, null);
    await expect(
      w.service.create('bot', 'tenant', gated),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.toolDefinition.create).not.toHaveBeenCalled();
  });

  it('rechaza actualizar hacia una capacidad sin vínculo', async () => {
    const w = build({ ...base, id: 't1', botConfigId: 'bot' } as never, null);
    await expect(
      w.service.update('bot', 't1', 'tenant', {
        verificationCapability: 'image-analysis',
        acceptedVerdicts: ['VALID'],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('las herramientas sin verificación no consultan vínculos', async () => {
    const w = build(null, null);
    await w.service.create('bot', 'tenant', base);
    expect(w.prisma.botSpecialistBinding.findFirst).not.toHaveBeenCalled();
  });
});

describe('verifiedParams: configuración', () => {
  const create = (over: Record<string, unknown>) =>
    build().service.create('bot', 'tenant', { ...gated, ...over } as never);

  it('guarda el mapa y lo oculta del esquema que ve el modelo', async () => {
    const w = build();
    const created = await w.service.create('bot', 'tenant', {
      ...gated,
      parametersSchema: {
        type: 'object',
        properties: { monto: { type: 'number' }, nota: { type: 'string' } },
        required: ['monto'],
      },
      verifiedParams: { monto: 'amount' },
    } as never);
    expect(
      (created as unknown as { verifiedParams: unknown }).verifiedParams,
    ).toEqual({ monto: 'amount' });

    w.prisma.toolDefinition.findMany.mockResolvedValue([
      {
        id: 't1',
        name: 'subir',
        description: 'd',
        httpMethod: 'POST',
        isActive: true,
        requiresImageAttachment: true,
        imageParamName: 'imageBase64',
        verificationCapability: 'image-analysis',
        verifiedParams: { monto: 'amount' },
        parametersSchema: {
          type: 'object',
          properties: { monto: { type: 'number' }, nota: { type: 'string' } },
          required: ['monto'],
        },
      },
    ]);
    const [resolved] = await w.service.getActiveToolsForBot('bot');
    expect(Object.keys(resolved.spec.parametersSchema.properties)).toEqual([
      'nota',
    ]);
    expect(resolved.spec.parametersSchema.required).toEqual([]);
  });

  it.each([
    [
      'sin verificación',
      {
        verificationCapability: undefined,
        acceptedVerdicts: undefined,
        verifiedParams: { a: 'amount' },
      },
      /solo se permite/,
    ],
    [
      'con una variable que el especialista no declara',
      { verifiedParams: { a: 'inexistente' } },
      /no declara la variable/,
    ],
    [
      'que choca con el parámetro de imagen',
      { verifiedParams: { imageBase64: 'amount' } },
      /choca/,
    ],
    [
      'que choca con el teléfono',
      { injectPhoneParamName: 'tel', verifiedParams: { tel: 'amount' } },
      /choca/,
    ],
    [
      'que cuelga del parámetro del pasaporte',
      { verificationParamName: 'ver', verifiedParams: { 'ver.x': 'amount' } },
      /choca/,
    ],
    [
      'con rutas solapadas',
      { verifiedParams: { a: 'amount', 'a.b': 'reference' } },
      /se solapa/,
    ],
    [
      'con una ruta inválida',
      { verifiedParams: { 'a b': 'amount' } },
      /verifiedParams no es válido/,
    ],
    [
      'con un nombre de variable inválido',
      { verifiedParams: { a: 'Monto' } },
      /verifiedParams no es válido/,
    ],
    [
      'con ruta peligrosa',
      { verifiedParams: { 'a.__proto__': 'amount' } },
      /verifiedParams no es válido/,
    ],
  ])('rechaza %s', async (_n, over, message) => {
    const attempt = create(over);
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(message);
  });

  it('rechaza más de 12 entradas', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`p${i}`, 'amount']),
    );
    await expect(create({ verifiedParams: many })).rejects.toThrow(/Máximo 12/);
  });

  it('actualizar otro campo revalida el mapa guardado contra el especialista', async () => {
    const w = build({
      ...base,
      id: 't1',
      botConfigId: 'bot',
      verificationCapability: 'image-analysis',
      acceptedVerdicts: ['VALID'],
      authSecretEncrypted: 'enc',
      verifiedParams: { a: 'variable_vieja' },
    } as never);
    await expect(
      w.service.update('bot', 't1', 'tenant', { description: 'x' } as never),
    ).rejects.toThrow(/no declara la variable/);
  });
});
