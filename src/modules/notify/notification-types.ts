/**
 * Catalog of notification types for Universal POS.
 * Tenant enable/disable lives in tenant.settings.notifications.types[code].enabled
 */
export const NOTIFICATION_TYPES = [
  {
    code: 'low_stock',
    label: 'Low stock alerts',
    description:
      'When stock at a branch drops to/below reorder point or runs out',
    defaultEnabled: true,
    defaultRoles: ['manager', 'inventory', 'admin'] as string[],
    urgent: true,
  },
  {
    code: 'daily_sales_summary',
    label: 'Daily sales summary',
    description: 'End-of-day sales snapshot for the branch',
    defaultEnabled: false,
    defaultRoles: ['manager', 'admin', 'accountant'] as string[],
    urgent: false,
  },
  {
    code: 'shift_close',
    label: 'Shift closing reminders',
    description: 'Remind cashiers to close the register before shift end',
    defaultEnabled: false,
    defaultRoles: ['cashier', 'manager', 'admin'] as string[],
    urgent: true,
  },
  {
    code: 'purchase_reminder',
    label: 'Purchase reminders',
    description: 'Reorder prompts and pending/overdue PO follow-ups',
    defaultEnabled: false,
    defaultRoles: ['inventory', 'manager', 'admin'] as string[],
    urgent: false,
  },
  {
    code: 'payment_due',
    label: 'Payment due reminders',
    description: 'Customer receivables and supplier payables due/overdue',
    defaultEnabled: false,
    defaultRoles: ['accountant', 'manager', 'admin'] as string[],
    urgent: false,
  },
  {
    code: 'inventory_alert',
    label: 'Inventory alerts',
    description:
      'Expiry, overstock, negative stock, large adjustments, transfer issues',
    defaultEnabled: false,
    defaultRoles: ['inventory', 'manager', 'admin'] as string[],
    urgent: true,
  },
  {
    code: 'exception_alert',
    label: 'Owner exception alerts',
    description:
      'Group-level exceptions: sales drop, cash mismatch, large refund, overdue AP/AR',
    defaultEnabled: true,
    defaultRoles: ['admin', 'manager', 'accountant'] as string[],
    urgent: true,
  },
] as const;

export type NotificationTypeCode =
  (typeof NOTIFICATION_TYPES)[number]['code'];

export function notificationTypeMeta(code: string) {
  return NOTIFICATION_TYPES.find((t) => t.code === code);
}
