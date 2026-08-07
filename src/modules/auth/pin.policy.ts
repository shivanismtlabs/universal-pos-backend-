import { BadRequestException } from '@nestjs/common';

const TRIVIAL_PINS = new Set([
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '1234',
  '4321',
  '0123',
  '12345',
  '123456',
  '654321',
  '1122',
  '1212',
]);

/** Reject weak / common counter PINs at set-time. */
export function assertPinAllowed(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) {
    throw new BadRequestException('PIN must be 4–6 digits');
  }
  if (TRIVIAL_PINS.has(pin)) {
    throw new BadRequestException('Choose a less obvious PIN');
  }
  if (/^(\d)\1{3,5}$/.test(pin)) {
    throw new BadRequestException('PIN cannot be the same digit repeated');
  }
  const asc = '0123456789';
  const desc = '9876543210';
  if (asc.includes(pin) || desc.includes(pin)) {
    throw new BadRequestException('PIN cannot be a simple sequence');
  }
}

export function isPinSwitchEnabled(settings: unknown): boolean {
  const s =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};
  const pos =
    s.pos && typeof s.pos === 'object'
      ? (s.pos as Record<string, unknown>)
      : {};
  if (pos.pinSwitchEnabled === false) return false;
  return true;
}
