jest.mock('src/bot/helper/ImageOptimizer', () => ({
  ImageOptimizer: {
    optimizeForExtraction: (buffer: Buffer) => Promise.resolve(buffer),
  },
}));

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  bankFingerprint,
  loadBank,
  sha256,
} from 'src/bot/specialists/evaluation/eval-case';
import {
  compareRuns,
  parseRun,
} from 'src/bot/specialists/evaluation/eval-compare';
import {
  formatComparison,
  formatRun,
} from 'src/bot/specialists/evaluation/eval-report';
import { runEvaluation } from 'src/bot/specialists/evaluation/eval-run';
import {
  compareFields,
  fieldEquals,
  percentile,
  scoreCase,
  summarize,
} from 'src/bot/specialists/evaluation/eval-scoring';
import { buildPriceTable } from 'src/bot/specialists/pricing';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';

const png = (seed: number) =>
  sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: seed, g: seed, b: seed },
    },
  })
    .png()
    .toBuffer();

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-bank-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const addCase = async (
  name: string,
  seed: number,
  expected: unknown = { verdict: 'VALID' },
) => {
  await fs.writeFile(path.join(dir, `${name}.png`), await png(seed));
  await fs.writeFile(
    path.join(dir, `${name}.expected.json`),
    JSON.stringify(expected),
  );
};

describe('banco de evaluación: carga y validación', () => {
  it('carga los casos ordenados con su esperado', async () => {
    await addCase('b-caso', 20, { verdict: 'INVALID', fields: { amount: 5 } });
    await addCase('a-caso', 10);
    const bank = await loadBank(dir);
    expect(bank.problems).toEqual([]);
    expect(bank.cases.map((c) => c.id)).toEqual(['a-caso', 'b-caso']);
    expect(bank.cases[1].expected).toEqual({
      verdict: 'INVALID',
      fields: { amount: 5 },
    });
  });

  it('ignora archivos que no son del banco', async () => {
    await addCase('uno', 10);
    await fs.writeFile(path.join(dir, 'LEEME.txt'), 'x');
    expect((await loadBank(dir)).problems).toEqual([]);
  });

  it('reporta una imagen sin esperado', async () => {
    await fs.writeFile(path.join(dir, 'solo.png'), await png(10));
    const { problems } = await loadBank(dir);
    expect(problems).toEqual([
      expect.objectContaining({
        file: 'solo.expected.json',
        message: 'Falta el archivo con el resultado esperado',
      }),
    ]);
  });

  it('reporta un esperado sin imagen', async () => {
    await fs.writeFile(
      path.join(dir, 'huerfano.expected.json'),
      JSON.stringify({ verdict: 'VALID' }),
    );
    const { problems } = await loadBank(dir);
    expect(problems.some((p) => p.file === 'huerfano.expected.json')).toBe(
      true,
    );
  });

  it.each([
    ['JSON roto', '{no'],
    ['veredicto inexistente', JSON.stringify({ verdict: 'APROBADO' })],
    ['campo ajeno', JSON.stringify({ verdict: 'VALID', extra: 1 })],
    [
      'campo esperado ajeno',
      JSON.stringify({ verdict: 'VALID', fields: { iban: 'x' } }),
    ],
    [
      'monto no numérico',
      JSON.stringify({ verdict: 'VALID', fields: { amount: '5' } }),
    ],
    ['sin veredicto', JSON.stringify({ fields: {} })],
  ])('rechaza un esperado inválido: %s', async (_name, content) => {
    await fs.writeFile(path.join(dir, 'x.png'), await png(10));
    await fs.writeFile(path.join(dir, 'x.expected.json'), content);
    const { cases, problems } = await loadBank(dir);
    expect(cases).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it('rechaza archivos que no son imágenes o están vacíos', async () => {
    await fs.writeFile(path.join(dir, 'falsa.png'), 'no soy una imagen');
    await fs.writeFile(
      path.join(dir, 'falsa.expected.json'),
      '{"verdict":"VALID"}',
    );
    await fs.writeFile(path.join(dir, 'vacia.png'), '');
    await fs.writeFile(
      path.join(dir, 'vacia.expected.json'),
      '{"verdict":"VALID"}',
    );
    const { cases, problems } = await loadBank(dir);
    expect(cases).toEqual([]);
    expect(problems.map((p) => p.file).sort()).toEqual([
      'falsa.png',
      'vacia.png',
    ]);
  });

  it('rechaza una imagen mayor a 5 MB antes de leerla', async () => {
    await fs.writeFile(
      path.join(dir, 'grande.png'),
      Buffer.alloc(5 * 1024 * 1024 + 1),
    );
    await fs.writeFile(
      path.join(dir, 'grande.expected.json'),
      '{"verdict":"VALID"}',
    );
    const { cases, problems } = await loadBank(dir);
    expect(cases).toEqual([]);
    expect(problems).toEqual([
      expect.objectContaining({
        file: 'grande.png',
        message: 'La imagen supera 5 MB',
      }),
    ]);
  });

  it('rechaza nombres base repetidos entre extensiones', async () => {
    await addCase('dup', 10);
    await fs.writeFile(
      path.join(dir, 'dup.jpg'),
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#fff' },
      })
        .jpeg()
        .toBuffer(),
    );
    const { problems } = await loadBank(dir);
    expect(problems.some((p) => p.message.includes('único'))).toBe(true);
  });

  it('rechaza una carpeta vacía, inexistente o con demasiados casos', async () => {
    expect((await loadBank(dir)).problems).toHaveLength(1);
    expect((await loadBank(path.join(dir, 'no-existe'))).problems).toHaveLength(
      1,
    );
    await addCase('a', 10);
    await addCase('b', 20);
    const { problems } = await loadBank(dir, 1);
    expect(problems.some((p) => p.message.includes('máximo'))).toBe(true);
  });
});

