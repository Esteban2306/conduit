import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { ToolSpec } from '../ai/interface/AiProvider';
import { BotConfigService } from '../config/BotConfigService';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { CreateToolDefinitionDto } from './dto/create-tool-definition.dto';
import { UpdateToolDefinitionDto } from './dto/update-tool-definition.dto';
import { Prisma, VerificationVerdict } from '@prisma/client';
import { ACCEPTABLE_TOOL_VERDICTS } from '../specialists/constants';
import { stripSchemaPath } from './json-path.util';
import { declaredOutputSchemaSchema } from '../specialists/contracts';
import {
  PARAM_PATH_PATTERN,
  pathsOverlap,
  readVerifiedParams,
  verifiedParamsSchema,
} from './verified-params';

export interface ResolvedTool {
  spec: ToolSpec;
  definitionId: string;
  requiresImageAttachment: boolean;
  imageParamName: string | null;
  maxImageSizeBytes: number | null;
  injectPhoneParamName: string | null;
  pausesBotMinutes: number | null;
  readOnly: boolean;
  verificationCapability: string | null;
}

@Injectable()
export class ToolDefinitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botConfigService: BotConfigService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async list(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    return this.prisma.toolDefinition.findMany({
      where: { botConfigId },
      select: this.safeSelect(),
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    botConfigId: string,
    tenantId: string,
    dto: CreateToolDefinitionDto,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    this.validate(dto);
    const variables = await this.requireBinding(
      botConfigId,
      dto.verificationCapability,
    );
    this.validateVerification({
      verificationCapability: dto.verificationCapability ?? null,
      verifiedParams: dto.verifiedParams ?? {},
      variables,
      imageParamName: dto.imageParamName ?? 'imageBase64',
      injectPhoneParamName: dto.injectPhoneParamName ?? null,
      verificationParamName: dto.verificationParamName ?? null,
      acceptedVerdicts: dto.acceptedVerdicts ?? [],
      requiresImageAttachment: dto.requiresImageAttachment ?? false,
      httpMethod: dto.httpMethod ?? 'POST',
      hasSecret: Boolean(dto.authSecret),
    });

    return this.prisma.toolDefinition.create({
      data: {
        botConfigId,
        name: dto.name,
        description: dto.description,
        parametersSchema: dto.parametersSchema as Prisma.InputJsonValue,
        endpointUrl: dto.endpointUrl,
        httpMethod: dto.httpMethod ?? 'POST',
        authHeaderName: dto.authHeaderName,
        authSecretEncrypted: dto.authSecret
          ? this.encryption.encrypt(dto.authSecret)
          : undefined,
        isActive: dto.isActive ?? true,
        requiresImageAttachment: dto.requiresImageAttachment ?? false,
        imageParamName: dto.imageParamName,
        maxImageSizeBytes: dto.maxImageSizeBytes,
        injectPhoneParamName: dto.injectPhoneParamName,
        pausesBotMinutes: dto.pausesBotMinutes,
        verificationCapability: dto.verificationCapability,
        acceptedVerdicts: (dto.acceptedVerdicts ?? []) as VerificationVerdict[],
        verificationParamName: dto.verificationParamName,
        verifiedParams: dto.verifiedParams ?? {},
      },
      select: this.safeSelect(),
    });
  }

  async update(
    botConfigId: string,
    toolId: string,
    tenantId: string,
    dto: UpdateToolDefinitionDto,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const existing = await this.prisma.toolDefinition.findFirst({
      where: { id: toolId, botConfigId },
    });
    if (!existing) throw new NotFoundException('Tool no encontrada.');
    this.validate(dto, true);
    const capability =
      dto.verificationCapability !== undefined
        ? dto.verificationCapability
        : existing.verificationCapability;
    const variables = await this.requireBinding(botConfigId, capability);
    this.validateVerification({
      verificationCapability: capability,
      verifiedParams:
        dto.verifiedParams ??
        (existing.verifiedParams as Record<string, string>),
      variables,
      imageParamName:
        (dto.imageParamName !== undefined
          ? dto.imageParamName
          : existing.imageParamName) ?? 'imageBase64',
      injectPhoneParamName:
        dto.injectPhoneParamName !== undefined
          ? dto.injectPhoneParamName
          : existing.injectPhoneParamName,
      verificationParamName:
        dto.verificationParamName !== undefined
          ? dto.verificationParamName
          : existing.verificationParamName,
      acceptedVerdicts: dto.acceptedVerdicts ?? existing.acceptedVerdicts,
      requiresImageAttachment:
        dto.requiresImageAttachment ?? existing.requiresImageAttachment,
      httpMethod: dto.httpMethod ?? existing.httpMethod,
      hasSecret: dto.clearAuth
        ? false
        : Boolean(dto.authSecret) || Boolean(existing.authSecretEncrypted),
    });

    const {
      clearAuth,
      authSecret,
      parametersSchema,
      acceptedVerdicts,
      verifiedParams,
      ...changes
    } = dto;

    return this.prisma.toolDefinition.update({
      where: { id: toolId },
      data: {
        ...changes,

        ...(acceptedVerdicts !== undefined
          ? { acceptedVerdicts: acceptedVerdicts as VerificationVerdict[] }
          : {}),

        ...(verifiedParams !== undefined ? { verifiedParams } : {}),

        ...(parametersSchema !== undefined
          ? {
              parametersSchema: parametersSchema as Prisma.InputJsonValue,
            }
          : {}),

        ...(authSecret
          ? {
              authSecretEncrypted: this.encryption.encrypt(authSecret),
            }
          : {}),

        ...(clearAuth
          ? {
              authHeaderName: null,
              authSecretEncrypted: null,
            }
          : {}),
      },
      select: this.safeSelect(),
    });
  }

  async remove(botConfigId: string, toolId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const { count } = await this.prisma.toolDefinition.deleteMany({
      where: { id: toolId, botConfigId },
    });
    if (!count) throw new NotFoundException('Tool no encontrada.');
  }

  async getActiveToolsForBot(botConfigId: string): Promise<ResolvedTool[]> {
    const defs = await this.prisma.toolDefinition.findMany({
      where: { botConfigId, isActive: true },
    });

    return defs.map((d) => {
      const fullSchema = d.parametersSchema as Record<string, any>;
      const fieldsToStrip: string[] = [];
      if (d.requiresImageAttachment) {
        fieldsToStrip.push(d.imageParamName ?? 'imageBase64');
      }
      if (d.injectPhoneParamName) {
        fieldsToStrip.push(d.injectPhoneParamName);
      }
      if (d.verificationParamName) {
        fieldsToStrip.push(d.verificationParamName);
      }
      fieldsToStrip.push(...Object.keys(readVerifiedParams(d.verifiedParams)));
      const exposedSchema =
        fieldsToStrip.length > 0
          ? this.stripFields(fullSchema, fieldsToStrip)
          : fullSchema;
      return {
        definitionId: d.id,
        spec: {
          name: d.name,
          description: d.description,
          parametersSchema: exposedSchema,
        },
        requiresImageAttachment: d.requiresImageAttachment,
        imageParamName: d.imageParamName,
        maxImageSizeBytes: d.maxImageSizeBytes,
        injectPhoneParamName: d.injectPhoneParamName,
        pausesBotMinutes: d.pausesBotMinutes,
        verificationCapability: d.verificationCapability,
        readOnly: ['GET', 'HEAD'].includes(
          (d.httpMethod ?? 'POST').toUpperCase(),
        ),
      };
    });
  }

  private stripFields(
    schema: Record<string, any>,
    fieldNames: string[],
  ): Record<string, any> {
    return fieldNames.reduce(
      (current, field) => stripSchemaPath(current, field),
      schema,
    );
  }

  private validate(
    dto: Partial<CreateToolDefinitionDto>,
    isUpdate = false,
  ): void {
    if (!isUpdate && !dto.parametersSchema) {
      throw new BadRequestException('parametersSchema es obligatorio.');
    }
    if (dto.parametersSchema && dto.parametersSchema.type !== 'object') {
      throw new BadRequestException(
        'parametersSchema debe ser un JSON Schema de tipo object.',
      );
    }
    if (dto.authSecret && !dto.authHeaderName && !isUpdate) {
      throw new BadRequestException(
        'authHeaderName es obligatorio cuando se configura authSecret.',
      );
    }
  }

  private async requireBinding(
    botConfigId: string,
    capability: string | null | undefined,
  ): Promise<Set<string>> {
    if (!capability) return new Set();
    const binding = await this.prisma.botSpecialistBinding.findFirst({
      where: { botConfigId, capability },
      select: { id: true, specialist: { select: { outputSchema: true } } },
    });
    if (!binding) {
      throw new BadRequestException(
        `El bot no tiene un especialista vinculado a la capacidad "${capability}". Vincúlalo antes de exigirla en una herramienta.`,
      );
    }
    const schema = declaredOutputSchemaSchema.safeParse(
      binding.specialist?.outputSchema,
    );
    return new Set(
      schema.success ? schema.data.variables.map((v) => v.name) : [],
    );
  }

  private validateVerification(state: {
    verificationCapability: string | null;
    acceptedVerdicts: readonly string[];
    requiresImageAttachment: boolean;
    httpMethod: string;
    hasSecret: boolean;
    verifiedParams: Record<string, string>;
    variables: ReadonlySet<string>;
    imageParamName: string;
    injectPhoneParamName: string | null;
    verificationParamName: string | null;
  }): void {
    const mapped = Object.keys(state.verifiedParams ?? {});
    if (!state.verificationCapability) {
      if (mapped.length > 0) {
        throw new BadRequestException(
          'verifiedParams solo se permite en herramientas con verificación (verificationCapability).',
        );
      }
      return;
    }

    if (!state.requiresImageAttachment) {
      throw new BadRequestException(
        'Una herramienta con verificación debe exigir una imagen adjunta (requiresImageAttachment).',
      );
    }
    if (['GET', 'HEAD'].includes(state.httpMethod.toUpperCase())) {
      throw new BadRequestException(
        'Una herramienta con verificación no puede ser de solo lectura.',
      );
    }
    if (state.acceptedVerdicts.length === 0) {
      throw new BadRequestException(
        `acceptedVerdicts debe listar al menos un veredicto aceptado (${ACCEPTABLE_TOOL_VERDICTS.join(', ')}).`,
      );
    }
    if (!state.hasSecret) {
      throw new BadRequestException(
        'Una herramienta con verificación necesita authSecret: con él se firma el pasaporte que recibe el backend.',
      );
    }
    this.validateVerifiedParams(state);
  }

  private validateVerifiedParams(state: {
    verifiedParams: Record<string, string>;
    variables: ReadonlySet<string>;
    imageParamName: string;
    injectPhoneParamName: string | null;
    verificationParamName: string | null;
  }): void {
    const parsed = verifiedParamsSchema.safeParse(state.verifiedParams ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        `verifiedParams no es válido: ${parsed.error.issues[0]?.message ?? 'formato incorrecto'}.`,
      );
    }
    const paths = Object.keys(parsed.data);
    const reserved = [
      state.imageParamName,
      state.injectPhoneParamName,
      state.verificationParamName,
    ].filter(
      (p): p is string => typeof p === 'string' && PARAM_PATH_PATTERN.test(p),
    );
    paths.forEach((path, i) => {
      const variable = parsed.data[path];
      if (!state.variables.has(variable)) {
        throw new BadRequestException(
          `verifiedParams: el especialista vinculado no declara la variable "${variable}".`,
        );
      }
      if (reserved.some((r) => pathsOverlap(path, r))) {
        throw new BadRequestException(
          `verifiedParams: "${path}" choca con un parámetro que Conduit ya gestiona (imagen, teléfono o pasaporte).`,
        );
      }
      if (paths.slice(i + 1).some((other) => pathsOverlap(path, other))) {
        throw new BadRequestException(
          `verifiedParams: "${path}" se solapa con otra ruta declarada.`,
        );
      }
    });
  }

  private safeSelect() {
    return {
      id: true,
      botConfigId: true,
      name: true,
      description: true,
      parametersSchema: true,
      endpointUrl: true,
      httpMethod: true,
      authHeaderName: true,
      isActive: true,
      requiresImageAttachment: true,
      imageParamName: true,
      maxImageSizeBytes: true,
      injectPhoneParamName: true,
      pausesBotMinutes: true,
      verificationCapability: true,
      acceptedVerdicts: true,
      verificationParamName: true,
      verifiedParams: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}
