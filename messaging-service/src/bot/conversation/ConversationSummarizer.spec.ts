import { ConversationSummarizer } from './ConversationSummarizer';

function setup(result: { content: string; stopReason?: string }) {
  const conversations = {
    getMessagesToSummarize: jest
      .fn()
      .mockResolvedValue({ lines: ['cliente: hola'], upTo: new Date() }),
    findById: jest.fn().mockResolvedValue({ summary: 'resumen previo' }),
    saveSummary: jest.fn().mockResolvedValue(undefined),
  };
  const promptEngine = {
    buildSummaryPrompt: jest
      .fn()
      .mockResolvedValue({ systemPrompt: 'Resume.', maxTokens: 200 }),
  };
  const ai = { generateResponse: jest.fn().mockResolvedValue(result) };
  const summarizer = new ConversationSummarizer(
    conversations as never,
    promptEngine as never,
    ai as never,
  );
  return { summarizer, conversations, ai };
}

describe('ConversationSummarizer', () => {
  it('pide el resumen sin razonamiento, para que el tope de tokens alcance para el texto', async () => {
    const { summarizer, ai } = setup({
      content: 'Quiere agendar.',
      stopReason: 'end_turn',
    });
    await summarizer.refreshIfNeeded('c1', 'b1', 10);
    expect(ai.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningMode: 'OFF' }),
    );
  });

  it('guarda el resumen completo', async () => {
    const { summarizer, conversations } = setup({
      content: 'Quiere agendar.',
      stopReason: 'end_turn',
    });
    await summarizer.refreshIfNeeded('c1', 'b1', 10);
    expect(conversations.saveSummary).toHaveBeenCalledWith(
      'c1',
      'Quiere agendar.',
      expect.any(Date),
    );
  });

  it('no reemplaza el resumen anterior por uno cortado por el tope de tokens', async () => {
    const { summarizer, conversations } = setup({
      content: 'Quiere agendar el alisado el sábado a las',
      stopReason: 'max_tokens',
    });
    await summarizer.refreshIfNeeded('c1', 'b1', 10);
    expect(conversations.saveSummary).not.toHaveBeenCalled();
  });
});
