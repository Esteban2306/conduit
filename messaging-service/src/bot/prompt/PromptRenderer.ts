import { Injectable } from '@nestjs/common';
import { ResolvedVariables } from './VariableResolver';

@Injectable()
export class PromptRenderer {
  render(template: string, vars: ResolvedVariables): string {
    let result = template.replace(
      /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_, key, content) => {
        const value = (vars as any)[key];
        return value?.toString().trim() ? content : '';
      },
    );

    result = result.replace(
      /\{\{(\w+)\}\}/g,
      (_, key) => (vars as any)[key] ?? '',
    );

    return result.replace(/\n{3,}/g, '\n\n').trim();
  }
}
