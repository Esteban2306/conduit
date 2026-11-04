import { PromptTemplateType } from '@prisma/client';
import { TemplateRepository } from 'src/bot/prompt/repositories/TemplateRepository';

describe('TemplateRepository.upsert', () => {
  it('borra las inactivas antes de desactivar la vigente y sube la versión', async () => {
    const calls: string[] = [];
    const tx = {
      botPromptTemplate: {
        findFirst: jest.fn(() => {
          calls.push('findFirst');
          return Promise.resolve({ version: 2 });
        }),
        deleteMany: jest.fn(() => {
          calls.push('deleteMany');
          return Promise.resolve({ count: 1 });
        }),
        updateMany: jest.fn(() => {
          calls.push('updateMany');
          return Promise.resolve({ count: 1 });
        }),
        create: jest.fn((args: { data: { version: number } }) => {
          calls.push('create');
          return Promise.resolve(args.data);
        }),
      },
    };
    const repo = new TemplateRepository({
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    } as never);

    const created = await repo.upsert(
      'bot',
      PromptTemplateType.CONVERSATION,
      'texto',
    );

    expect(calls).toEqual(['findFirst', 'deleteMany', 'updateMany', 'create']);
    expect(tx.botPromptTemplate.deleteMany).toHaveBeenCalledWith({
      where: {
        botConfigId: 'bot',
        type: 'CONVERSATION',
        isActive: false,
      },
    });
    expect(created).toMatchObject({ version: 3, isActive: true });
  });
});
