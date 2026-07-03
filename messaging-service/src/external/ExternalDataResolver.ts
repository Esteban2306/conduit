import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { VariableStore } from './VariableStore';

export interface ResolvedExternalData {
  variables: Record<string, string>;
  compiledBlock: string | null;
}

@Injectable()
export class ExternalDataResolver {
  private readonly logger = new Logger(ExternalDataResolver.name);
  private readonly MAX_VARS_IN_PROMPT = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VariableStore,
  ) {}

  async resolve(botConfigId: string): Promise<ResolvedExternalData> {
    const rows = await this.store.get(botConfigId);

    if (rows.length === 0) return { variables: {}, compiledBlock: null };

    const variables = Object.fromEntries(rows.map((r) => [r.fullKey, r.value]));

    const byNamespace: Record<string, string[]> = {};
    for (const row of rows.slice(0, 15)) {
      if (!byNamespace[row.namespace]) byNamespace[row.namespace] = [];
      byNamespace[row.namespace].push(
        `  ${row.key}: ${row.value.slice(0, 80)}`,
      );
    }

    const sections = Object.entries(byNamespace)
      .map(([ns, lines]) => `${ns}:\n${lines.join('\n')}`)
      .join('\n\n');

    const compiledBlock = sections ? `Datos del negocio:\n${sections}` : null;

    return { variables, compiledBlock };
  }

  async resolveForTemplate(
    botConfigId: string,
    templateContent: string,
  ): Promise<string> {
    const matches = templateContent.match(/\{\{ext:(\w+)\}\}/g);
    if (!matches) return templateContent;

    const fullKeys = [
      ...new Set(
        matches.map((m) =>
          m
            .replace(/^\{\{ext:/, '')
            .replace(/\}\}$/, '')
            .trim(),
        ),
      ),
    ];

    const conditions = fullKeys.map((fk) => {
      const dot = fk.indexOf('.');
      return dot === -1
        ? { botConfigId, namespace: 'vars', key: fk }
        : { botConfigId, namespace: fk.slice(0, dot), key: fk.slice(dot + 1) };
    });

    const rows = await this.prisma.externalVariable.findMany({
      where: {
        OR: conditions,
        expiresAt: { gte: new Date() },
      },
      select: { namespace: true, key: true, value: true },
    });

    const valueMap = Object.fromEntries(
      rows.map((r) => [`${r.namespace}.${r.key}`, r.value]),
    );

    return templateContent.replace(
      /\{\{ext:([^}]+)\}\}/g,
      (_, fullKey) =>
        valueMap[fullKey.trim()] ?? `[${fullKey.trim()}: no disponible]`,
    );
  }
}
