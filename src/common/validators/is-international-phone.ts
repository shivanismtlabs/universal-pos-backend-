import {
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/** E.164-ish: 7–15 digits; spaces, dashes, (), + allowed in input */
export function isInternationalPhoneValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 22) return false;
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export function IsInternationalPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isInternationalPhone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: isInternationalPhoneValue,
        defaultMessage: () =>
          'must be a valid phone number (7–15 digits, any country)',
      },
    });
  };
}
