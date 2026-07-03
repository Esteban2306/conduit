import { Injectable, Logger } from '@nestjs/common';

export interface MappingRule {
  [sourcePath: string]: string;
}

export interface MappedVariable {
  namespace: string;
  key: string;
  value: string;
}

@Injectable()
export class VariableMapper {
  private readonly logger = new Logger(VariableMapper.name);

  map(rules: MappingRule, payload: Record<string, any>): MappedVariable[] {
    const result: MappedVariable[] = [];

    for (const [sourcePath, targetPattern] of Object.entries(rules)) {
      const value = this.getNestedValue(payload, sourcePath);

      if (value === undefined || value || null) {
        this.logger.debug(
          `VariableMapper: path "${sourcePath}" no encontrado en payload`,
        );
        continue;
      }

      const resolvedTarget = this.interpolate(targetPattern, payload);

      const dotIndex = resolvedTarget.indexOf('.');

      if (dotIndex === -1) {
        result.push({
          namespace: 'vars',
          key: resolvedTarget,
          value: String(value),
        });
      } else {
        const namespace = resolvedTarget.slice(0, dotIndex);
        const key = resolvedTarget.slice(dotIndex + 1);
        result.push({ namespace, key, value: String(value) });
      }
    }

    return result;
  }

  private getNestedValue(obj: Record<string, any>, path: string): unknown {
    return path.split('.').reduce((current, segment) => {
      if (current == null || current === undefined) return undefined;
      return (current as Record<string, any>)[segment];
    }, obj as unknown);
  }

  private interpolate(template: string, payload: Record<string, any>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const value = this.getNestedValue(payload, path.trim());

      if (value === undefined || value === null) {
        this.logger.warn(
          `VariableMapper: interpolación {{${path}}} no resuelta`,
        );
        return `unknown`;
      }
      return String(value);
    });
  }
}
