import { LlmCall, recorder, SentMessage, ToolCall } from './recorder';
import type { Scenario } from './scenario-types';

export interface TurnResult {
  index: number;
  actor: string;
  phone: string;
  input: unknown[];
  startedAt: number;
  endedAt: number;
  settled: boolean;
  expect?: { route?: string };
  route?: Route;
  llmCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  llmMs?: number;
  latencyMs?: number | null;
  tools?: Array<{
    name: string;
    status: string;
    httpStatus: number | null;
    ms: number;
  }>;
  requestedTools?: string[];
  sent?: string[];
  flags?: string[];
  stopReasons?: string[];
}

export type Route = 'plantilla' | 'directo' | 'IA' | 'ignorado';

export interface ScenarioResult {
  id: string;
  title: string;
  category: string;
  knownFailure: string | null;
  knownFailureReproduced: boolean | null;
  pass: boolean;
  failures: string[];
  flags: string[];
  turns: TurnResult[];
  tools: string[];
  notifications: Array<{ to: string; channel: string; content: string }>;
  finalState: Record<string, unknown>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  billableTokens: number;
  durationMs: number;
  skipped?: string;
  error?: string;
}

export const GENERIC_TOOL_FAILURE =
  /Tuvimos un inconveniente al procesar tu solicitud/i;
export const AI_UNAVAILABLE = /nuestro asistente no está disponible/i;
const HUMAN_PROMISE =
  /se pondr[áa] en contacto|nos pondremos en contacto|te (contactar[áa]|escribir[áa]|responder[áa]|llamar[áa])|(persona|asesor[a]?) (del|de nuestro) equipo (te|se) (contactar[áa]|comunicar[áa]|responder[áa]|escribir[áa])/i;
const DATE_UNKNOWN =
  /no (tengo|puedo|sé).{0,40}(fecha|qué día)|no tengo acceso a la fecha|me (confirmas?|indicas?) (la fecha|qué día es)/i;

const digits = (s: string) => s.replace(/\D/g, '');
const samePhone = (a: string, b: string) =>
  digits(a).slice(-10) === digits(b).slice(-10);

interface EvaluateInput {
  scenario: Scenario;
  phones: Map<string, string>;
  prior: unknown;
  turns: TurnResult[];
  finalState: Record<string, unknown>;
  inbound: Array<{ phone: string; content: string }>;
  adminPhone: string;
  durationMs: number;
  now?: Date;
}

const TODAY_TIME_ZONE = 'America/Bogota';

const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function mentionsToday(
  replies: string,
  now: Date = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: TODAY_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const text = plain(replies);
  return text.includes(plain(weekday)) && new RegExp(`\\b${day}\\b`).test(text);
}

