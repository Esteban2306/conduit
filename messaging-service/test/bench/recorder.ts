import { AsyncLocalStorage } from 'async_hooks';
import { Messages } from '@anthropic-ai/sdk/resources/messages/messages';
import { BENCH } from './bench.config';

export interface TurnContext {
  scenarioId: string;
  turn: number;
  actor: string;
}

export interface LlmCall {
  ctx: TurnContext | null;
  model: string;
  input: number;
  output: number;
  thinking: number;
  cacheWrite: number;
  cacheRead: number;
  stopReason: string | null;
  tools: number;
  toolUses: string[];
  ms: number;
  usd: number;
}

export interface ToolCall {
  ctx: TurnContext | null;
  name: string;
  status: string;
  httpStatus: number | null;
  ms: number;
  errorDetail: string | null;
}

export interface SentMessage {
  ctx: TurnContext | null;
  channel: string;
  to: string;
  content: string;
  connectionId: string | null;
  at: number;
}

export const turnStorage = new AsyncLocalStorage<TurnContext>();

class Recorder {
  readonly llm: LlmCall[] = [];
  readonly tools: ToolCall[] = [];
  readonly sent: SentMessage[] = [];
  private readonly inflight = new Map<string, number>();
  spentUsd = 0;
  budgetExceeded = false;

  ctx(): TurnContext | null {
    return turnStorage.getStore() ?? null;
  }

  enter(): () => void {
    const id = this.ctx()?.scenarioId;
    if (!id) return () => undefined;
    this.inflight.set(id, (this.inflight.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight.set(id, (this.inflight.get(id) ?? 1) - 1);
    };
  }

  busy(scenarioId: string): boolean {
    return (this.inflight.get(scenarioId) ?? 0) > 0;
  }

  cost(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }): number {
    const p = BENCH.priceUsdPerMTok;
    return (
      ((usage.input_tokens ?? 0) * p.input +
        (usage.output_tokens ?? 0) * p.output +
        (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
        (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
      1e6
    );
  }
}

export const recorder = new Recorder();

export function track<T extends object, K extends keyof T>(
  target: T,
  method: K,
): void {
  const original = target[method];
  target[method] = function (this: unknown, ...args: unknown[]) {
    const leave = recorder.enter();
    try {
      const out: unknown = Reflect.apply(
        original as (...a: unknown[]) => unknown,
        this,
        args,
      );
      if (out && typeof (out as Promise<unknown>).finally === 'function') {
        return (out as Promise<unknown>).finally(leave);
      }
      leave();
      return out;
    } catch (error) {
      leave();
      throw error;
    }
  } as unknown as T[K];
}

export function instrumentAnthropic(): void {
  const proto = Messages.prototype as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const original = proto.create;
  proto.create = async function (this: unknown, ...args: unknown[]) {
    if (recorder.spentUsd >= BENCH.budgetUsd) {
      recorder.budgetExceeded = true;
      throw Object.assign(new Error('BENCH_BUDGET_EXCEEDED'), { status: 400 });
    }
    const body = args[0] as { model: string; tools?: unknown[] };
    const started = Date.now();
    const response = (await Reflect.apply(original, this, args)) as {
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        output_tokens_details?: { thinking_tokens?: number };
      };
      stop_reason: string | null;
      content: Array<{ type: string; name?: string }>;
    };
    const usd = recorder.cost(response.usage);
    recorder.spentUsd += usd;
    recorder.llm.push({
      ctx: recorder.ctx(),
      model: body.model,
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      thinking: response.usage.output_tokens_details?.thinking_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      stopReason: response.stop_reason,
      tools: body.tools?.length ?? 0,
      toolUses: response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => String(b.name)),
      ms: Date.now() - started,
      usd,
    });
    return response;
  };
}
