import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { MappedVariable } from './hooks/VariableMapper';
import { SourceVariable } from '@prisma/client';

export interface StoreVariable {
  namespace: string;
  key: string;
  fullKey: string;
  value: string;
  source: string;
  updatedAt: Date;
}

@Injectable()
export class VariableStore {
  private readonly logger = new Logger(VariableStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async save(
    botConfigId: string,
    variables: MappedVariable[],
    source: SourceVariable,
    ttlSeconds?: number,
  ): Promise<number> {
    if (variables.length === 0) return 0;

    const expiresAt = ttlSeconds
      ? new Date(Date.now() + ttlSeconds * 1000)
      : null;

    await Promise.all(
      variables.map((v) =>
        this.prisma.externalVariable.upsert({
          where: {
            botConfigId_namespace_key: {
              botConfigId,
              namespace: v.namespace,
              key: v.key,
            },
          },
          create: {
            botConfigId,
            namespace: v.namespace,
            key: v.key,
            value: v.value,
            source,
            expiresAt,
          },
          update: {
            value: v.value,
            source,
            expiresAt,
            updatedAt: new Date(),
          },
        }),
      ),
    );

    this.logger.log(
      `VariableStore: ${variables.length} variables guardadas para bot ${botConfigId}`,
    );

    return variables.length;
  }

  async get(botConfigId: string, namespace?: string): Promise<StoreVariable[]> {
    const now = new Date();

    const rows = await this.prisma.externalVariable.findMany({
      where: {
        botConfigId,
        ...(namespace ? { namespace } : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });

    return rows.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      fullKey: `${r.namespace}.${r.key}`,
      value: r.value,
      source: r.source,
      updatedAt: r.updatedAt,
    }));
  }

  async delete(botConfigId: string, fullKeys?: string[]): Promise<number> {
    if (fullKeys) {
      const conditions = fullKeys.map((fk) => {
        const dot = fk.indexOf('.');
        return dot === -1
          ? { botConfigId, namespace: 'vars', key: fk }
          : {
              botConfigId,
              namespace: fk.slice(0, dot),
              key: fk.slice(dot + 1),
            };
      });

      const result = await this.prisma.externalVariable.deleteMany({
        where: { OR: conditions },
      });
      return result.count;
    }

    const result = await this.prisma.externalVariable.deleteMany({
      where: { botConfigId },
    });
    return result.count;
  }
}
