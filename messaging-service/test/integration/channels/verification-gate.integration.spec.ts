jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';
import { SpecialistVerificationService } from 'src/bot/specialists/admin/SpecialistVerificationService';
import { VerificationLedger } from 'src/bot/specialists/VerificationLedger';
import { hashImage } from 'src/bot/specialists/image-hash';
import {
  ToolExecutorService,
  VERIFICATION_HEADER,
  VERIFICATION_SIGNATURE_HEADER,
} from 'src/bot/tools/ToolExecutor.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';
import { LEGACY_IMAGE_OUTPUT_SCHEMA } from 'src/bot/specialists/backfill/backfill-specialists';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const CAP = 'image-analysis';
const HOUR_MS = 3_600_000;

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, any>;
}

suite(
  'Puerta de verificación contra la base, el libro y un backend HTTP real',
  () => {
    const run = randomUUID().slice(0, 8);
    const tenantA = `it-v-${run}`;
    const tenantB = `it-w-${run}`;
    const secret = randomBytes(16).toString('hex');
    let prisma: PrismaClient;
    let server: Server;
    let botA: string;
    let specA: string;
    let specB: string;
    let strictTool: string;
    let tolerantTool: string;
    let counter = 0;
    const seen: Seen[] = [];
    let behavior: 'ok' | 'rechaza' | 'falla' = 'ok';

    const config = {
      get: (key: string) =>
        ({
          'webhook.encryptionKey': randomBytes(32).toString('hex'),
          'specialists.enabled': true,
          'specialists.retentionDays': 30,
          'specialists.passportTtlMinutes': 60,
          'specialists.groundingTimeoutMs': 1500,
        })[key],
    };
    const encryption = new SecretEncryptionService(config as never);
    encryption.onModuleInit();
    const ledger = () =>
      new VerificationLedger(prisma as never, config as never);
    const executor = () =>
      new ToolExecutorService(prisma as never, encryption, ledger());

    const png = (seed: number) =>
      sharp(randomBytes(64 * 64 * 3), {
        raw: { width: 64, height: 64, channels: 3 },
      })
        .modulate({ brightness: seed })
        .png()
        .toBuffer();
    const uri = (image: Buffer) =>
      `data:image/jpeg;base64,${image.toString('base64')}`;
    const nextConversation = async () =>
      (
        await prisma.conversation.create({
          data: {
            tenantId: tenantA,
            botConfigId: botA,
            phoneNumber: `5730${String(++counter).padStart(8, '0')}`,
          },
        })
      ).id;

    const record = async (
      image: Buffer,
      over: {
        tenantId?: string;
        specialistId?: string;
        conversationId: string;
        verdict?: 'VALID' | 'NEEDS_REVIEW' | 'INVALID';
        mode?: 'ACTIVE' | 'SHADOW';
        createdAt?: Date;
      },
    ) =>
      prisma.verificationRecord.create({
        data: {
          tenantId: over.tenantId ?? tenantA,
          conversationId: over.conversationId,
          botConfigId: botA,
          specialistId: over.specialistId ?? specA,
          capability: CAP,
          subjectHash: (await hashImage(image)).hash,
          hashVersion: 2,
          verdict: over.verdict ?? 'VALID',
          confidence: 0.9,
          fields: {
            amount: 150000,
            currency: 'COP',
            reference: 'TRX-48210377',
          },
          reasonCodes: ['RULES_PASSED'],
          mode: over.mode ?? 'ACTIVE',
          createdAt: over.createdAt ?? new Date(),
          expiresAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
        },
      });

    const call = (
      image: Buffer,
      conversationId: string,
      tool = strictTool,
      params: Record<string, unknown> = {},
    ) =>
      executor().execute({
        toolDefinitionId: tool,
        conversationId,
        params,
        attachedImage: {
          dataUri: uri(image),
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        },
        imageParamName: 'imageBase64',
      });

    const consumedAt = async (id: string) =>
      (await prisma.verificationRecord.findUniqueOrThrow({ where: { id } }))
        .consumedAt;

    beforeAll(async () => {
      prisma = createTestPrisma(infra!.databaseUrl);

      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let body: Record<string, any> = {};
          try {
            body = JSON.parse(
              Buffer.concat(chunks).toString() || '{}',
            ) as Record<string, any>;
          } catch {
            body = {};
          }
          seen.push({ headers: req.headers, body });
          res.setHeader('content-type', 'application/json');
          res.statusCode =
            behavior === 'rechaza' ? 400 : behavior === 'falla' ? 500 : 200;
          res.end(JSON.stringify({ ok: behavior === 'ok' }));
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      for (const id of [tenantA, tenantB]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
      }
      botA = (
        await prisma.botConfig.create({
          data: { tenantId: tenantA, name: 'A', systemPrompt: 'x' },
        })
      ).id;
      const spec = (tenantId: string) =>
        prisma.specialist
          .create({
            data: {
              tenantId,
              key: 'imagen',
              name: 'imagen',
              capability: CAP,
              status: 'ACTIVE',
              outputSchema: LEGACY_IMAGE_OUTPUT_SCHEMA,
              promptTemplate: 'Comprobantes.',
            },
          })
          .then((s) => s.id);
      specA = await spec(tenantA);
      specB = await spec(tenantB);

      const tool = (name: string, verdicts: Array<'VALID' | 'NEEDS_REVIEW'>) =>
        prisma.toolDefinition
          .create({
            data: {
              botConfigId: botA,
              name,
              description: name,
              parametersSchema: { type: 'object', properties: {} },
              endpointUrl: `${baseUrl}/subir`,
              httpMethod: 'POST',
              authHeaderName: 'X-Api-Key',
              authSecretEncrypted: encryption.encrypt(secret),
              requiresImageAttachment: true,
              imageParamName: 'imageBase64',
              verificationCapability: CAP,
              acceptedVerdicts: verdicts,
              verificationParamName: 'verificacion',
            },
          })
          .then((t) => t.id);
      strictTool = await tool('subir_estricta', ['VALID']);
      tolerantTool = await tool('subir_tolerante', ['VALID', 'NEEDS_REVIEW']);
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const tenants = [tenantA, tenantB];
      await prisma.toolInvocation.deleteMany({
        where: { toolDefinition: { botConfig: { tenantId: { in: tenants } } } },
      });
      await prisma.verificationRecord.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.conversation.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.botSpecialistBinding.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.toolDefinition.deleteMany({
        where: { botConfig: { tenantId: { in: tenants } } },
      });
      await prisma.specialist.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.botConfig.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
      await prisma.$disconnect();
    });

    beforeEach(() => {
      seen.length = 0;
      behavior = 'ok';
    });

    it('con un veredicto aprobado ejecuta, entrega el pasaporte firmado y deja el veredicto consumido', async () => {
      const image = await png(1);
      const conversationId = await nextConversation();
      const saved = await record(image, { conversationId });

      const outcome = await call(image, conversationId);

      expect(outcome.status).toBe('SUCCESS');
      expect(seen).toHaveLength(1);
      const headers = seen[0].headers;
      const payload = headers[VERIFICATION_HEADER.toLowerCase()] as string;
      const signature = headers[
        VERIFICATION_SIGNATURE_HEADER.toLowerCase()
      ] as string;
      expect(signature).toBe(
        createHmac('sha256', secret).update(payload).digest('hex'),
      );

      const passport = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      ) as Record<string, any>;
      expect(passport).toMatchObject({
        verificationId: saved.id,
        verdict: 'VALID',
        capability: CAP,
        tenantId: tenantA,
        conversationId,
        hash: saved.subjectHash,
      });
      expect((passport.fields as { amount: number }).amount).toBe(150000);

      expect(seen[0].body.imageBase64).toBe(uri(image));
      expect(seen[0].body.verificacion).toEqual({ payload, signature });
      expect(await consumedAt(saved.id)).not.toBeNull();
    });

    it('el mismo veredicto no sirve una segunda vez', async () => {
      const image = await png(2);
      const conversationId = await nextConversation();
      await record(image, { conversationId });

      expect((await call(image, conversationId)).status).toBe('SUCCESS');
      const second = await call(image, conversationId);

      expect(second).toMatchObject({
        status: 'BUSINESS_ERROR',
        httpStatus: 422,
        responseBody: { code: 'VERIFICATION_REQUIRED' },
      });
      expect(seen).toHaveLength(1);
    });

    it('una imagen distinta a la verificada se rechaza y no gasta el veredicto', async () => {
      const verified = await png(3);
      const other = await png(4);
      const conversationId = await nextConversation();
      const saved = await record(verified, { conversationId });

      const outcome = await call(other, conversationId);

      expect(outcome.status).toBe('BUSINESS_ERROR');
      expect(seen).toHaveLength(0);
      expect(await consumedAt(saved.id)).toBeNull();
    });

    it('sin ningún veredicto se rechaza', async () => {
      const outcome = await call(await png(5), await nextConversation());
      expect(outcome.responseBody).toMatchObject({
        code: 'VERIFICATION_REQUIRED',
      });
      expect(seen).toHaveLength(0);
    });

    it('un veredicto de SHADOW nunca autoriza', async () => {
      const image = await png(6);
      const conversationId = await nextConversation();
      await record(image, { conversationId, mode: 'SHADOW' });
      expect((await call(image, conversationId)).status).toBe('BUSINESS_ERROR');
      expect(seen).toHaveLength(0);
    });

    it('una revisión humana aprobada no habilita la herramienta estricta ni gasta el veredicto', async () => {
      const image = await png(41);
      const conversationId = await nextConversation();
      const saved = await record(image, {
        conversationId,
        verdict: 'NEEDS_REVIEW',
      });
      await new SpecialistVerificationService(
        prisma as never,
        {} as never,
        config as never,
      ).review(tenantA, 'user-1', saved.id, { decision: 'APPROVED' });

      const outcome = await call(image, conversationId, strictTool);

      expect(outcome).toMatchObject({
        status: 'BUSINESS_ERROR',
        responseBody: { code: 'VERIFICATION_REQUIRED' },
      });
      expect(seen).toHaveLength(0);
      expect(await consumedAt(saved.id)).toBeNull();
      const after = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id: saved.id },
      });
      expect(after.verdict).toBe('NEEDS_REVIEW');
    });

    it('un veredicto no listado se rechaza: NEEDS_REVIEW solo pasa en la herramienta que lo acepta', async () => {
      const image = await png(7);
      const conversationId = await nextConversation();
      await record(image, { conversationId, verdict: 'NEEDS_REVIEW' });

      expect((await call(image, conversationId, strictTool)).status).toBe(
        'BUSINESS_ERROR',
      );
      expect(seen).toHaveLength(0);

      expect((await call(image, conversationId, tolerantTool)).status).toBe(
        'SUCCESS',
      );
      const payload = seen[0].headers[
        VERIFICATION_HEADER.toLowerCase()
      ] as string;
      expect(
        (
          JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
            verdict: string;
          }
        ).verdict,
      ).toBe('NEEDS_REVIEW');
    });

    it('un INVALID jamás habilita una herramienta', async () => {
      const image = await png(8);
      const conversationId = await nextConversation();
      await record(image, { conversationId, verdict: 'INVALID' });
      expect((await call(image, conversationId, tolerantTool)).status).toBe(
        'BUSINESS_ERROR',
      );
    });

    it('un veredicto fuera de su vigencia no sirve', async () => {
      const image = await png(9);
      const conversationId = await nextConversation();
      await record(image, {
        conversationId,
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
      });
      expect((await call(image, conversationId)).status).toBe('BUSINESS_ERROR');
      expect(seen).toHaveLength(0);
    });

    it('no sirve desde otra conversación ni con el veredicto de otro tenant', async () => {
      const image = await png(10);
      const conversationId = await nextConversation();
      await record(image, { conversationId });
      expect((await call(image, await nextConversation())).status).toBe(
        'BUSINESS_ERROR',
      );

      const foreign = await png(11);
      const foreignConversation = await nextConversation();
      await record(foreign, {
        conversationId: foreignConversation,
        tenantId: tenantB,
        specialistId: specB,
      });
      expect((await call(foreign, foreignConversation)).status).toBe(
        'BUSINESS_ERROR',
      );
      expect(seen).toHaveLength(0);
    });

    it('el modelo no puede suplantar el pasaporte ni la imagen con sus parámetros', async () => {
      const image = await png(12);
      const conversationId = await nextConversation();
      await record(image, { conversationId });

      await call(image, conversationId, strictTool, {
        verificacion: 'APROBADO POR EL MODELO',
        imageBase64: 'data:image/png;base64,AAAA',
      });

      expect(seen[0].body.imageBase64).toBe(uri(image));
      expect(seen[0].body.verificacion).toMatchObject({
        payload: seen[0].headers[VERIFICATION_HEADER.toLowerCase()],
      });
      expect(JSON.stringify(seen[0].body)).not.toContain(
        'APROBADO POR EL MODELO',
      );
    });

    it('cinco llamadas simultáneas con el mismo veredicto ejecutan una sola vez', async () => {
      const image = await png(13);
      const conversationId = await nextConversation();
      await record(image, { conversationId });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => call(image, conversationId)),
      );

      expect(outcomes.filter((o) => o.status === 'SUCCESS')).toHaveLength(1);
      expect(seen).toHaveLength(1);
    });

    it('si el backend rechaza de forma definitiva (400), el veredicto se libera y se puede reintentar', async () => {
      const image = await png(14);
      const conversationId = await nextConversation();
      const saved = await record(image, { conversationId });

      behavior = 'rechaza';
      expect((await call(image, conversationId)).status).toBe('BUSINESS_ERROR');
      expect(await consumedAt(saved.id)).toBeNull();

      behavior = 'ok';
      expect((await call(image, conversationId)).status).toBe('SUCCESS');
      expect(await consumedAt(saved.id)).not.toBeNull();
    });

    it('si el resultado es ambiguo (500), el veredicto queda consumido y no se reintenta solo', async () => {
      const image = await png(15);
      const conversationId = await nextConversation();
      const saved = await record(image, { conversationId });

      behavior = 'falla';
      expect((await call(image, conversationId)).status).toBe(
        'TECHNICAL_ERROR',
      );
      expect(await consumedAt(saved.id)).not.toBeNull();

      behavior = 'ok';
      const retry = await call(image, conversationId);
      expect(retry.responseBody).toMatchObject({
        code: 'VERIFICATION_REQUIRED',
      });
      expect(seen).toHaveLength(1);
    });

    it('una herramienta sin verificación se ejecuta sin consultar el libro', async () => {
      const plain = await prisma.toolDefinition.create({
        data: {
          botConfigId: botA,
          name: `normal_${run}`,
          description: 'normal',
          parametersSchema: { type: 'object', properties: {} },
          endpointUrl: (
            await prisma.toolDefinition.findUniqueOrThrow({
              where: { id: strictTool },
            })
          ).endpointUrl,
          httpMethod: 'POST',
          requiresImageAttachment: true,
        },
      });
      const outcome = await call(
        await png(16),
        await nextConversation(),
        plain.id,
      );
      expect(outcome.status).toBe('SUCCESS');
      expect(
        seen[0].headers[VERIFICATION_HEADER.toLowerCase()],
      ).toBeUndefined();
    });

    it('una herramienta con verificación llamada sin imagen (por ejemplo desde otro flujo) se rechaza', async () => {
      const outcome = await executor().execute({
        toolDefinitionId: strictTool,
        conversationId: await nextConversation(),
        params: { imageBase64: 'data:image/png;base64,AAAA' },
      });
      expect(outcome.responseBody).toMatchObject({
        code: 'VERIFICATION_REQUIRED',
      });
      expect(seen).toHaveLength(0);
    });

    describe('ciclo completo: especialista, herramienta y reenvío', () => {
      let reference = 'TRX-00000000';
      const extraction = () =>
        JSON.stringify({
          version: 2,
          confidence: 0.9,
          isExpectedDocument: true,
          legibility: 'CLEAR',
          variables: {
            amount: 150000,
            currency: 'COP',
            date: '2026-11-08',
            reference,
            recipient: 'Spa Demo',
          },
        });
      const orchestrator = {
        analyzeImageForSpecialist: jest.fn(() =>
          Promise.resolve({
            content: extraction(),
            tokensUsed: 5,
            modelUsed: 'm',
          }),
        ),
      };
      const runtime = () =>
        new SpecialistRuntime(
          config as never,
          prisma as never,
          orchestrator as never,
          { publish: jest.fn() } as never,
          ledger(),
          {
            resolve: () =>
              Promise.resolve({
                values: {},
                unavailable: [],
                requiredUnavailable: false,
              }),
          } as never,
        );

      beforeAll(async () => {
        await prisma.botSpecialistBinding.create({
          data: {
            tenantId: tenantA,
            botConfigId: botA,
            capability: CAP,
            specialistId: specA,
            mode: 'ACTIVE',
          },
        });
      });

      it('verificar, usar la herramienta y bloquear cualquier reenvío del mismo comprobante', async () => {
        reference = `TRX-A-${run}`;
        const image = await png(17);
        const recompressed = await sharp(image)
          .jpeg({ quality: 70 })
          .toBuffer();
        const conversationId = await nextConversation();
        const verify = (img: Buffer, conversation = conversationId) =>
          runtime().run({
            tenantId: tenantA,
            botConfigId: botA,
            conversationId: conversation,
            capability: CAP,
            image: img,
          });

        const first = await verify(image);
        expect(first.executed && first.result.verdict).toBe('VALID');

        expect((await call(image, conversationId)).status).toBe('SUCCESS');
        expect(seen).toHaveLength(1);

        const again = await verify(image);
        expect(again.executed && again.result).toMatchObject({
          verdict: 'INVALID',
          reasonCodes: ['ALREADY_USED'],
        });
        const resentRecompressed = await verify(recompressed);
        expect(
          resentRecompressed.executed && resentRecompressed.result.verdict,
        ).toBe('INVALID');
        const otherChat = await verify(image, await nextConversation());
        expect(otherChat.executed && otherChat.result.verdict).toBe('INVALID');

        expect((await call(image, conversationId)).status).toBe(
          'BUSINESS_ERROR',
        );
        expect(seen).toHaveLength(1);
      });

      it('un comprobante usado por otra clienta antes de consumirse pasa a revisión y no habilita la herramienta estricta', async () => {
        reference = `TRX-B-${run}`;
        const image = await png(18);
        const firstChat = await nextConversation();
        const secondChat = await nextConversation();
        const verify = (conversation: string) =>
          runtime().run({
            tenantId: tenantA,
            botConfigId: botA,
            conversationId: conversation,
            capability: CAP,
            image,
          });

        expect((await verify(firstChat)).executed).toBe(true);
        const second = await verify(secondChat);

        expect(second.executed && second.result).toMatchObject({
          verdict: 'NEEDS_REVIEW',
          reasonCodes: ['REUSED_OTHER_CONTACT'],
        });
        expect((await call(image, secondChat, strictTool)).status).toBe(
          'BUSINESS_ERROR',
        );
        expect(seen).toHaveLength(0);
      });
    });
  },
);
