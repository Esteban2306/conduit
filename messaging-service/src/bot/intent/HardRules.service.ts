import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';
import { ConversationService } from '../conversation/ConversationService';
import { BotEscalationService } from '../tools/BotEscalation.service';
import {
  DEFAULT_RULE_TEXTS,
  HardRuleDetector,
  HardRuleHit,
} from './hard-rules';
import { IntentRepository } from './IntentRepository.service';
import { IntentMetricsService } from './intent-metrics.service';
import { IntentTurn, OPTED_OUT_KEY } from './intent-turn';
import { RuleKey } from './intent-types';
import { fillTemplate } from './render-spec';

const ABUSE_WINDOW_MS = 60 * 60 * 1000;
const SILENCE_MINUTES = 60;

/**
 * Paso 0 del despachador: reglas duras sin IA. Opt-out (silencio en el chat y
 * marca del contacto para que no reciba marketing), abuso (aviso fijo y al
 * equipo; si insiste, silencio temporal) y spam (silencio temporal y aviso).
 * Cada regla se activa por bot con su clave `rule.*` (por defecto en SOMBRA).
 */
@Injectable()
export class HardRulesService {
  private readonly logger = new Logger(HardRulesService.name);
  private readonly detector = new HardRuleDetector();

  constructor(
    private readonly repository: IntentRepository,
    private readonly contacts: WhatsAppContactService,
    private readonly conversationService: ConversationService,
    private readonly botEscalation: BotEscalationService,
    private readonly metrics: IntentMetricsService,
  ) {}

  /** `true` si el turno quedó resuelto (con respuesta o en silencio). */
  async apply(turn: IntentTurn): Promise<boolean> {
    const optedOutAt = turn.context[OPTED_OUT_KEY];
    const optedOut = typeof optedOutAt === 'string';

    const hit = this.detector.detect(turn.text, turn.conversationId, optedOut);

    if (optedOut) {
      if (hit?.rule === 'opt_in') return this.optIn(turn);
      this.metrics.count('rule:opted-out-silent');
      return true;
    }
    if (!hit) return false;

    const key = `rule.${hit.rule}` as RuleKey;
    const set = await this.repository.forBot(turn.botConfigId);
    const mode = set.modeOf(key);
    if (mode === 'OFF') return false;
    if (mode === 'SHADOW') {
      this.metrics.count(`rule:${hit.rule}:shadow`);
      this.logger.log(
        `regla=${hit.rule} modo=SHADOW conv=${turn.conversationId}`,
      );
      return false;
    }

    switch (hit.rule) {
      case 'opt_out':
        return this.optOut(turn, key);
      case 'abuse':
        return this.abuse(turn, key);
      case 'spam':
        return this.spam(turn, hit);
      default:
        return false;
    }
  }

  private async optOut(turn: IntentTurn, key: RuleKey): Promise<boolean> {
    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { [OPTED_OUT_KEY]: new Date().toISOString() },
    });
    await this.contacts
      .setOptOut(turn.connectionId, turn.phoneNumber, true)
      .catch((error: unknown) =>
        this.logger.error(
          `No fue posible marcar el opt-out del contacto: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    await turn.send(await this.textFor(turn, key, DEFAULT_RULE_TEXTS.opt_out));
    this.metrics.count('rule:opt_out:handled');
    return true;
  }

  private async optIn(turn: IntentTurn): Promise<boolean> {
    const set = await this.repository.forBot(turn.botConfigId);
    if (set.modeOf('rule.opt_in') === 'OFF') {
      this.metrics.count('rule:opted-out-silent');
      return true;
    }
    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { [OPTED_OUT_KEY]: null },
    });
    await this.contacts
      .setOptOut(turn.connectionId, turn.phoneNumber, false)
      .catch(() => undefined);
    await turn.send(
      await this.textFor(turn, 'rule.opt_in', DEFAULT_RULE_TEXTS.opt_in),
    );
    this.metrics.count('rule:opt_in:handled');
    return true;
  }

  private async abuse(turn: IntentTurn, key: RuleKey): Promise<boolean> {
    const previous = turn.context.abuseAt;
    const repeated =
      typeof previous === 'string' &&
      Date.now() - new Date(previous).getTime() < ABUSE_WINDOW_MS;
    const nowIso = new Date().toISOString();

    if (repeated) {
      await this.conversationService.pauseBot(
        turn.conversationId,
        SILENCE_MINUTES,
        'Abuso reiterado',
      );
      await this.conversationService.updateContext(turn.conversationId, {
        contextPatch: { abuseAt: nowIso },
      });
      this.metrics.count('rule:abuse:silenced');
      return true;
    }

    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { abuseAt: nowIso },
    });
    await turn.send(await this.textFor(turn, key, DEFAULT_RULE_TEXTS.abuse));
    await this.notifyTeam(
      turn,
      `Mensaje ofensivo de ${turn.phoneNumber}. El bot respondió con un aviso fijo; revisa el chat.`,
    );
    this.metrics.count('rule:abuse:handled');
    return true;
  }

  private async spam(
    turn: IntentTurn,
    hit: Extract<HardRuleHit, { rule: 'spam' }>,
  ): Promise<boolean> {
    await this.conversationService.pauseBot(
      turn.conversationId,
      SILENCE_MINUTES,
      `Spam (${hit.reason})`,
    );
    const previous = turn.context.spamNotifiedAt;
    const notified =
      typeof previous === 'string' &&
      Date.now() - new Date(previous).getTime() < ABUSE_WINDOW_MS;
    if (!notified) {
      await this.conversationService.updateContext(turn.conversationId, {
        contextPatch: { spamNotifiedAt: new Date().toISOString() },
      });
      await this.notifyTeam(
        turn,
        `Posible spam de ${turn.phoneNumber} (${hit.reason}). El bot quedó en silencio ${SILENCE_MINUTES} min en ese chat.`,
      );
    }
    this.metrics.count('rule:spam:silenced');
    return true;
  }

  private async textFor(
    turn: IntentTurn,
    key: RuleKey,
    defaults: string[],
  ): Promise<string> {
    const set = await this.repository.forBot(turn.botConfigId);
    const vars = { agente: set.agent, negocio: set.business };
    const configured = set.byKey.get(key)?.variants.default ?? [];
    for (const list of [configured, defaults]) {
      if (list.length === 0) continue;
      const pick = list[Math.floor(Math.random() * list.length)];
      const text = fillTemplate(pick, vars);
      if (text !== null) return text;
    }
    return defaults[0] ?? '';
  }

  private async notifyTeam(turn: IntentTurn, message: string): Promise<void> {
    try {
      await this.botEscalation.notifyContacts(
        turn.tenantId,
        turn.botConfigId,
        'TECHNICAL_ERROR',
        `⚠️ ${message}`,
        'regla dura',
      );
    } catch (error) {
      this.logger.error(
        `No fue posible avisar al equipo: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
