import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export function HasTemplateSource(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'hasTemplateSource',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const target = args.object as { id?: string; inline?: unknown };
          return Boolean(target.id) || Boolean(target.inline);
        },
        defaultMessage(_args: ValidationArguments) {
          return 'Debes proveer template.id o template.inline, no pueden estar ambos vacíos';
        },
      },
    });
  };
}
