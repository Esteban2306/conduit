export interface ToolTrace {
  name: string;
  ok: boolean;
  ms: number;
  bytes: number;
  truncated: boolean;
}

export interface TurnTrace {
  correlationId: string;
  chat: string;
  route: string;
  model?: string;
  llmCalls?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  ms: number;
  tools: ToolTrace[];
  flags: string[];
}

export const maskChat = (address: string): string =>
  address.length <= 4 ? '****' : `***${address.slice(-4)}`;

/** Una línea por turno, fácil de buscar por correlation id en Conduit y en el backend. */
export function formatTurnLine(trace: TurnTrace): string {
  const tokens =
    trace.input === undefined
      ? ''
      : ` in=${trace.input} caché=${trace.cacheRead ?? 0}/${trace.cacheWrite ?? 0} out=${trace.output ?? 0}`;
  const tools = trace.tools.length
    ? ` herramientas=${trace.tools
        .map(
          (t) =>
            `${t.name}${t.ok ? '' : '!'}(${t.ms}ms,${t.bytes}B${t.truncated ? ',recortado' : ''})`,
        )
        .join(',')}`
    : '';
  const flags = trace.flags.length ? ` banderas=${trace.flags.join(',')}` : '';
  return (
    `Turno corr=${trace.correlationId} chat=${trace.chat} ruta=${trace.route}` +
    `${trace.model ? ` modelo=${trace.model}` : ''}` +
    `${trace.llmCalls !== undefined ? ` llm=${trace.llmCalls}` : ''}` +
    `${tokens} ms=${trace.ms}${tools}${flags}`
  );
}