describe('puntaje', () => {
  it('compara montos como números y textos sin importar mayúsculas ni espacios', () => {
    expect(fieldEquals('amount', 150000, 150000)).toBe(true);
    expect(fieldEquals('amount', 150000, 150001)).toBe(false);
    expect(fieldEquals('reference', 'TRX 123', '  trx   123 ')).toBe(true);
    expect(fieldEquals('reference', 'TRX 123', 'TRX 124')).toBe(false);
    expect(fieldEquals('recipient', null, null)).toBe(true);
    expect(fieldEquals('recipient', null, 'Alguien')).toBe(false);
    expect(fieldEquals('recipient', 'Alguien', null)).toBe(false);
  });

  it('solo revisa los campos que el banco espera', () => {
    expect(
      compareFields(
        { amount: 1, reference: 'A' },
        { amount: 1, reference: 'B', date: 'x' },
      ),
    ).toEqual(['reference']);
    expect(compareFields(undefined, { amount: 9 })).toEqual([]);
  });

  const base = { id: 'c', imageSha256: 'h' };
  const outcome = (verdict: string, fields = {}) => ({
    actual: { verdict, confidence: 0.9, fields, reasonCodes: [] } as never,
    tokens: { input: 10, output: 5, total: 15 },
    latencyMs: 100,
    modelUsed: 'm',
    costUsd: 0.001,
  });

  it('marca falsos válidos y falsos rechazos', () => {
    expect(
      scoreCase(
        { ...base, expected: { verdict: 'INVALID' } },
        outcome('VALID'),
      ),
    ).toMatchObject({
      falseValid: true,
      falseReject: false,
      verdictMatch: false,
    });
    expect(
      scoreCase(
        { ...base, expected: { verdict: 'NEEDS_REVIEW' } },
        outcome('VALID'),
      ),
    ).toMatchObject({ falseValid: true });
    expect(
      scoreCase(
        { ...base, expected: { verdict: 'VALID' } },
        outcome('INVALID'),
      ),
    ).toMatchObject({ falseValid: false, falseReject: true });
    expect(
      scoreCase({ ...base, expected: { verdict: 'VALID' } }, outcome('VALID')),
    ).toMatchObject({
      falseValid: false,
      falseReject: false,
      verdictMatch: true,
    });
  });

  it('percentil por interpolación y nulo sin datos', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([100], 0.95)).toBe(100);
    expect(percentile([1000, 2000, 3000, 4000], 0.5)).toBe(2500);
    expect(percentile([1000, 2000, 3000, 4000, 5000], 0.95)).toBe(4800);
  });

  it('resume con matriz, campos, latencia solo de llamadas reales y costos sin inventar', () => {
    const rows = [
      scoreCase(
        {
          ...base,
          id: 'a',
          expected: { verdict: 'VALID', fields: { amount: 1 } },
        },
        outcome('VALID', { amount: 1 }),
      ),
      scoreCase(
        { ...base, id: 'b', expected: { verdict: 'INVALID' } },
        outcome('VALID'),
      ),
      scoreCase(
        {
          ...base,
          id: 'c',
          expected: { verdict: 'VALID', fields: { amount: 1 } },
        },
        {
          ...outcome('ERROR'),
          modelUsed: null,
          tokens: { input: null, output: null, total: 0 },
          costUsd: null,
          latencyMs: 5,
        },
      ),
    ];
    const s = summarize(rows);
    expect(s.evaluated).toBe(3);
    expect(s.verdictAccuracy).toBeCloseTo(0.3333, 4);
    expect(s.falseValid).toBe(1);
    expect(s.falseReject).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.confusion.VALID.VALID).toBe(1);
    expect(s.confusion.INVALID.VALID).toBe(1);
    expect(s.confusion.VALID.ERROR).toBe(1);
    expect(s.fieldAccuracy.amount).toEqual({
      checked: 2,
      correct: 1,
      rate: 0.5,
    });
    expect(s.latencyMs.p50).toBe(100);
    expect(s.tokens.total).toBe(30);
    expect(s.costUsd).toEqual({ total: 0.002, casesWithoutCost: 0 });
  });

  it('un resumen vacío da tasas nulas, no NaN', () => {
    const s = summarize([]);
    expect(s.verdictAccuracy).toBeNull();
    expect(s.latencyMs).toEqual({ p50: null, p95: null });
  });

  it('la matriz incluye los seis veredictos', () => {
    expect(Object.keys(summarize([]).confusion).sort()).toEqual([
      'ERROR',
      'INVALID',
      'NEEDS_REVIEW',
      'NOT_APPLICABLE',
      'UNREADABLE',
      'VALID',
    ]);
  });
});

