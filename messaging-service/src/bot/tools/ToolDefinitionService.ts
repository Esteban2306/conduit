import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { ToolSpec } from '../ai/interface/AiProvider';

export interface ResolvedTool {
  spec: ToolSpec;
  definitionId: string;
}

@Injectable()
export class ToolDefinitionService {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveToolsForBot(botConfigId: string): Promise<ResolvedTool[]> {
    const defs = await this.prisma.toolDefinition.findMany({
      where: { botConfigId, isActive: true },
    });

    return defs.map((d) => ({
      definitionId: d.id,
      spec: {
        name: d.name,
        description: d.description,
        parametersSchema: d.parametersSchema as Record<string, any>,
      },
    }));
  }
}
