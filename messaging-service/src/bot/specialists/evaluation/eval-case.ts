import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { z } from 'zod';
import { VERDICTS } from '../contracts';

export const EVAL_IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;
export const EXPECTED_SUFFIX = '.expected.json';
export const MAX_EVAL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_EVAL_CASES = 200;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export const EVAL_VERDICTS = VERDICTS;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

export const EVAL_FIELD_NAMES = [
  'amount',
  'currency',
  'date',
  'reference',
  'recipient',
  'legibility',
] as const;
export type EvalFieldName = (typeof EVAL_FIELD_NAMES)[number];

const expectedFieldsSchema = z
  .object({
    amount: z.number().finite().nullable(),
    currency: z.string().max(10).nullable(),
    date: z.string().max(40).nullable(),
    reference: z.string().max(120).nullable(),
    recipient: z.string().max(120).nullable(),
    legibility: z.enum(['CLEAR', 'PARTIAL', 'UNREADABLE']),
  })
  .partial()
  .strict();

export const expectedSchema = z
  .object({
    verdict: z.enum(EVAL_VERDICTS),
    fields: expectedFieldsSchema.optional(),
    note: z.string().max(200).optional(),
  })
  .strict();
export type Expected = z.infer<typeof expectedSchema>;

export interface EvalCase {
  id: string;
  imagePath: string;
  expected: Expected;
}

export interface BankProblem {
  file: string;
  message: string;
}

export interface LoadedBank {
  cases: EvalCase[];
  problems: BankProblem[];
}

export async function loadBank(
  dir: string,
  maxCases: number = MAX_EVAL_CASES,
): Promise<LoadedBank> {
  const problems: BankProblem[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(dir)).sort();
  } catch {
    return {
      cases: [],
      problems: [{ file: dir, message: 'No se puede leer la carpeta' }],
    };
  }

  const images = names.filter((name) =>
    (EVAL_IMAGE_EXTENSIONS as readonly string[]).includes(
      path.extname(name).toLowerCase(),
    ),
  );
  const expectedFiles = names.filter((name) => name.endsWith(EXPECTED_SUFFIX));
  const ids = new Map<string, string>();
  const cases: EvalCase[] = [];

  for (const image of images) {
    const id = path.basename(image, path.extname(image));
    const previous = ids.get(id);
    if (previous) {
      problems.push({
        file: image,
        message: `Mismo nombre base que ${previous}: cada caso debe ser único`,
      });
      continue;
    }
    ids.set(id, image);

    const imagePath = path.join(dir, image);
    const problem = await checkImage(imagePath);
    if (problem) {
      problems.push({ file: image, message: problem });
      continue;
    }

    const expected = await readExpected(
      path.join(dir, `${id}${EXPECTED_SUFFIX}`),
    );
    if (typeof expected === 'string') {
      problems.push({ file: `${id}${EXPECTED_SUFFIX}`, message: expected });
      continue;
    }
    cases.push({ id, imagePath, expected });
  }

  for (const file of expectedFiles) {
    const id = file.slice(0, -EXPECTED_SUFFIX.length);
    if (!ids.has(id)) {
      problems.push({
        file,
        message: 'No tiene una imagen con el mismo nombre',
      });
    }
  }

  if (cases.length === 0 && problems.length === 0) {
    problems.push({ file: dir, message: 'La carpeta no tiene casos' });
  }
  if (cases.length > maxCases) {
    problems.push({
      file: dir,
      message: `Tiene ${cases.length} casos y el máximo es ${maxCases}`,
    });
  }
  return { cases, problems };
}

async function checkImage(imagePath: string): Promise<string | null> {
  let size: number;
  try {
    size = (await fs.stat(imagePath)).size;
  } catch {
    return 'No se puede leer la imagen';
  }
  if (size === 0) return 'La imagen está vacía';
  if (size > MAX_EVAL_IMAGE_BYTES) return 'La imagen supera 5 MB';
  try {
    const format = (await sharp(await fs.readFile(imagePath)).metadata())
      .format;
    if (!format || !SUPPORTED_FORMATS.has(format)) {
      return 'Formato no soportado (JPEG, PNG o WebP)';
    }
  } catch {
    return 'El archivo no es una imagen válida';
  }
  return null;
}

async function readExpected(file: string): Promise<Expected | string> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return 'Falta el archivo con el resultado esperado';
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'No es un JSON válido';
  }
  const parsed = expectedSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  return parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('; ');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function bankFingerprint(
  entries: Array<{ id: string; imageSha256: string; expected: Expected }>,
): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return sha256(
    JSON.stringify(
      sorted.map((entry) => [entry.id, entry.imageSha256, entry.expected]),
    ),
  );
}
