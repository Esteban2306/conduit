import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';

export interface KnowledgeBlock {
  label: string;
  content: string;
  tokenEstimate: number;
}

export interface AssembledKnowledge {
  blocks: KnowledgeBlock[];
  totalTokenEstimate: number;
  compiled: string | null;
}

@Injectable()
export class KnowledgeAssembler {
  private readonly logger = new Logger(KnowledgeAssembler.name);
  private readonly MAX_TONKENS = 400;

  constructor(private readonly prisma: PrismaService) {}

  async assemble(botConfigId: string): Promise<AssembledKnowledge> {
    const blocks: KnowledgeBlock[] = [];

    const textBlocks = await this.loadTextKnowledge(botConfigId);

    blocks.push(...textBlocks);

    const compiled = this.compile(blocks);

    return {
      blocks,
      totalTokenEstimate: Math.ceil((compiled?.length ?? 0) / 4),
      compiled,
    };
  }

  private async loadTextKnowledge(
    botConfigId: string,
  ): Promise<KnowledgeBlock[]> {
    return [];
  }

  private compile(blocks: KnowledgeBlock[]): string | null {
    if (blocks.length === 0) return null;

    const maxChars = this.MAX_TONKENS * 4;
    let total = 0;
    const parts: string[] = [];

    for (const block of blocks) {
      const blockText = `${block.label}:\n${block.content}`;
      if (total + blockText.length > maxChars) {
        this.logger.warn(
          `KnowledgeAssembler: bloque "${block.label}" omitido por límite de tokens`,
        );
        break;
      }
      parts.push(blockText);
      total += blockText.length;
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
