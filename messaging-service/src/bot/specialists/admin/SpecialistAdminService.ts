import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { canonicalJson } from 'src/bot/tools/json-path.util';
import { resolveUniqueKey, slugifyKey } from 'src/shared/stable-key';
import {
  EMPTY_CONTEXT_SOURCES,
  EMPTY_RULES,
  contextSourcesDocumentSchema,
  rulesDocumentSchema,
} from '../contracts';
import { undeclaredGroundingKeys } from '../grounding-config';
import {
  createSpecialistSchema,
  listSpecialistsSchema,
  parseOrThrow,
  restoreSpecialistSchema,
  updateSpecialistSchema,
} from './specialist-admin.schemas';

const INITIAL_NOTE = 'Versión inicial';

interface Content {
  promptTemplate: string;
  rules: unknown;
  contextSources: unknown;
}

const FULL_SELECT = {
  id: true,
  key: true,
  name: true,
  capability: true,
  status: true,
  promptTemplate: true,
  rules: true,
  contextSources: true,
  outputVersion: true,
  version: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SpecialistSelect;

const VERSION_META_SELECT = {
  version: true,
  changeNote: true,
  createdBy: true,
  createdAt: true,
} satisfies Prisma.SpecialistVersionSelect;

@Injectable()
export class SpecialistAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, actor: string, body: unknown) {
    const input = parseOrThrow(createSpecialistSchema, body);
    const rules = input.rules ?? EMPTY_RULES;
    const contextSources = input.contextSources ?? EMPTY_CONTEXT_SOURCES;
    this.assertCoherent(rules, contextSources);

