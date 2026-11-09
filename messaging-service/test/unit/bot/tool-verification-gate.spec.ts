import { createHmac, randomBytes } from 'crypto';
import sharp from 'sharp';
import { hashImage } from 'src/bot/specialists/image-hash';
import {
  ToolExecutorService,
  VERIFICATION_HEADER,
  VERIFICATION_SIGNATURE_HEADER,
} from 'src/bot/tools/ToolExecutor.service';

const SECRET = randomBytes(16).toString('hex');
const TENANT = 'tenant-1';
const CONVERSATION = 'conv-1';

const dataUri = (buffer: Buffer) =>
  `data:image/jpeg;base64,${buffer.toString('base64')}`;

const makeImage = (seed = 1) =>
  sharp(randomBytes(40 * 40 * 3), {
    raw: { width: 40, height: 40, channels: 3 },
  })
    .modulate({ brightness: seed })
    .png()
    .toBuffer();

const record = (extra: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  verdict: 'VALID',
  confidence: 0.9,
  fields: {
    amount: 150000,
    currency: 'COP',
    date: '2026-11-08',
    reference: 'TRX-48210377',
    recipient: 'Spa Demo',
    legibility: 'CLEAR',
  },
  reasonCodes: ['RULES_PASSED'],
  subjectHash: 'hash-1',
  createdAt: new Date('2026-11-09T15:00:00Z'),
  ...extra,
});

function build(
  toolOver: Record<string, unknown> = {},
  ledgerOver: Record<string, unknown> = {},
) {
  const tool = {
    id: 'tool-1',
    isActive: true,
    httpMethod: 'POST',
    endpointUrl: 'https://backend.test/subir',
    authHeaderName: 'X-Api-Key',
    authSecretEncrypted: 'enc',
    maxImageSizeBytes: null,
    verificationCapability: 'image-analysis',
    acceptedVerdicts: ['VALID'],
    verificationParamName: null,
    botConfig: { tenantId: TENANT },
    ...toolOver,
  };
  const prisma = {
    toolDefinition: { findUnique: jest.fn().mockResolvedValue(tool) },
    toolInvocation: {
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 'inv-1', ...create }),
      ),
    },
  };
  const ledger = {
    findAcceptable: jest.fn().mockResolvedValue(record()),
    claim: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
    passportTtlMs: () => 3_600_000,
    ...ledgerOver,
  };
  const service = new ToolExecutorService(
    prisma as never,
    { decrypt: () => SECRET } as never,
    ledger as never,
  );
  (service as unknown as { logger: object }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { service, prisma, ledger, tool };
}

const originalFetch = global.fetch;
const respond = (status: number, body: unknown = { ok: status < 400 }) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as never;
};
const fetched = () =>
  (global.fetch as jest.Mock).mock.calls as Array<
    [string, { headers: Record<string, string>; body: string }]
  >;

const call = async (
  w: ReturnType<typeof build>,
  over: Record<string, unknown> = {},
) =>
  w.service.execute({
    toolDefinitionId: 'tool-1',
    conversationId: CONVERSATION,
    params: {},
    attachedImage: {
      dataUri: dataUri(await makeImage()),
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    },
    imageParamName: 'imageBase64',
    ...over,
  });

afterEach(() => {
  global.fetch = originalFetch;
});