export function evaluateScenario(input: EvaluateInput): ScenarioResult {
  const { scenario, phones, turns } = input;
  const ownLlm = recorder.llm.filter((c) => c.ctx?.scenarioId === scenario.id);
  const ownTools = recorder.tools.filter(
    (c) => c.ctx?.scenarioId === scenario.id,
  );
  const windowStart = turns[0]?.startedAt ?? 0;
  const windowEnd = windowStart + input.durationMs;
  const phoneList = [...phones.values()];

  const sentToActor = (
    phone: string,
    from: number,
    to: number,
  ): SentMessage[] =>
    recorder.sent.filter(
      (s) =>
        samePhone(s.to, phone) &&
        s.at >= from &&
        s.at <= to &&
        (!s.ctx || s.ctx.scenarioId === scenario.id),
    );

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const until =
      turns[i + 1] && !input.scenario.turns[i + 1]?.concurrentWithPrevious
        ? turns[i + 1].startedAt
        : windowEnd;
    const llm: LlmCall[] = ownLlm.filter((c) => c.ctx!.turn === i);
    const tools: ToolCall[] = ownTools.filter((c) => c.ctx!.turn === i);
    const sent = sentToActor(turn.phone, turn.startedAt, until).filter(
      (s) => !s.ctx || s.ctx.turn === i || s.ctx.actor !== turn.actor,
    );
    const replies = sent.filter((s) => s.ctx);
    const flags: string[] = [];
    if (llm.some((c) => c.stopReason === 'max_tokens')) flags.push('cortado');
    if (
      replies.some(
        (s) => !s.content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
      )
    )
      flags.push('vacío');
    if (llm.length > 0 && replies.length === 0) flags.push('sin-respuesta');
    if (replies.some((s) => GENERIC_TOOL_FAILURE.test(s.content)))
      flags.push('genérico-por-herramienta');
    if (replies.some((s) => AI_UNAVAILABLE.test(s.content)))
      flags.push('ia-no-disponible');
    if (replies.some((s) => DATE_UNKNOWN.test(s.content)))
      flags.push('fecha-desconocida');
    if (!turn.settled) flags.push('timeout');

    turn.route =
      llm.length > 0 ? 'IA' : replies.length > 0 ? 'directo' : 'ignorado';
    turn.llmCalls = llm.length;
    turn.inputTokens = llm.reduce(
      (a, c) => a + c.input + c.cacheWrite + c.cacheRead,
      0,
    );
    turn.cacheReadTokens = llm.reduce((a, c) => a + c.cacheRead, 0);
    turn.outputTokens = llm.reduce((a, c) => a + c.output, 0);
    turn.thinkingTokens = llm.reduce((a, c) => a + c.thinking, 0);
    turn.costUsd = llm.reduce((a, c) => a + c.usd, 0);
    turn.llmMs = llm.reduce((a, c) => a + c.ms, 0);
    turn.stopReasons = llm.map((c) => c.stopReason ?? 'null');
    const lastInjected =
      turn.startedAt + Math.max(0, turn.input.length - 1) * 1200;
    turn.latencyMs = replies.length ? replies[0].at - lastInjected : null;
    turn.tools = tools.map((t) => ({
      name: t.name,
      status: t.status,
      httpStatus: t.httpStatus,
      ms: t.ms,
      ...(t.failure ? { failure: t.failure } : {}),
    }));
    turn.requestedTools = llm.flatMap((c) => c.toolUses ?? []);
    turn.sent = replies.map((s) => s.content);
    turn.flags = flags;
  }

  const failures: string[] = [];
  const expect = scenario.expect;
  const toolNames = [
    ...new Set([
      ...ownTools.map((t) => t.name),
      ...turns.flatMap((t) => t.requestedTools ?? []),
    ]),
  ];
  const replies = turns.flatMap((t) => t.sent ?? []);
  const allReplies = replies.join('\n---\n');

  turns.forEach((t, i) => {
    let wanted =
      scenario.turns[i]?.expect?.route ??
      t.expect?.route ??
      (i === 0 ? expect.route : undefined);
    if (wanted === 'acuse') {
      const previous = turns
        .slice(0, i)
        .reverse()
        .find((p) => p.actor === t.actor && (p.sent?.length ?? 0) > 0);
      wanted = previous?.sent?.at(-1)?.includes('?') ? 'IA' : 'ignorado';
    }
    if (wanted && t.route !== wanted)
      failures.push(`turno ${i + 1}: ruta ${t.route}, se esperaba ${wanted}`);
  });
  if (
    expect.toolsAny &&
    !expect.toolsAny.some((n: string) => toolNames.includes(n))
  )
    failures.push(`no usó ninguna de: ${expect.toolsAny.join(', ')}`);
  for (const n of expect.toolsAll ?? [])
    if (!toolNames.includes(n)) failures.push(`no usó ${n}`);
  for (const n of expect.toolsForbidden ?? [])
    if (toolNames.includes(n)) failures.push(`usó la prohibida ${n}`);
  if (
    expect.replyMatches &&
    !new RegExp(expect.replyMatches, 'i').test(allReplies)
  )
    failures.push(`respuesta sin /${expect.replyMatches}/`);
  if (expect.replyShowsToday && !mentionsToday(allReplies, input.now)) {
    failures.push('la respuesta no dice la fecha de hoy');
  }
  if (
    expect.replyNotMatches &&
    new RegExp(expect.replyNotMatches, 'i').test(allReplies)
  )
    failures.push(`respuesta contiene /${expect.replyNotMatches}/`);

  const stateA = input.finalState.A as
    | {
        reservations?: Array<{ status: string }>;
        client?: { name?: string; consents?: string[] } | null;
      }
    | undefined;
  if (expect.finalState?.reservationStatus) {
    const status = stateA?.reservations?.[0]?.status;
    if (status !== expect.finalState.reservationStatus)
      failures.push(
        `estado final ${status ?? 'sin reserva'}, se esperaba ${expect.finalState.reservationStatus}`,
      );
  }
  if (expect.finalState?.reservationCountAtLeast !== undefined) {
    const count = stateA?.reservations?.length ?? 0;
    if (count < expect.finalState.reservationCountAtLeast)
      failures.push(`reservas creadas: ${count}`);
  }

  if (expect.finalState?.clientNameMatches !== undefined) {
    const name = stateA?.client?.name;
    if (
      !name ||
      !new RegExp(expect.finalState.clientNameMatches, 'i').test(name)
    )
      failures.push(
        `ficha de la clienta sin nombre /${expect.finalState.clientNameMatches}/ (${name ?? 'sin ficha'})`,
      );
  }
  for (const consent of expect.finalState?.clientConsents ?? []) {
    if (!stateA?.client?.consents?.includes(consent))
      failures.push(`la ficha no registra el consentimiento ${consent}`);
  }

  const notifications = recorder.sent
    .filter((s) => s.at >= windowStart && s.at <= windowEnd + 1000 && !s.ctx)
    .filter(
      (s) =>
        phoneList.some((p) => samePhone(s.to, p)) ||
        ((samePhone(s.to, input.adminPhone) || s.channel === 'EMAIL') &&
          phoneList.some((p) => s.content.includes(digits(p).slice(-10)))),
    )
    .map((s) => ({ to: s.to, channel: s.channel, content: s.content }));
  const handedOff = ownTools.some(
    (t) => t.name === 'pasar_a_persona' && t.status === 'SUCCESS',
  );
  const teamNotified =
    handedOff ||
    notifications.some((n) => !phoneList.some((p) => samePhone(n.to, p)));
  const falsePromise =
    replies.some((r) => HUMAN_PROMISE.test(r)) && !teamNotified;
  if (expect.noFalseHumanPromise && falsePromise)
    failures.push(
      'promete que una persona contactará y nadie del equipo fue avisado',
    );

  const scenarioFlags = new Set(turns.flatMap((t) => t.flags ?? []));
  if (falsePromise) scenarioFlags.add('promesa-falsa');
  if (
    expect.notCutOrEmpty &&
    (scenarioFlags.has('cortado') || scenarioFlags.has('vacío'))
  )
    failures.push('respuesta cortada o vacía');

  if (expect.noCrossTalk) {
    for (const [actor, phone] of phones) {
      const own = scenario.turns
        .filter((t) => t.actor === actor)
        .flatMap((t) => t.messages.map((m) => m.text ?? ''));
      const foreign = input.inbound
        .filter((r) => samePhone(r.phone, phone))
        .filter(
          (r) =>
            !own.some(
              (o) =>
                o && r.content.split('\n').every((line) => own.includes(line)),
            ),
        );
      if (foreign.length)
        failures.push(
          `la conversación de ${actor} guardó texto ajeno: ${JSON.stringify(foreign.map((f) => f.content)).slice(0, 200)}`,
        );
    }
  }
  if (expect.everyActorAnswered) {
    for (const [actor] of phones) {
      if (!turns.some((t) => t.actor === actor && (t.sent?.length ?? 0) > 0))
        failures.push(`${actor} no recibió respuesta`);
    }
  }
  for (const t of turns)
    if (!t.settled) failures.push(`turno ${t.index + 1} no terminó a tiempo`);

  const pass = failures.length === 0;
  return {
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    knownFailure: scenario.knownFailure ?? null,
    knownFailureReproduced: scenario.knownFailure ? !pass : null,
    pass,
    failures,
    flags: [...scenarioFlags],
    turns,
    tools: toolNames,
    notifications,
    finalState: input.finalState,
    costUsd: ownLlm.reduce((a, c) => a + c.usd, 0),
    inputTokens: ownLlm.reduce(
      (a, c) => a + c.input + c.cacheWrite + c.cacheRead,
      0,
    ),
    outputTokens: ownLlm.reduce((a, c) => a + c.output, 0),
    billableTokens: ownLlm.reduce((a, c) => a + c.billable, 0),
    durationMs: input.durationMs,
  };
}
