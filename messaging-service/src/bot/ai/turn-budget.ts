export const TURN_BUDGET_MS = 45_000;
export const AI_CALL_TIMEOUT_MS = 25_000;
export const TOOL_READ_TIMEOUT_MS = 8_000;
export const TOOL_WRITE_TIMEOUT_MS = 15_000;

export class BudgetExceededError extends Error {
  readonly name = 'TimeoutError';
  constructor(what = 'turno') {
    super(`Presupuesto de tiempo del ${what} agotado (timeout)`);
  }
}

/**
 * Tiempo total de un turno, repartido entre la IA y las herramientas: cada
 * llamada recibe lo que le toca sin pasar del tiempo que queda.
 */
export class TurnBudget {
  readonly deadlineAt: number;

  constructor(
    totalMs: number = TURN_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.deadlineAt = now() + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  slice(maxMs: number): number {
    return Math.min(maxMs, this.remaining());
  }

  /** Falla con BudgetExceededError si la operación no termina en `maxMs` (o en lo que queda). */
  async race<T>(operation: Promise<T>, maxMs?: number): Promise<T> {
    const ms = this.slice(maxMs ?? this.remaining());
    if (ms <= 0) throw new BudgetExceededError();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BudgetExceededError()), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
