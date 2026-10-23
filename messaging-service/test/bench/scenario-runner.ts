import { BENCH } from './bench.config';
import { recorder, turnStorage, TurnContext } from './recorder';
import { evaluateScenario, ScenarioResult, TurnResult } from './evaluate';
import { ADMIN_PHONE, Stack, sleep, waMessage } from './stack';
import type { Scenario } from './scenario-types';
export type { Scenario, ScenarioExpect, TurnSpec } from './scenario-types';
import { chatKey } from 'src/channels/whatsapp/utils/chat-key';

const BURST_GAP_MS = 1200;
const SETTLE_MS = 900;
const NOTIFICATION_GRACE_MS = 5000;

export interface RunnerOptions {
  settleTimeoutMs?: number;
  thinkMs?: [number, number];
  graceMs?: number;
}

export function createRunner(stack: Stack, options: RunnerOptions = {}) {
  const { conduit, router, internals, contacts, leonice } = stack;
  const debouncer = internals.debouncer;
  const settleTimeoutMs = options.settleTimeoutMs ?? BENCH.turnTimeoutMs;
  const graceMs = options.graceMs ?? NOTIFICATION_GRACE_MS;

  const pendingFor = (connectionId: string, phones: readonly string[]) =>
    [...phones].some((phone) =>
      debouncer.pending.has(chatKey(connectionId, `${phone}@s.whatsapp.net`)),
    );

  async function settle(
    scenarioId: string,
    connectionId: string,
    phones: readonly string[],
  ): Promise<boolean> {
    const deadline = Date.now() + settleTimeoutMs;
    let quietSince = 0;
    while (Date.now() < deadline) {
      const busy =
        recorder.busy(scenarioId) || pendingFor(connectionId, phones);
      if (busy) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince >= SETTLE_MS) return true;
      await sleep(150);
    }
    return false;
  }

  let phoneCounter = 0;
  const nextPhone = () => `5730100${String(++phoneCounter).padStart(5, '0')}`;

  async function runScenario(
    scenario: Scenario,
    connectionId: string,
  ): Promise<ScenarioResult> {
    const phones = new Map<string, string>();
    const phoneOf = (actor: string) => {
      if (!phones.has(actor)) phones.set(actor, nextPhone());
      return phones.get(actor)!;
    };
    phoneOf('A');
    const prior = scenario.prior
      ? await leonice('/__bench/state', {
          method: 'POST',
          body: JSON.stringify({ phone: phoneOf('A'), ...scenario.prior }),
        })
      : null;

    const turns: TurnResult[] = [];
    const scenarioStart = Date.now();
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const phone = phoneOf(turn.actor);
      const ctx: TurnContext = {
        scenarioId: scenario.id,
        turn: i,
        actor: turn.actor,
      };
      if (options.thinkMs && i > 0) {
        const [min, max] = options.thinkMs;
        await sleep(min + Math.random() * (max - min));
      }
      const t0 = Date.now();
      await turnStorage.run(ctx, async () => {
        for (let m = 0; m < turn.messages.length; m++) {
          await contacts.recordInbound(connectionId, phone);
          if (connectionId !== conduit.connectionIds[0])
            await contacts.recordInbound(conduit.connectionIds[0], phone);
          await router.route(
            [waMessage(phone, turn.messages[m])],
            conduit.botId,
            connectionId,
            conduit.tenantId,
          );
          if (m < turn.messages.length - 1) await sleep(BURST_GAP_MS);
        }
      });
      const nextConcurrent = scenario.turns[i + 1]?.concurrentWithPrevious;
      const settled = nextConcurrent
        ? true
        : await settle(scenario.id, connectionId, [...phones.values()]);
      turns.push({
        index: i,
        actor: turn.actor,
        phone,
        input: turn.messages,
        startedAt: t0,
        endedAt: Date.now(),
        settled,
        expect: turn.expect,
      });
    }
    await sleep(graceMs);

    const finalState: Record<string, unknown> = {};
    for (const [actor, phone] of phones)
      finalState[actor] = await leonice(`/__bench/inspect?phone=${phone}`);
    const inbound = await conduit.db.query<{ phone: string; content: string }>(
      `SELECT c."phoneNumber" AS phone, m.content FROM "BotMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
       WHERE m.direction = 'INBOUND' AND c."phoneNumber" = ANY($1)`,
      [[...phones.values()]],
    );
    return evaluateScenario({
      scenario,
      phones,
      prior,
      turns,
      finalState,
      inbound: inbound.rows,
      adminPhone: ADMIN_PHONE,
      durationMs: Date.now() - scenarioStart,
    });
  }

  return { runScenario, phones: () => phoneCounter };
}
