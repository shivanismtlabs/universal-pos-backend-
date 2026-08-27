import {
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { isInternationalPhoneValue } from './phone.util';

export { isInternationalPhoneValue, canonicalPhoneE164 } from './phone.util';

export function IsInternationalPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isInternationalPhone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isInternationalPhoneValue(value),
        defaultMessage: () =>
          'must be a valid phone number for the selected country',
      },
    });
  };
}