describe('puerta de verificación del ejecutor de herramientas', () => {
  describe('rechazos que nunca llegan al backend', () => {
    beforeEach(() => respond(200));

    const expectRefused = (
      outcome: Awaited<ReturnType<typeof call>>,
      w: ReturnType<typeof build>,
    ) => {
      expect(outcome).toMatchObject({
        status: 'BUSINESS_ERROR',
        httpStatus: 422,
        responseBody: {
          code: 'VERIFICATION_REQUIRED',
          nextStep: 'WAIT_FOR_REVIEW',
        },
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(w.prisma.toolInvocation.upsert).not.toHaveBeenCalled();
    };

    it('sin imagen adjunta', async () => {
      const w = build();
      expectRefused(await call(w, { attachedImage: undefined }), w);
      expect(w.ledger.findAcceptable).not.toHaveBeenCalled();
    });

    it.each([
      'no es un data uri',
      'data:image/jpeg;base64,',
      'data:image/jpeg,texto',
    ])('con un adjunto inválido (%s)', async (uri) => {
      const w = build();
      expectRefused(
        await call(w, {
          attachedImage: { dataUri: uri, mimeType: 'image/jpeg', sizeBytes: 1 },
        }),
        w,
      );
    });

    it('con bytes que no son una imagen normalizable', async () => {
      const w = build();
      expectRefused(
        await call(w, {
          attachedImage: {
            dataUri: dataUri(Buffer.from('no soy una imagen')),
            mimeType: 'image/jpeg',
            sizeBytes: 17,
          },
        }),
        w,
      );
      expect(w.ledger.findAcceptable).not.toHaveBeenCalled();
    });

    it('sin un veredicto aceptado y vigente', async () => {
      const w = build(
        {},
        { findAcceptable: jest.fn().mockResolvedValue(null) },
      );
      expectRefused(await call(w), w);
      expect(w.ledger.claim).not.toHaveBeenCalled();
    });

    it('si otro llamado ya reclamó el veredicto', async () => {
      const w = build({}, { claim: jest.fn().mockResolvedValue(false) });
      expectRefused(await call(w), w);
    });

    it('no revela en la respuesta por qué se rechazó', async () => {
      const w = build(
        {},
        { findAcceptable: jest.fn().mockResolvedValue(null) },
      );
      const outcome = await call(w);
      expect(JSON.stringify(outcome.responseBody)).not.toMatch(
        /hash|veredicto ya|NEEDS_REVIEW|INVALID/i,
      );
    });
  });

  it('sin secreto para firmar es un error técnico de configuración y no llama al backend', async () => {
    respond(200);
    const w = build({ authSecretEncrypted: null });
    const outcome = await call(w);

    expect(outcome.status).toBe('TECHNICAL_ERROR');
    expect(outcome.httpStatus).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(w.ledger.claim).not.toHaveBeenCalled();
  });

  describe('autorización', () => {
    beforeEach(() => respond(200));

    it('busca el veredicto con tenant del bot, conversación, capacidad, veredictos aceptados y el hash de esos bytes', async () => {
      const w = build({ acceptedVerdicts: ['VALID', 'NEEDS_REVIEW'] });
      const image = await makeImage(3);
      await call(w, {
        attachedImage: {
          dataUri: dataUri(image),
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        },
      });

      expect(w.ledger.findAcceptable).toHaveBeenCalledWith({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        capability: 'image-analysis',
        hash: (await hashImage(image)).hash,
        acceptedVerdicts: ['VALID', 'NEEDS_REVIEW'],
      });
    });

    it('imágenes distintas se buscan con hashes distintos', async () => {
      const w = build();
      const first = await makeImage(1);
      const second = await makeImage(2);
      for (const image of [first, second]) {
        await call(w, {
          attachedImage: {
            dataUri: dataUri(image),
            mimeType: 'image/jpeg',
            sizeBytes: 1,
          },
        });
      }
      const hashes = w.ledger.findAcceptable.mock.calls.map(
        (c) => (c as unknown as [{ hash: string }])[0].hash,
      );
      expect(new Set(hashes).size).toBe(2);
    });

    it('reclama el veredicto antes de llamar al backend', async () => {
      const order: string[] = [];
      const w = build(
        {},
        {
          claim: jest.fn(() => {
            order.push('claim');
            return Promise.resolve(true);
          }),
        },
      );
      (global.fetch as jest.Mock).mockImplementation(() => {
        order.push('fetch');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      });
      await call(w);
      expect(order).toEqual(['claim', 'fetch']);
      expect(w.ledger.claim).toHaveBeenCalledWith('rec-1', TENANT);
    });
  });

  describe('pasaporte firmado', () => {
    beforeEach(() => respond(200));

    const passportOf = (headers: Record<string, string>) =>
      JSON.parse(
        Buffer.from(headers[VERIFICATION_HEADER], 'base64url').toString(),
      ) as Record<string, any>;

    it('viaja en cabeceras y la firma se verifica con el secreto de la herramienta', async () => {
      const w = build();
      await call(w);

      const headers = fetched()[0][1].headers;
      const payload = headers[VERIFICATION_HEADER];
      const signature = headers[VERIFICATION_SIGNATURE_HEADER];
      expect(signature).toBe(
        createHmac('sha256', SECRET).update(payload).digest('hex'),
      );
      expect(
        createHmac('sha256', 'otro-secreto').update(payload).digest('hex'),
      ).not.toBe(signature);
    });

    it('contiene el veredicto, los campos leídos y la identidad del chat', async () => {
      const w = build();
      await call(w);

      expect(passportOf(fetched()[0][1].headers)).toEqual({
        version: 1,
        verificationId: 'rec-1',
        capability: 'image-analysis',
        tenantId: TENANT,
        conversationId: CONVERSATION,
        verdict: 'VALID',
        confidence: 0.9,
        fields: record().fields,
        hash: 'hash-1',
        issuedAt: '2026-11-09T15:00:00.000Z',
        expiresAt: '2026-11-09T16:00:00.000Z',
      });
    });

    it('descarta campos que no pertenecen a la lista blanca', async () => {
      const w = build(
        {},
        {
          findAcceptable: jest
            .fn()
            .mockResolvedValue(
              record({ fields: { amount: 5, cardNumber: '4111' } }),
            ),
        },
      );
      await call(w);
      expect(passportOf(fetched()[0][1].headers).fields).toEqual({});
    });

    it('un pasaporte alterado ya no coincide con su firma', async () => {
      const w = build();
      await call(w);
      const headers = fetched()[0][1].headers;
      const forged = Buffer.from(
        JSON.stringify({
          ...passportOf(headers),
          verdict: 'VALID',
          confidence: 1,
        }),
      ).toString('base64url');
      expect(
        createHmac('sha256', SECRET).update(forged).digest('hex'),
      ).not.toBe(headers[VERIFICATION_SIGNATURE_HEADER]);
    });

    it('con verificationParamName también va en el cuerpo y el modelo no puede pisarlo', async () => {
      const w = build({ verificationParamName: 'verificacion' });
      await call(w, {
        params: { verificacion: 'APROBADO POR EL MODELO', otro: 'dato' },
      });

      const body = JSON.parse(fetched()[0][1].body) as Record<
        string,
        unknown
      > & { verificacion: { payload: string; signature: string } };
      expect(body.otro).toBe('dato');
      expect(typeof body.verificacion).toBe('object');
      expect(body.verificacion.payload).toBe(
        fetched()[0][1].headers[VERIFICATION_HEADER],
      );
      expect(body.verificacion.signature).toBe(
        fetched()[0][1].headers[VERIFICATION_SIGNATURE_HEADER],
      );
    });

    it('sin verificationParamName el cuerpo no lleva el pasaporte', async () => {
      const w = build();
      await call(w);
      const body = JSON.parse(fetched()[0][1].body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['imageBase64']);
    });

    it('el modelo no puede inyectar el pasaporte por las cabeceras', async () => {
      const w = build();
      await call(w, {
        params: { 'X-Conduit-Verification': 'falso', headers: { x: 1 } },
      });
      const headers = fetched()[0][1].headers;
      expect(headers[VERIFICATION_HEADER]).not.toBe('falso');
    });
  });

  describe('qué pasa con el veredicto reclamado', () => {
    it('un éxito lo deja consumido', async () => {
      respond(200);
      const w = build();
      const outcome = await call(w);
      expect(outcome.status).toBe('SUCCESS');
      expect(w.ledger.release).not.toHaveBeenCalled();
    });

    it.each([400, 401, 403, 404, 409, 422])(
      'un rechazo definitivo del backend (%s) lo libera para reintentar',
      async (status) => {
        respond(status, { code: 'NO' });
        const w = build();
        const outcome = await call(w);
        expect(outcome.status).toBe('BUSINESS_ERROR');
        expect(w.ledger.release).toHaveBeenCalledWith('rec-1', TENANT);
      },
    );

    it.each([408, 429, 500, 502, 503])(
      'un resultado ambiguo (%s) lo mantiene consumido',
      async (status) => {
        respond(status);
        const w = build();
        await call(w);
        expect(w.ledger.release).not.toHaveBeenCalled();
      },
    );

    it('si la red falla lo mantiene consumido', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('red caída')) as never;
      const w = build();
      const outcome = await call(w);
      expect(outcome.status).toBe('TECHNICAL_ERROR');
      expect(w.ledger.release).not.toHaveBeenCalled();
    });

    it('si falla al liberarlo no rompe la respuesta', async () => {
      respond(400);
      const w = build(
        {},
        { release: jest.fn().mockRejectedValue(new Error('db')) },
      );
      const outcome = await call(w);
      expect(outcome.status).toBe('BUSINESS_ERROR');
    });
  });

  describe('herramientas sin verificación', () => {
    it('no consultan ni reclaman nada', async () => {
      respond(200);
      const w = build({ verificationCapability: null, acceptedVerdicts: [] });
      const outcome = await call(w);

      expect(outcome.status).toBe('SUCCESS');
      expect(w.ledger.findAcceptable).not.toHaveBeenCalled();
      expect(w.ledger.claim).not.toHaveBeenCalled();
      const headers = fetched()[0][1].headers;
      expect(headers[VERIFICATION_HEADER]).toBeUndefined();
      expect(headers[VERIFICATION_SIGNATURE_HEADER]).toBeUndefined();
    });
  });
});
