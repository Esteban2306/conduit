import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';
import { AiOrchestrator } from 'src/bot/ai/AiOrchestrator';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { ConversationService } from 'src/bot/conversation/ConversationService';
import { HandoffService } from 'src/bot/handoff/Handoff.service';
import { HardRulesService } from 'src/bot/intent/HardRules.service';
import { IntentAiClassifier } from 'src/bot/intent/IntentAiClassifier';
import { IntentHandler } from 'src/bot/intent/IntentHandler';
import { IntentRepository } from 'src/bot/intent/IntentRepository.service';
import { IntentResolver } from 'src/bot/intent/IntentResolver';
import { IntentMetricsService } from 'src/bot/intent/intent-metrics.service';
import { BotEscalationService } from 'src/bot/tools/BotEscalation.service';
import { ToolExecutorService } from 'src/bot/tools/ToolExecutor.service';
import { PrismaService } from 'src/shared/prisma.service';

describe('Despachador de intenciones · cableado de Nest', () => {
  it('el grafo de dependencias del despachador se resuelve completo', async () => {
    const stub = { provide: undefined as unknown, useValue: {} };
    const module = await Test.createTestingModule({
      providers: [
        IntentResolver,
        IntentRepository,
        HardRulesService,
        HandoffService,
        IntentAiClassifier,
        IntentMetricsService,
        IntentHandler,
        ...[
          PrismaService,
          BotConfigService,
          ConfigService,
          WhatsAppContactService,
          ConversationService,
          BotEscalationService,
          AiOrchestrator,
          ToolExecutorService,
        ].map((token) => ({ ...stub, provide: token })),
      ],
    }).compile();
    expect(module.get(IntentHandler)).toBeInstanceOf(IntentHandler);
  });
});
