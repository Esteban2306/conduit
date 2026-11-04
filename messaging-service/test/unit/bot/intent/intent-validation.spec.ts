import {
  checkPattern,
  validateIntentInput,
} from 'src/bot/intent/intent-validation';
import { SPA_SEEDS } from './fixture';

const base = {
  key: 'mi_plantilla',
  name: 'Mi plantilla',
  handler: 'TEMPLATE',
  patterns: ['^promo$'],
  variants: { default: ['Hola {{agente}}'] },
};

describe('validateIntentInput', () => {
  it.each(SPA_SEEDS.map((s) => [s.key, s]))(
    'el catálogo del spa es válido: %s',
    (_key, seed) => {
      const { lockedMode, ...definition } = seed;
      void lockedMode;
      expect(validateIntentInput(definition)).toEqual([]);
    },
  );

  it('acepta una plantilla simple creada por el negocio', () => {
    expect(validateIntentInput(base)).toEqual([]);
  });

  it('exige clave válida, nombre, manejador y al menos un patrón', () => {
    expect(validateIntentInput({ ...base, key: 'Mala Clave' })[0]).toMatch(
      /key/,
    );
    expect(validateIntentInput({ ...base, name: '' })).toContain(
      'name requerido',
    );
    expect(validateIntentInput({ ...base, handler: 'OTRO' })[0]).toMatch(
      /handler/,
    );
    expect(validateIntentInput({ ...base, patterns: [] })).toContain(
      'patterns necesita al menos un patrón',
    );
  });

  it('rechaza patrones inválidos, enormes, con retroceso catastrófico o lentos', () => {
    expect(checkPattern('(')).toMatch(/inválido/);
    expect(checkPattern('a'.repeat(600))).toMatch(/supera/);
    expect(checkPattern('(a+)+$')).toMatch(/anidados/);
    expect(checkPattern('(.*)*x')).toMatch(/anidados/);
    expect(checkPattern('')).toMatch(/no vacío/);
    expect(checkPattern('^hola(?: que tal)?$')).toBeNull();
  });

  it('exige texto por defecto en plantillas y valida variables', () => {
    expect(validateIntentInput({ ...base, variants: {} })).toContain(
      'variants.default requerido',
    );
    expect(
      validateIntentInput({
        ...base,
        variants: { default: ['Hola {{secreto}}'] },
      }).join(' '),
    ).toMatch(/secreto/);
    expect(
      validateIntentInput({
        ...base,
        variants: { default: ['x'.repeat(1100)] },
      }).join(' '),
    ).toMatch(/1000/);
  });

  it('TOOL_DIRECT necesita herramienta, render y un texto por cada rama', () => {
    const tool = {
      ...base,
      handler: 'TOOL_DIRECT',
      config: {
        tool: 'info',
        render: { branches: [{ variant: 'a', vars: { x: { path: 'x' } } }] },
      },
      variants: { a: ['Dato: {{x}}'] },
    };
    expect(validateIntentInput(tool)).toEqual([]);
    expect(
      validateIntentInput({ ...tool, config: { tool: 'info' } }),
    ).toContain('render requerido');
    expect(
      validateIntentInput({ ...tool, variants: { b: ['x'] } }).join(' '),
    ).toMatch(/falta variants\.a/);
    expect(
      validateIntentInput({
        ...tool,
        variants: { a: ['Dato: {{y}}'] },
      }).join(' '),
    ).toMatch(/\{\{y\}\}/);
  });

  it('$entity exige que un patrón capture el grupo entity', () => {
    const tool = {
      ...base,
      handler: 'TOOL_DIRECT',
      config: {
        tool: 'info',
        params: { q: '$entity' },
        render: { branches: [{ variant: 'a' }] },
      },
      variants: { a: ['x'] },
    };
    expect(validateIntentInput(tool).join(' ')).toMatch(/entity/);
    expect(
      validateIntentInput({
        ...tool,
        patterns: ['^precio (?<entity>[a-z ]+)$'],
      }),
    ).toEqual([]);
  });

  it('HANDOFF y LLM_SLIM exigen su configuración', () => {
    expect(
      validateIntentInput({ ...base, handler: 'HANDOFF', config: {} }),
    ).toContain('config.reason requerido en HANDOFF');
    const slim = { ...base, handler: 'LLM_SLIM', patterns: [], variants: {} };
    expect(validateIntentInput(slim).join(' ')).toMatch(/slim\.prompt/);
    expect(
      validateIntentInput({
        ...slim,
        config: { slim: { prompt: 'Hola', tools: ['a'] } },
      }),
    ).toEqual([]);
  });

  it('valida programación, rangos y claves reservadas', () => {
    expect(
      validateIntentInput({
        ...base,
        schedule: { timeZone: 'No/Existe' },
      }).join(' '),
    ).toMatch(/Zona horaria/);
    expect(validateIntentInput({ ...base, maxTokens: 500 }).join(' ')).toMatch(
      /maxTokens/,
    );
    expect(
      validateIntentInput({
        ...base,
        key: 'rule.inventada',
        patterns: [],
      }).join(' '),
    ).toMatch(/reservada/);
    expect(
      validateIntentInput({ ...base, key: 'rule.abuse', patterns: [] }),
    ).toEqual([]);
  });
});
