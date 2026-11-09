jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { GroundingResolver } from 'src/bot/specialists/GroundingResolver';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';
import { VerificationLedger } from 'src/bot/specialists/VerificationLedger';
import { ToolDefinitionService } from 'src/bot/tools/ToolDefinitionService';
import { ToolExecutorService } from 'src/bot/tools/ToolExecutor.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const CAP = 'payment-proof';
const PHONE = '573001112233';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

suite(
  'Contexto del negocio con herramienta HTTP real y mapeos en la base',
  () => {
    const run = randomUUID().slice(0, 8);
    const tenantId = `it-g-${run}`;
    let prisma: PrismaClient;
    let server: Server;
    let baseUrl: string;
    let botA: string;
    let botB: string;
    let toolId: string;
    let counter = 0;
    const seen: Seen[] = [];
    let behavior: 'ok' | 'error' | 'slow' = 'ok';
    let modelContent = '';
    const orchestrator = {
      analyzeImageForSpecialist: jest.fn(() =>
        Promise.resolve({
          content: modelContent,
          tokensUsed: 5,
          modelUsed: 'm',
        }),
      ),
    };

    const extraction = (fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        version: 1,
        confidence: 0.9,
        isExpectedDocument: true,
        fields: {
          amount: 150000,
          currency: 'COP',
          date: '2026-11-08',
          reference: 'TRX-48210377',
          recipient: 'Spa Demo S.A.S.',
          legibility: 'CLEAR',
          ...fields,
        },
      });

    const encryption = new SecretEncryptionService({
      get: () => randomBytes(32).toString('hex'),
    } as never);
    encryption.onModuleInit();

    const runtime = () => {
      const config = {
        get: (key: string) =>
          ({
            'specialists.enabled': true,
            'specialists.retentionDays': 30,
            'specialists.passportTtlMinutes': 60,
            'specialists.groundingTimeoutMs': 1500,
            'whatsapp.timeZone': 'America/Bogota',
          })[key],
      };
      const grounding = new GroundingResolver(
        config as never,
        prisma as never,
        new ToolDefinitionService(prisma as never, {} as never, encryption),
        new ToolExecutorService(prisma as never, encryption),
      );
      return new SpecialistRuntime(
        config as never,
        prisma as never,
        orchestrator as never,
        { publish: jest.fn() } as never,
        new VerificationLedger(prisma as never, config as never),
        grounding,
      );
    };

    const verify = async (bot = botA) => {
      const conversationId = `conv-${run}-${++counter}`;
      const outcome = await runtime().run({
        tenantId,
        botConfigId: bot,
        conversationId,
        capability: CAP,
        image: randomBytes(64),
        contactAddress: PHONE,
      });
      if (!outcome.executed) throw new Error(`no ejecutó: ${outcome.reason}`);
      return { result: outcome.result, conversationId };
    };

    beforeAll(async () => {
      prisma = createTestPrisma(infra!.databaseUrl);

      server = createServer((req, res) => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
        });
        if (behavior === 'slow') return;
        res.setHeader('content-type', 'application/json');
        if (behavior === 'error') {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: true }));
          return;
        }
        res.end(JSON.stringify({ data: { anticipo: { monto: '30000' } } }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      await prisma.tenant.create({
        data: { id: tenantId, name: tenantId, slug: tenantId },
      });
      const bot = (name: string) =>
        prisma.botConfig
          .create({ data: { tenantId, name, systemPrompt: 'x' } })
          .then((b) => b.id);
      botA = await bot('A');
      botB = await bot('B');

      const specialist = await prisma.specialist.create({
        data: {
          tenantId,
          key: 'comprobantes',
          name: 'Comprobantes',
          capability: CAP,
          status: 'ACTIVE',
          promptTemplate: 'Comprobantes de anticipo.',
          rules: {
            version: 1,
            rules: [
              {
                field: 'amount',
                op: 'gte',
                ref: 'grounding.minimo',
                onFail: 'INVALID',
              },
              {
                field: 'recipient',
                op: 'fuzzy',
                ref: 'grounding.titular',
                onFail: 'NEEDS_REVIEW',
              },
            ],
          },
          contextSources: {
            version: 1,
            sources: [
              {
                key: 'minimo',
                kind: 'TOOL',
                name: 'consultar_anticipo',
                valuePath: 'data.anticipo.monto',
                maxAgeSeconds: 60,
                required: false,
              },
              {
                key: 'titular',
                kind: 'EXTERNAL_MAPPING',
                name: 'vars.titular',
                maxAgeSeconds: 0,
                required: false,
              },
            ],
          },
        },
      });
      await prisma.botSpecialistBinding.create({
        data: {
          tenantId,
          botConfigId: botA,
          capability: CAP,
          specialistId: specialist.id,
          mode: 'SHADOW',
        },
      });

      toolId = (
        await prisma.toolDefinition.create({
          data: {
            botConfigId: botA,
            name: 'consultar_anticipo',
            description: 'Consulta el anticipo',
            parametersSchema: { type: 'object', properties: {} },
            endpointUrl: `${baseUrl}/anticipo`,
            httpMethod: 'GET',
            injectPhoneParamName: 'phone',
          },
        })
      ).id;
      await prisma.externalVariable.create({
        data: {
          botConfigId: botA,
          namespace: 'vars',
          key: 'titular',
          value: 'Spa Demo',
        },
      });
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.verificationRecord.deleteMany({ where: { tenantId } });
      await prisma.botSpecialistBinding.deleteMany({ where: { tenantId } });
      await prisma.specialist.deleteMany({ where: { tenantId } });
      await prisma.externalVariable.deleteMany({
        where: { botConfig: { tenantId } },
      });
      await prisma.toolDefinition.deleteMany({
        where: { botConfig: { tenantId } },
      });
      await prisma.botConfig.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      await prisma.$disconnect();
    });

    beforeEach(() => {
      seen.length = 0;
      behavior = 'ok';
      modelContent = extraction();
      jest.clearAllMocks();
    });

    it('cumple las reglas con el monto de la herramienta y el titular del mapeo', async () => {
      const { result } = await verify();
      expect(result).toMatchObject({
        verdict: 'VALID',
        reasonCodes: ['RULES_PASSED'],
      });
    });

    it('consulta la herramienta con GET, el teléfono del chat y la conversación', async () => {
      const { conversationId } = await verify();

      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('GET');
      expect(seen[0].url).toContain('/anticipo');
      expect(seen[0].url).toContain(`phone=${PHONE}`);
      expect(seen[0].headers['x-conduit-contact-phone']).toBe(`+${PHONE}`);
      expect(seen[0].headers['x-conduit-conversation-id']).toBe(conversationId);
    });

    it('un monto menor al del negocio es INVALID', async () => {
      modelContent = extraction({ amount: 20000 });
      const { result } = await verify();
      expect(result).toMatchObject({
        verdict: 'INVALID',
        reasonCodes: ['AMOUNT_GTE_FAILED'],
      });
    });

    it('un titular distinto al del mapeo pide revisión', async () => {
      modelContent = extraction({ recipient: 'Juan Gomez' });
      const { result } = await verify();
      expect(result).toMatchObject({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['RECIPIENT_FUZZY_FAILED'],
      });
    });

    it('si la herramienta responde 500, pide revisión y nunca da VALID', async () => {
      behavior = 'error';
      const { result } = await verify();
      expect(result.verdict).toBe('NEEDS_REVIEW');
      expect(result.reasonCodes).toEqual(['GROUNDING_UNAVAILABLE']);
    });

    it('si la herramienta no responde a tiempo, corta y pide revisión sin colgar el turno', async () => {
      behavior = 'slow';
      const started = Date.now();
      const { result } = await verify();
      expect(Date.now() - started).toBeLessThan(4000);
      expect(result.verdict).toBe('NEEDS_REVIEW');
      expect(result.reasonCodes).toEqual(['GROUNDING_UNAVAILABLE']);
    });

    it('un mapeo inexistente o vencido pide revisión', async () => {
      await prisma.externalVariable.update({
        where: {
          botConfigId_namespace_key: {
            botConfigId: botA,
            namespace: 'vars',
            key: 'titular',
          },
        },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      try {
        const { result } = await verify();
        expect(result.verdict).toBe('NEEDS_REVIEW');
        expect(result.reasonCodes).toEqual(['GROUNDING_UNAVAILABLE']);
      } finally {
        await prisma.externalVariable.update({
          where: {
            botConfigId_namespace_key: {
              botConfigId: botA,
              namespace: 'vars',
              key: 'titular',
            },
          },
          data: { expiresAt: null },
        });
      }
    });

    it('una herramienta que ya no es de solo lectura jamás se ejecuta como contexto', async () => {
      await prisma.toolDefinition.update({
        where: { id: toolId },
        data: { httpMethod: 'POST' },
      });
      try {
        const { result } = await verify();
        expect(seen).toHaveLength(0);
        expect(result.verdict).toBe('NEEDS_REVIEW');
      } finally {
        await prisma.toolDefinition.update({
          where: { id: toolId },
          data: { httpMethod: 'GET' },
        });
      }
    });

    it('una herramienta desactivada no se usa', async () => {
      await prisma.toolDefinition.update({
        where: { id: toolId },
        data: { isActive: false },
      });
      try {
        const { result } = await verify();
        expect(seen).toHaveLength(0);
        expect(result.verdict).toBe('NEEDS_REVIEW');
      } finally {
        await prisma.toolDefinition.update({
          where: { id: toolId },
          data: { isActive: true },
        });
      }
    });

    it('dos verificaciones de la misma conversación dentro de la vigencia consultan una sola vez', async () => {
      const conversationId = `conv-${run}-cache`;
      const shared = runtime();
      const go = () =>
        shared.run({
          tenantId,
          botConfigId: botA,
          conversationId,
          capability: CAP,
          image: randomBytes(64),
          contactAddress: PHONE,
        });
      await go();
      await go();
      expect(seen).toHaveLength(1);
    });

    it('otra conversación consulta de nuevo', async () => {
      await verify();
      await verify();
      expect(seen).toHaveLength(2);
    });

    it('las herramientas de otro bot no se usan para este bot', async () => {
      const other = await prisma.specialist.create({
        data: {
          tenantId,
          key: 'otro-bot',
          name: 'otro',
          capability: 'other-cap',
          status: 'ACTIVE',
          promptTemplate: 'p',
          rules: {
            version: 1,
            rules: [
              {
                field: 'amount',
                op: 'gte',
                ref: 'grounding.minimo',
                onFail: 'INVALID',
              },
            ],
          },
          contextSources: {
            version: 1,
            sources: [
              {
                key: 'minimo',
                kind: 'TOOL',
                name: 'consultar_anticipo',
                valuePath: 'data.anticipo.monto',
                maxAgeSeconds: 0,
                required: false,
              },
            ],
          },
        },
      });
      await prisma.botSpecialistBinding.create({
        data: {
          tenantId,
          botConfigId: botB,
          capability: 'other-cap',
          specialistId: other.id,
          mode: 'SHADOW',
        },
      });
      const outcome = await runtime().run({
        tenantId,
        botConfigId: botB,
        conversationId: `conv-${run}-b`,
        capability: 'other-cap',
        image: randomBytes(64),
        contactAddress: PHONE,
      });

      expect(seen).toHaveLength(0);
      expect(outcome.executed && outcome.result.reasonCodes).toEqual([
        'GROUNDING_UNAVAILABLE',
      ]);
    });
  },
);