describe('ejecución', () => {
  const specialist = {
    id: 'esp-1',
    key: 'comprobantes',
    version: 4,
    capability: 'payment-proof',
    promptTemplate: 'prompt',
    rules: { version: 1, rules: [] },
    contextSources: { version: 1, sources: [] },
  };
  const prices = buildPriceTable(undefined);

  const dryRunFor = (
    verdicts: Record<string, string>,
    tokens = { input: 1000, output: 100 },
  ) =>
    jest.fn((input: { image: Buffer }) => {
      const verdict = verdicts[sha256(input.image)] ?? 'VALID';
      return Promise.resolve({
        result: {
          version: 1,
          verdict,
          confidence: 0.9,
          fields: { amount: 100 },
          reasonCodes: ['X'],
          humanSummary: 's',
        },
        modelUsed: 'claude-haiku-5-5',
        tokens: tokens.input + tokens.output,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        latencyMs: 700,
      });
    });

  const options = async (over: Record<string, unknown> = {}) => {
    const bank = await loadBank(dir);
    return {
      tenantId: 't1',
      specialist,
      draftUsed: { promptTemplate: false, rules: false, contextSources: false },
      cases: bank.cases,
      prices,
      maxCostUsd: 10,
      maxTokens: 1_000_000,
      ...over,
    };
  };

  it('evalúa cada caso con la definición del especialista y resume', async () => {
    await addCase('a', 10, { verdict: 'VALID', fields: { amount: 100 } });
    await addCase('b', 20, { verdict: 'INVALID' });
    const imageB = sha256(await fs.readFile(path.join(dir, 'b.png')));
    const dryRun = dryRunFor({ [imageB]: 'INVALID' });
    const result = await runEvaluation({
      ...(await options()),
      dryRun,
    } as never);

    expect(dryRun).toHaveBeenCalledTimes(2);
    expect(dryRun.mock.calls[0][0]).toMatchObject({
      tenantId: 't1',
      specialistId: 'esp-1',
      version: 4,
      promptTemplate: 'prompt',
    });
    expect(result.summary).toMatchObject({
      evaluated: 2,
      verdictAccuracy: 1,
      falseValid: 0,
    });
    expect(result.models).toEqual(['claude-haiku-5-5']);
    expect(result.stoppedByBudget).toBe(false);
    expect(result.summary.costUsd.total).toBeCloseTo(0.003, 6);
  });

  it('no guarda imágenes en el resultado', async () => {
    await addCase('a', 10);
    const image = await fs.readFile(path.join(dir, 'a.png'));
    const result = await runEvaluation({
      ...(await options()),
      dryRun: dryRunFor({}),
    } as never);
    const text = JSON.stringify(result);
    expect(text).not.toContain(image.toString('base64').slice(0, 40));
    expect(result.cases[0].imageSha256).toBe(sha256(image));
  });

  it('se detiene por el tope de costo y omite el resto', async () => {
    for (const [i, name] of ['a', 'b', 'c', 'd'].entries())
      await addCase(name, 10 + i);
    const dryRun = dryRunFor({}, { input: 1_000_000, output: 100_000 });
    const result = await runEvaluation({
      ...(await options({ maxCostUsd: 1.6, maxTokens: 1e9 })),
      dryRun,
    } as never);
    expect(dryRun).toHaveBeenCalledTimes(2);
    expect(result.stoppedByBudget).toBe(true);
    expect(result.summary).toMatchObject({ evaluated: 2, skipped: 2 });
    expect(
      result.cases.filter((c) => c.status === 'SKIPPED_BUDGET'),
    ).toHaveLength(2);
  });

  it('se detiene por el tope de tokens aunque el modelo no tenga precio', async () => {
    for (const [i, name] of ['a', 'b', 'c'].entries())
      await addCase(name, 10 + i);
    const dryRun = jest.fn(() =>
      Promise.resolve({
        result: {
          version: 1,
          verdict: 'VALID',
          confidence: 1,
          fields: {},
          reasonCodes: [],
          humanSummary: 's',
        },
        modelUsed: 'modelo-raro',
        tokens: 600,
        inputTokens: null,
        outputTokens: null,
        latencyMs: 10,
      }),
    );
    const result = await runEvaluation({
      ...(await options({ maxTokens: 1000 })),
      dryRun,
    } as never);
    expect(dryRun).toHaveBeenCalledTimes(2);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.costUsd.casesWithoutCost).toBe(2);
  });

  it('la huella del banco no depende del orden y cambia con el contenido', () => {
    const entries = [
      { id: 'a', imageSha256: 'x', expected: { verdict: 'VALID' as const } },
      { id: 'b', imageSha256: 'y', expected: { verdict: 'INVALID' as const } },
    ];
    expect(bankFingerprint(entries)).toBe(
      bankFingerprint([...entries].reverse()),
    );
    expect(bankFingerprint(entries)).not.toBe(
      bankFingerprint([
        entries[0],
        { ...entries[1], expected: { verdict: 'VALID' as const } },
      ]),
    );
  });

  it('un borrador cambia la huella de la definición', async () => {
    await addCase('a', 10);
    const dryRun = dryRunFor({});
    const normal = await runEvaluation({
      ...(await options()),
      dryRun,
    } as never);
    const draft = await runEvaluation({
      ...(await options({
        specialist: { ...specialist, promptTemplate: 'otro' },
        draftUsed: {
          promptTemplate: true,
          rules: false,
          contextSources: false,
        },
      })),
      dryRun,
    } as never);
    expect(draft.definitionSha256).not.toBe(normal.definitionSha256);
    expect(draft.bankSha256).toBe(normal.bankSha256);
    expect(draft.draftUsed.promptTemplate).toBe(true);
  });

  it('funciona de punta a punta con el runtime real y un orquestador simulado', async () => {
    await addCase('a', 10, {
      verdict: 'VALID',
      fields: { amount: 90000, reference: 'REF-1' },
    });
    const orchestrator = {
      analyzeImageForSpecialist: jest.fn(() =>
        Promise.resolve({
          content: JSON.stringify({
            version: 1,
            confidence: 0.8,
            fields: {
              amount: 90000,
              currency: 'COP',
              date: '2026-11-08',
              reference: 'REF-1',
              recipient: 'Spa',
              legibility: 'CLEAR',
            },
          }),
          tokensUsed: 1100,
          modelUsed: 'claude-haiku-5-5',
          usage: {
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
        }),
      ),
    };
    const prisma = { verificationRecord: { create: jest.fn() } };
    const runtime = new SpecialistRuntime(
      { get: () => undefined } as never,
      prisma as never,
      orchestrator as never,
      { publish: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    const result = await runEvaluation({
      ...(await options()),
      dryRun: (i: never) => runtime.dryRun(i),
    });
    expect(result.summary).toMatchObject({ evaluated: 1, verdictAccuracy: 1 });
    expect(result.cases[0].fieldMismatches).toEqual([]);
    expect(prisma.verificationRecord.create).not.toHaveBeenCalled();
  });
});

describe('comparación de corridas', () => {
  const specialist = {
    id: 'e',
    key: 'k',
    version: 1,
    capability: 'payment-proof',
    promptTemplate: 'p',
    rules: {},
    contextSources: {},
  };
  const prices = buildPriceTable(undefined);

  async function runWith(
    verdicts: Record<string, string>,
    extra: Record<string, unknown> = {},
  ) {
    const bank = await loadBank(dir);
    const dryRun = jest.fn((input: { image: Buffer }) => {
      return Promise.resolve({
        result: {
          version: 1,
          verdict: verdicts[sha256(input.image)] ?? 'VALID',
          confidence: 0.9,
          fields: {},
          reasonCodes: [],
          humanSummary: 's',
        },
        modelUsed: 'claude-haiku-5-5',
        tokens: 1100,
        inputTokens: 1000,
        outputTokens: 100,
        latencyMs: 500,
      });
    });
    return runEvaluation({
      tenantId: 't',
      specialist,
      draftUsed: { promptTemplate: false, rules: false, contextSources: false },
      cases: bank.cases,
      prices,
      maxCostUsd: 10,
      maxTokens: 1e6,
      dryRun,
      ...extra,
    } as never);
  }

  const hashOf = async (name: string) =>
    sha256(await fs.readFile(path.join(dir, `${name}.png`)));

  it('dos corridas iguales no tienen regresiones', async () => {
    await addCase('a', 10);
    await addCase('b', 20, { verdict: 'INVALID' });
    const run = await runWith({ [await hashOf('b')]: 'INVALID' });
    const cmp = compareRuns(run, run);
    expect(cmp).toMatchObject({
      commonCases: 2,
      sameBank: true,
      regressions: [],
      improvements: [],
      safetyRegression: false,
      worse: false,
    });
    expect(cmp.metrics.falseValid.delta).toBe(0);
  });

  it('detecta regresiones, mejoras y aumento de falsos válidos', async () => {
    await addCase('a', 10);
    await addCase('b', 20, { verdict: 'INVALID' });
    await addCase('c', 30, { verdict: 'INVALID' });
    const [hb, hc] = [await hashOf('b'), await hashOf('c')];
    const good = await runWith({ [hb]: 'INVALID', [hc]: 'VALID' });
    const better = await runWith({ [hb]: 'INVALID', [hc]: 'INVALID' });
    const worse = await runWith({ [hb]: 'VALID', [hc]: 'VALID' });

    const up = compareRuns(good, better);
    expect(up.improvements.map((d) => d.id)).toEqual(['c']);
    expect(up.regressions).toEqual([]);
    expect(up.metrics.falseValid).toEqual({ a: 1, b: 0, delta: -1 });
    expect(up.worse).toBe(false);

    const down = compareRuns(good, worse);
    expect(down.regressions.map((d) => d.id)).toEqual(['b']);
    expect(down.safetyRegression).toBe(true);
    expect(down.worse).toBe(true);
    expect(formatComparison(down)).toContain('ALERTA DE SEGURIDAD');
  });

  it('un banco distinto compara solo lo común y avisa', async () => {
    await addCase('a', 10);
    const first = await runWith({});
    await addCase('b', 20);
    const second = await runWith({});
    const cmp = compareRuns(first, second);
    expect(cmp.commonCases).toBe(1);
    expect(cmp.onlyInB).toEqual(['b']);
    expect(cmp.sameBank).toBe(false);
    expect(cmp.warnings.join(' ')).toContain('bancos difieren');
  });

  it('excluye un caso con imagen distinta entre corridas', async () => {
    await addCase('a', 10);
    const first = await runWith({});
    await addCase('a', 99);
    const second = await runWith({});
    const cmp = compareRuns(first, second);
    expect(cmp.commonCases).toBe(0);
    expect(cmp.warnings.join(' ')).toContain('imagen distinta');
  });

  it('excluye los casos omitidos por presupuesto', async () => {
    await addCase('a', 10);
    await addCase('b', 20);
    const full = await runWith({});
    const partial = await runWith({}, { maxCostUsd: 0 });
    const cmp = compareRuns(full, partial);
    expect(cmp.commonCases).toBe(0);
    expect(cmp.warnings.some((w) => w.includes('presupuesto'))).toBe(true);
  });

  it('rechaza archivos que no son resultados', () => {
    expect(() => parseRun(null)).toThrow();
    expect(() => parseRun({ version: 99 })).toThrow();
    expect(() => parseRun({ version: 1, cases: [] })).toThrow();
  });

  it('el informe de una corrida muestra matriz, diferencias y topes', async () => {
    await addCase('a', 10, { verdict: 'INVALID' });
    const run = await runWith({});
    const text = formatRun(run);
    expect(text).toContain('Falsos válidos');
    expect(text).toContain('NOT_APPLICABLE');
    expect(text).toContain('a: esperado INVALID, obtenido VALID');
    const blank = formatRun({ ...run, stoppedByBudget: true });
    expect(blank).toContain('se detuvo por el presupuesto');
  });

  it('un resultado sobrevive a guardarse y leerse como JSON', async () => {
    await addCase('a', 10);
    const run = await runWith({});
    const again = parseRun(JSON.parse(JSON.stringify(run)));
    expect(compareRuns(run, again).worse).toBe(false);
  });
});