    const key = input.key
      ? await this.assertKeyFree(tenantId, input.key)
      : await resolveUniqueKey(
          slugifyKey(input.name, 'especialista'),
          async (candidate) =>
            (await this.prisma.specialist.count({
              where: { tenantId, key: candidate },
            })) > 0,
        );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.specialist.create({
          data: {
            tenantId,
            key,
            name: input.name,
            capability: input.capability,
            promptTemplate: input.promptTemplate,
            rules: rules,
            contextSources: contextSources,
          },
          select: FULL_SELECT,
        });
        await tx.specialistVersion.create({
          data: {
            specialistId: created.id,
            tenantId,
            capability: input.capability,
            version: 1,
            promptTemplate: input.promptTemplate,
            rules: rules,
            contextSources: contextSources,
            changeNote: input.changeNote ?? INITIAL_NOTE,
            createdBy: actor,
          },
        });
        return created;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(`La clave "${key}" ya existe.`);
      }
      throw error;
    }
  }

  async list(tenantId: string, query: unknown) {
    const filters = parseOrThrow(listSpecialistsSchema, query);
    const rows = await this.prisma.specialist.findMany({
      where: {
        tenantId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.capability ? { capability: filters.capability } : {}),
        ...(filters.includeArchived ? {} : { archivedAt: null }),
      },
      select: {
        ...FULL_SELECT,
        _count: { select: { bindings: true, models: true } },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      bindingCount: _count.bindings,
      modelCount: _count.models,
    }));
  }

  async get(tenantId: string, id: string) {
    const found = await this.prisma.specialist.findFirst({
      where: { id, tenantId },
      select: FULL_SELECT,
    });
    if (!found) throw new NotFoundException('Especialista no encontrado.');
    return found;
  }

  async getByKey(tenantId: string, key: string) {
    const found = await this.prisma.specialist.findFirst({
      where: { key, tenantId },
      select: FULL_SELECT,
    });
    if (!found) throw new NotFoundException('Especialista no encontrado.');
    return found;
  }

  async update(tenantId: string, actor: string, id: string, body: unknown) {
    const input = parseOrThrow(updateSpecialistSchema, body);
    const current = await this.get(tenantId, id);
    this.assertNotArchived(current);

    const next: Content = {
      promptTemplate: input.promptTemplate ?? current.promptTemplate,
      rules: input.rules ?? current.rules,
      contextSources: input.contextSources ?? current.contextSources,
    };
    this.assertCoherent(next.rules, next.contextSources);

    return this.apply({
      tenantId,
      actor,
      current,
      next,
      changeNote: input.changeNote,
      expectedVersion: input.expectedVersion,
      name: input.name,
      status: input.status,
    });
  }

  async archive(tenantId: string, id: string) {
    const current = await this.get(tenantId, id);
    if (current.archivedAt) return current;

    const live = await this.prisma.botSpecialistBinding.findMany({
      where: { tenantId, specialistId: id, mode: { not: 'OFF' } },
      select: { botConfigId: true, mode: true },
    });
    if (live.length > 0) {
      throw new ConflictException({
        message:
          'El especialista tiene vínculos en uso. Apaga o cambia esos vínculos antes de archivarlo.',
        details: { bindings: live },
      });
    }

    await this.prisma.specialist.updateMany({
      where: { id, tenantId },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
    });
    return this.get(tenantId, id);
  }

  async unarchive(tenantId: string, id: string) {
    await this.get(tenantId, id);
    await this.prisma.specialist.updateMany({
      where: { id, tenantId },
      data: { archivedAt: null },
    });
    return this.get(tenantId, id);
  }

  async listVersions(tenantId: string, id: string) {
    await this.get(tenantId, id);
    return this.prisma.specialistVersion.findMany({
      where: { specialistId: id, tenantId },
      select: VERSION_META_SELECT,
      orderBy: { version: 'desc' },
    });
  }

  async getVersion(tenantId: string, id: string, version: number) {
    await this.get(tenantId, id);
    const found = await this.prisma.specialistVersion.findFirst({
      where: { specialistId: id, tenantId, version },
      select: {
        ...VERSION_META_SELECT,
        promptTemplate: true,
        rules: true,
        contextSources: true,
      },
    });
    if (!found) throw new NotFoundException('Versión no encontrada.');
    return found;
  }

  async restore(
    tenantId: string,
    actor: string,
    id: string,
    version: number,
    body: unknown,
  ) {
    const input = parseOrThrow(restoreSpecialistSchema, body);
    const current = await this.get(tenantId, id);
    this.assertNotArchived(current);
    const snapshot = await this.getVersion(tenantId, id, version);

    const rules = rulesDocumentSchema.safeParse(snapshot.rules);
    const sources = contextSourcesDocumentSchema.safeParse(
      snapshot.contextSources,
    );
    if (!rules.success || !sources.success) {
      throw new BadRequestException(
        'La versión guardada ya no cumple los contratos actuales y no se puede restaurar.',
      );
    }
    this.assertCoherent(rules.data, sources.data);

    const next: Content = {
      promptTemplate: snapshot.promptTemplate,
      rules: rules.data,
      contextSources: sources.data,
    };
    if (this.sameContent(current, next)) {
      throw new BadRequestException(
        'La versión indicada ya coincide con el contenido actual.',
      );
    }

    return this.apply({
      tenantId,
      actor,
      current,
      next,
      changeNote: input.changeNote ?? `Restaurada la versión ${version}`,
      expectedVersion: input.expectedVersion,
    });
  }

  private async apply(args: {
    tenantId: string;
    actor: string;
    current: Awaited<ReturnType<SpecialistAdminService['get']>>;
    next: Content;
    changeNote?: string;
    expectedVersion?: number;
    name?: string;
    status?: 'ACTIVE' | 'INACTIVE';
  }) {
    const { tenantId, actor, current, next } = args;
    if (
      args.expectedVersion !== undefined &&
      args.expectedVersion !== current.version
    ) {
      throw this.versionConflict(current.version);
    }

    const contentChanged = !this.sameContent(current, next);
    const data: Prisma.SpecialistUpdateManyMutationInput = {
      updatedAt: new Date(),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(contentChanged
        ? {
            promptTemplate: next.promptTemplate,
            rules: next.rules as Prisma.InputJsonValue,
            contextSources: next.contextSources as Prisma.InputJsonValue,
            version: { increment: 1 },
          }
        : {}),
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.specialist.updateMany({
          where: {
            id: current.id,
            tenantId,
            ...(contentChanged || args.expectedVersion !== undefined
              ? { version: current.version }
              : {}),
          },
          data,
        });
        if (updated.count !== 1) {
          throw this.versionConflict(undefined);
        }
        if (contentChanged) {
          await tx.specialistVersion.create({
            data: {
              specialistId: current.id,
              tenantId,
              capability: current.capability,
              version: current.version + 1,
              promptTemplate: next.promptTemplate,
              rules: next.rules as Prisma.InputJsonValue,
              contextSources: next.contextSources as Prisma.InputJsonValue,
              changeNote: args.changeNote ?? null,
              createdBy: actor,
            },
          });
        }
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw this.versionConflict(undefined);
      throw error;
    }

    return this.get(tenantId, current.id);
  }

  private sameContent(current: Content, next: Content): boolean {
    return (
      current.promptTemplate === next.promptTemplate &&
      canonicalJson(current.rules) === canonicalJson(next.rules) &&
      canonicalJson(current.contextSources) ===
        canonicalJson(next.contextSources)
    );
  }

  private assertCoherent(rules: unknown, contextSources: unknown): void {
    const parsedRules = rulesDocumentSchema.safeParse(rules);
    const parsedSources =
      contextSourcesDocumentSchema.safeParse(contextSources);
    if (!parsedRules.success || !parsedSources.success) {
      throw new BadRequestException(
        'Las reglas o las fuentes de contexto no son válidas.',
      );
    }
    const undeclared = undeclaredGroundingKeys(
      parsedRules.data,
      parsedSources.data.sources,
    );
    if (undeclared.length > 0) {
      throw new BadRequestException({
        message:
          'Hay reglas que citan datos de contexto que no están declarados en contextSources.',
        details: { undeclaredKeys: undeclared },
      });
    }
  }

  private assertNotArchived(specialist: { archivedAt: Date | null }): void {
    if (specialist.archivedAt) {
      throw new ConflictException(
        'El especialista está archivado: desarchívalo para modificarlo.',
      );
    }
  }

  private async assertKeyFree(tenantId: string, key: string): Promise<string> {
    const exists = await this.prisma.specialist.count({
      where: { tenantId, key },
    });
    if (exists > 0) throw new ConflictException(`La clave "${key}" ya existe.`);
    return key;
  }

  private versionConflict(currentVersion: number | undefined) {
    return new ConflictException({
      message:
        'El especialista cambió mientras lo editabas. Recarga la versión actual y vuelve a intentarlo.',
      ...(currentVersion !== undefined ? { details: { currentVersion } } : {}),
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
