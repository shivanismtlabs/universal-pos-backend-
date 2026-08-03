import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'StrongPassword', async: false })
export class StrongPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // min 8, upper, lower, digit, special
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,72}$/.test(
      value,
    );
  }

  defaultMessage(): string {
    return 'Password must be 8–72 chars and include upper, lower, number, and special character';
  }
}

export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: StrongPasswordConstraint,
    });
  };
}

export const RESERVED_TENANT_SLUGS = new Set([
  'admin',
  'api',
  'www',
  'app',
  'pos',
  'walit',
  'tuxedo',
  'support',
  'root',
  'system',
  'null',
  'undefined',
]);
