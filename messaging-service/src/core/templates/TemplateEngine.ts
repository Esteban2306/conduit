import { Injectable, BadRequestException } from '@nestjs/common';
import * as Handlebars from 'handlebars';

export interface RenderResult {
  subject?: string;
  body: string;
}

@Injectable()
export class TemplateEngine {
  constructor() {
    this.registerHelpers();
  }

  render(
    bodyHandlebars: string,
    variables: Record<string, unknown>,
    subjectHandlebars?: string,
  ): RenderResult {
    try {
      const body = this.compile(bodyHandlebars, variables);
      const subject = subjectHandlebars
        ? this.compile(subjectHandlebars, variables)
        : undefined;
      return { subject, body };
    } catch (error) {
      throw new BadRequestException(
        `Error al renderizar la plantilla: ${error instanceof Error ? error.message : 'Error desconocido'}`,
      );
    }
  }

  extractVariables(templateBody: string): string[] {
    const ast = Handlebars.parseWithoutProcessing(templateBody);
    const variables: string[] = [];
    this.collectVariables(ast.body, variables);
    return [...new Set(variables)];
  }

  validateVariables(
    templateBody: string,
    variables: Record<string, unknown>,
  ): { valid: boolean; missing: string[] } {
    const required = this.extractVariables(templateBody);
    const missing = required.filter((v) => !(v in variables));
    return { valid: missing.length === 0, missing };
  }

  private compile(
    template: string,
    variables: Record<string, unknown>,
  ): string {
    const compiled = Handlebars.compile(template, { strict: false });
    return compiled(variables);
  }

  private collectVariables(nodes: hbs.AST.Statement[], result: string[]): void {
    for (const node of nodes) {
      if (node.type === 'MustacheStatement') {
        const moustache = node as hbs.AST.MustacheStatement;
        if (moustache.path.type === 'PathExpression') {
          result.push((moustache.path as hbs.AST.PathExpression).original);
        }
      } else if (node.type === 'BlockStatement') {
        const block = node as hbs.AST.BlockStatement;
        this.collectVariables(block.program.body, result);
      }
    }
  }

  private registerHelpers(): void {
    Handlebars.registerHelper('formatDate', (date: string) => {
      if (!date) return '';
      return new Date(date).toLocaleDateString('es-CO', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    });

    Handlebars.registerHelper('formatCurrency', (value: number) => {
      if (value === undefined || value === null) return '';
      return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
      }).format(value);
    });

    Handlebars.registerHelper('uppercase', (str: string) => {
      return str ? str.toUpperCase() : '';
    });

    Handlebars.registerHelper('ifEq', function (a, b, options) {
      return a === b ? options.fn(this) : options.inverse(this);
    });
  }
}
