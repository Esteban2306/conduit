import { readFileSync } from 'fs';
import { join } from 'path';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { ESCALATION_TRIGGERS } from 'src/bot/admin/dto/conversation-admin.dto';
import { SpecialistVerificationController } from 'src/bot/specialists/admin/SpecialistVerification.controller';
import { SpecialistVerificationService } from 'src/bot/specialists/admin/SpecialistVerificationService';
import { reviewVerificationSchema } from 'src/bot/specialists/admin/specialist-verification.schemas';
import { BotEscalationService } from 'src/bot/tools/BotEscalation.service';

const alert = (over: Partial<Record<string, unknown>> = {}) => ({
  tenantId: 't1',
  botConfigId: 'b1',
  conversationId: 'conv-1',
  contactAddress: '573001112233',
  verdict: 'NEEDS_REVIEW',
  reasonCodes: ['LOW_CONFIDENCE'],
  recordId: 'rec-1',
  ...over,
});

function buildEscalation(
  contacts: Array<{ notifyOn: unknown; connectionId?: string | null }>,
  throttleMinutes?: number,
  dispatchFails = false,
) {
  const prisma = {
    botEscalationContact: {
      findMany: jest.fn(() =>
        Promise.resolve(
          contacts.map((c, i) => ({
            label: `c${i}`,
            phoneNumber: `57300000000${i}`,
            connectionId:
              c.connectionId === undefined ? 'conn' : c.connectionId,
            notifyOn: c.notifyOn,
          })),
        ),
      ),
    },
  };
  const orchestrator = {
    dispatch: jest.fn(() =>
      dispatchFails ? Promise.reject(new Error('caída')) : Promise.resolve({}),
    ),
  };
  const config = {
    get: (key: string) =>
      key === 'specialists.reviewAlertThrottleMinutes'
        ? throttleMinutes
        : undefined,
  };
  const service = new BotEscalationService(
    prisma as never,
    orchestrator as never,
    config as never,
  );
  (service as unknown as { logger: object }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { service, orchestrator };
}

describe('aviso de imagen pendiente de revisión', () => {
  it('VERIFICATION_REVIEW es un disparador válido', () => {
    expect(ESCALATION_TRIGGERS).toContain('VERIFICATION_REVIEW');
  });

  it('avisa solo a los contactos que lo pidieron', async () => {
    const { service, orchestrator } = buildEscalation([
      { notifyOn: ['TECHNICAL_ERROR'] },
      { notifyOn: ['VERIFICATION_REVIEW'] },
      { notifyOn: ['TECHNICAL_ERROR', 'VERIFICATION_REVIEW'] },
    ]);
    expect(await service.notifyVerificationReview(alert() as never)).toBe(true);
    const recipients = orchestrator.dispatch.mock.calls.map(
      (call) =>
        (call as unknown as [string, { recipient: { address: string } }])[1]
          .recipient.address,
    );
    expect(recipients).toEqual(['573000000001', '573000000002']);
  });

  it('el mensaje trae cliente, resultado, motivos y la verificación, sin datos extraídos', async () => {
    const { service, orchestrator } = buildEscalation([
      { notifyOn: ['VERIFICATION_REVIEW'] },
    ]);
    await service.notifyVerificationReview(
      alert({
        reasonCodes: ['LOW_CONFIDENCE', 'AMOUNT_UNCLEAR'],
        fields: { amount: 999999, reference: 'SECRETO-123' },
      }),
    );
    const body = (
      orchestrator.dispatch.mock.calls[0] as unknown as [
        string,
        { template: { inline: { body: string } } },
      ]
    )[1].template.inline.body;
    expect(body).toContain('573001112233');
    expect(body).toContain('NEEDS_REVIEW');
    expect(body).toContain('LOW_CONFIDENCE, AMOUNT_UNCLEAR');
    expect(body).toContain('rec-1');
    expect(body).not.toMatch(/999999|SECRETO/);
  });

  it('no repite el aviso de la misma conversación dentro de la ventana', async () => {
    const { service, orchestrator } = buildEscalation([
      { notifyOn: ['VERIFICATION_REVIEW'] },
    ]);
    expect(await service.notifyVerificationReview(alert() as never)).toBe(true);
    expect(await service.notifyVerificationReview(alert() as never)).toBe(
      false,
    );
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
  });

  it('otra conversación o el mismo id en otro tenant sí avisa', async () => {
    const { service, orchestrator } = buildEscalation([
      { notifyOn: ['VERIFICATION_REVIEW'] },
    ]);
    await service.notifyVerificationReview(alert());
    await service.notifyVerificationReview(alert({ conversationId: 'conv-2' }));
    await service.notifyVerificationReview(alert({ tenantId: 't2' }));
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(3);
  });

  it('pasada la ventana vuelve a avisar', async () => {
    jest.useFakeTimers();
    try {
      const { service, orchestrator } = buildEscalation(
        [{ notifyOn: ['VERIFICATION_REVIEW'] }],
        10,
      );
      await service.notifyVerificationReview(alert());
      jest.advanceTimersByTime(9 * 60_000);
      await service.notifyVerificationReview(alert());
      expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(61_000);
      await service.notifyVerificationReview(alert());
      expect(orchestrator.dispatch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('si nadie recibió el aviso, no consume la ventana y se reintenta', async () => {
    const none = buildEscalation([{ notifyOn: ['TECHNICAL_ERROR'] }]);
    expect(await none.service.notifyVerificationReview(alert() as never)).toBe(
      false,
    );
    expect(await none.service.notifyVerificationReview(alert() as never)).toBe(
      false,
    );

    const failing = buildEscalation(
      [{ notifyOn: ['VERIFICATION_REVIEW'] }],
      undefined,
      true,
    );
    await failing.service.notifyVerificationReview(alert());
    await failing.service.notifyVerificationReview(alert());
    expect(failing.orchestrator.dispatch).toHaveBeenCalledTimes(2);
  });

  it('un fallo inesperado de la consulta no revienta al llamador', async () => {
    const { service } = buildEscalation([
      { notifyOn: ['VERIFICATION_REVIEW'] },
    ]);
    (
      service as unknown as { notifyContacts: () => Promise<boolean> }
    ).notifyContacts = () => Promise.reject(new Error('db'));
    await expect(
      service.notifyVerificationReview(alert() as never),
    ).resolves.toBe(false);
  });
});

describe('revisión humana: solo constancia', () => {
  const buildReview = (
    found: { verdict: string; reviewedAt: Date | null } | null,
    updated = 1,
  ) => {
    const prisma = {
      verificationRecord: {
        findFirst: jest.fn(() => Promise.resolve(found)),
        updateMany: jest.fn(() => Promise.resolve({ count: updated })),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new SpecialistVerificationService(
      prisma as never,
      {} as never,
      { get: () => undefined } as never,
    );
    jest
      .spyOn(service, 'get')
      .mockResolvedValue({ id: 'v1', reviewDecision: 'APPROVED' } as never);
    return { service, prisma };
  };

  it('registra decisión, nota y quién la tomó, solo en esos campos', async () => {
    const { service, prisma } = buildReview({
      verdict: 'NEEDS_REVIEW',
      reviewedAt: null,
    });
    await service.review('t1', 'user-9', 'v1', {
      decision: 'APPROVED',
      note: 'Comprobante correcto',
    });
    const call = (
      prisma.verificationRecord.updateMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ]
    )[0];
    expect(Object.keys(call.data).sort()).toEqual([
      'reviewDecision',
      'reviewNote',
      'reviewedAt',
      'reviewedBy',
    ]);
    expect(call.data).toMatchObject({
      reviewedBy: 'user-9',
      reviewDecision: 'APPROVED',
      reviewNote: 'Comprobante correcto',
    });
    expect(call.where).toMatchObject({
      id: 'v1',
      tenantId: 't1',
      reviewedAt: null,
    });
    expect(prisma.verificationRecord.update).not.toHaveBeenCalled();
  });

  it.each(['VALID', 'INVALID'])(
    'un resultado %s no se revisa (409)',
    async (verdict) => {
      const { service, prisma } = buildReview({ verdict, reviewedAt: null });
      await expect(
        service.review('t1', 'u', 'v1', { decision: 'APPROVED' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { details: { code: 'NOT_REVIEWABLE' } },
      });
      expect(prisma.verificationRecord.updateMany).not.toHaveBeenCalled();
    },
  );

  it('una verificación ya revisada da 409 y no se sobrescribe', async () => {
    const { service } = buildReview(
      { verdict: 'NEEDS_REVIEW', reviewedAt: new Date() },
      0,
    );
    await expect(
      service.review('t1', 'u', 'v1', { decision: 'REJECTED' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { details: { code: 'ALREADY_REVIEWED' } },
    });
  });

  it('una verificación de otro tenant da 404', async () => {
    const { service, prisma } = buildReview(null);
    await expect(
      service.review('t1', 'u', 'v1', { decision: 'APPROVED' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.verificationRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1', tenantId: 't1' } }),
    );
  });

  it.each([
    {},
    { decision: 'MAYBE' },
    { decision: 'APPROVED', verdict: 'VALID' },
    { decision: 'APPROVED', note: 'x'.repeat(501) },
    { decision: 'APPROVED', note: 'línea\nfalsa' },
    { decision: 'APPROVED', reviewedBy: 'otro' },
  ])('rechaza el cuerpo %j', (body) => {
    expect(reviewVerificationSchema.safeParse(body).success).toBe(false);
  });

  it('exige propietario o administrador', () => {
    const proto =
      SpecialistVerificationController.prototype as unknown as Record<
        string,
        object
      >;
    expect(
      (Reflect.getMetadata(GUARDS_METADATA, proto.review) as unknown[]) ?? [],
    ).toContain(TenantAdminGuard);
  });

  it('delega con el usuario y el tenant del token', () => {
    const verifications = { review: jest.fn() };
    const controller = new SpecialistVerificationController(
      verifications as never,
      {} as never,
    );
    controller.review(
      { sub: 'user-9', tenantId: 'tenant-token', role: 'ADMIN' },
      'v1',
      { decision: 'APPROVED' },
    );
    expect(verifications.review).toHaveBeenCalledWith(
      'tenant-token',
      'user-9',
      'v1',
      { decision: 'APPROVED' },
    );
  });

  it('la puerta de las herramientas nunca lee la revisión humana', () => {
    const files = [
      'src/bot/tools/ToolExecutor.service.ts',
      'src/bot/specialists/VerificationLedger.ts',
      'src/bot/specialists/facts.ts',
    ];
    for (const file of files) {
      const text = readFileSync(join(__dirname, '../../..', file), 'utf8');
      expect(text).not.toMatch(/reviewedAt|reviewDecision|reviewedBy/);
    }
  });
});
