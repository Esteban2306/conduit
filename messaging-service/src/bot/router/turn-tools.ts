export interface TurnTool {
  spec: { name: string };
  readOnly: boolean;
  pausesBotMinutes?: number | null;
  pinResultInMemory?: boolean | null;
}

export interface TurnState {
  handoffQuiet: boolean;
  affirmsSlot: boolean;
}

export const AFFIRMED_SLOT_NOTE =
  'La clienta acaba de aceptar el único día y hora que le propusiste: ejecuta ya la acción que aceptó (por ejemplo crear_reserva_whatsapp) con ese día y hora, sin volver a consultar disponibilidad, y responde según su resultado.';

const AFFIRMED_SLOT_BLOCK =
  'La clienta ya aceptó el horario que le propusiste: no vuelvas a consultar. Ejecuta la acción que aceptó (por ejemplo crear_reserva_whatsapp) y responde según su resultado.';

const HANDOFF_BLOCK =
  'El equipo ya está atendiendo este chat: no lo pases otra vez ni vuelvas a avisar. Responde solo lo que preguntó.';

export function blockedToolsForTurn(
  tools: readonly TurnTool[],
  state: TurnState,
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const tool of tools) {
    const pauses = (tool.pausesBotMinutes ?? 0) > 0;
    if (pauses && state.handoffQuiet) {
      blocked.set(tool.spec.name, HANDOFF_BLOCK);
    } else if (pauses && state.affirmsSlot) {
      blocked.set(tool.spec.name, AFFIRMED_SLOT_BLOCK);
    } else if (state.affirmsSlot && tool.readOnly && !tool.pinResultInMemory) {
      blocked.set(tool.spec.name, AFFIRMED_SLOT_BLOCK);
    }
  }
  return blocked;
}
