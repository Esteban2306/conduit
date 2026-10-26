import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/ConversationService';
import { IntentRepository } from '../intent/IntentRepository.service';
import { fillTemplate } from '../intent/render-spec';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ResolvedTool } from '../tools/ToolDefinitionService';
import { ToolExecutorService } from '../tools/ToolExecutor.service';
import { isLidAddress } from 'src/channels/whatsapp/utils/jid.util';
import {
  DEFAULT_HANDOFF_FAILED_TEXT,
  DEFAULT_HANDOFF_TEXT,
  HANDOFF_AT_KEY,
  HANDOFF_PAUSE_MINUTES,
  HANDOFF_REASON_KEY,
} from './handoff-defaults';

export interface HandoffRequest {
  tenantId: string;
  botConfigId: string;
  conversationId: string;
  connectionId: string;
  phoneNumber: string;
  turnId?: string;
  reason: string;
  summary?: string;
  context: Record<string, unknown>;
  loadTools: () => Promise<ResolvedTool[]>;
  /** Herramienta de traspaso preferida; si no, la que tenga `pausesBotMinutes`. */
  toolName?: string;
}

export interface HandoffResult {
  /** Alguien del equipo quedó avisado (herramienta del backend o contacto de escalamiento). */
  notified: boolean;
  alreadyHandedOff: boolean;
  /** Texto fijo para la clienta: promete una persona solo si el aviso se verificó. */
  text: string;
}

/**
 * Traspaso hecho por Conduit desde el servidor: llama a la herramienta de
 * traspaso del backend y, si no confirma que avisó a alguien, avisa por los
 * contactos de escalamiento propios. Solo pausa el bot y promete una persona
 * si el aviso se verificó; es idempotente hasta que el bot se reanude.
 */
@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly botEscalation: BotEscalationService,
    private readonly conversationService: ConversationService,
    private readonly repository: IntentRepository,
  ) {}

  isActive(context: Record<string, unknown>, now = Date.now()): boolean {
    const at = context[HANDOFF_AT_KEY];
    const until = context.botPausedUntil;
    return (
      typeof at === 'string' &&
      typeof until === 'string' &&
      new Date(until).getTime() > now
    );
  }

  async perform(request: HandoffRequest): Promise<HandoffResult> {
    const text = (notified: boolean) =>
      this.textFor(request.botConfigId, notified);

    if (
      this.isActive(request.context) ||
      this.inFlight.has(request.conversationId)
    ) {
      return {
        notified: true,
        alreadyHandedOff: true,
        text: await text(true),
      };
    }

    this.inFlight.add(request.conversationId);
    try {
      const tools = await request.loadTools();
      const tool =
        tools.find((t) => t.spec.name === request.toolName) ??
        tools.find((t) => (t.pausesBotMinutes ?? 0) > 0);

      let notified = false;
      if (tool) notified = await this.viaBackend(request, tool);
      if (!notified) notified = await this.viaContacts(request);

      if (notified) {
        await this.conversationService.pauseBot(
          request.conversationId,
          tool?.pausesBotMinutes ?? HANDOFF_PAUSE_MINUTES,
          `Traspaso: ${request.reason}`,
        );
        await this.conversationService.updateContext(request.conversationId, {
          contextPatch: {
            [HANDOFF_AT_KEY]: new Date().toISOString(),
            [HANDOFF_REASON_KEY]: request.reason,
          },
        });
      } else {
        this.logger.error(
          `Traspaso sin nadie a quien avisar (${request.reason}) en ${request.conversationId}: no se pausa el bot ni se promete una persona.`,
        );
      }
      return { notified, alreadyHandedOff: false, text: await text(notified) };
    } finally {
      this.inFlight.delete(request.conversationId);
    }
  }

  /**
   * La propia IA llamó a la herramienta de traspaso: se verifica el aviso y
   * se deja constancia. Devuelve si el bot debe pausarse.
   */
  async afterModelHandoff(
    request: Omit<HandoffRequest, 'loadTools' | 'summary'>,
    responseBody: unknown,
    pauseMinutes: number,
  ): Promise<boolean> {
    const body =
      responseBody && typeof responseBody === 'object'
        ? (responseBody as Record<string, unknown>)
        : {};
    let notified = body.teamNotified !== false;
    if (!notified) notified = await this.viaContacts(request);
    if (!notified) return false;

    await this.conversationService.pauseBot(
      request.conversationId,
      pauseMinutes,
      `Traspaso: ${request.reason}`,
    );
    await this.conversationService.updateContext(request.conversationId, {
      contextPatch: {
        [HANDOFF_AT_KEY]: new Date().toISOString(),
        [HANDOFF_REASON_KEY]: request.reason,
      },
    });
    return true;
  }

  private async viaBackend(
    request: HandoffRequest,
    tool: ResolvedTool,
  ): Promise<boolean> {
    try {
      const needsPhone = tool.injectPhoneParamName !== null;
      if (needsPhone && isLidAddress(request.phoneNumber)) return false;
      const outcome = await this.toolExecutor.execute({
        toolDefinitionId: tool.definitionId,
        conversationId: request.conversationId,
        params: {
          reason: request.reason.slice(0, 300),
          summary: (request.summary ?? request.reason).slice(0, 1000),
        },
        injectedPhone: needsPhone ? request.phoneNumber : undefined,
        phoneParamName: tool.injectPhoneParamName ?? undefined,
        contactAddress: request.phoneNumber,
        turnId: request.turnId,
      });
      if (outcome.status !== 'SUCCESS') return false;
      const body = outcome.responseBody as { teamNotified?: boolean } | null;
      return body?.teamNotified !== false;
    } catch (error) {
      this.logger.error(
        `Falló la herramienta de traspaso: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async viaContacts(
    request: Pick<
      HandoffRequest,
      'tenantId' | 'botConfigId' | 'phoneNumber' | 'reason'
    >,
  ): Promise<boolean> {
    try {
      return await this.botEscalation.notifyContacts(
        request.tenantId,
        request.botConfigId,
        'TECHNICAL_ERROR',
        `⚠️ Traspaso a una persona\n\nChat: ${request.phoneNumber}\nMotivo: ${request.reason}`,
        'traspaso',
      );
    } catch (error) {
      this.logger.error(
        `No fue posible avisar por los contactos de escalamiento: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async textFor(
    botConfigId: string,
    notified: boolean,
  ): Promise<string> {
    const key = notified ? 'rule.handoff' : 'rule.handoff_failed';
    const fallback = notified
      ? DEFAULT_HANDOFF_TEXT
      : DEFAULT_HANDOFF_FAILED_TEXT;
    const set = await this.repository.forBot(botConfigId);
    const variants = set.byKey.get(key)?.variants.default ?? [];
    const pick = variants.length
      ? variants[Math.floor(Math.random() * variants.length)]
      : null;
    return (
      (pick &&
        fillTemplate(pick, { agente: set.agent, negocio: set.business })) ||
      fallback
    );
  }
}
