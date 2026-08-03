/**
 * Demo shop seed for Walit POS local testing.
 *
 * Login (frontend /login):
 *   Tenant slug: demo-shop
 *   Email:       owner@crown.demo  (admin)
 *   Password:    WalitShop@2026
 *   Also: manager@ / cashier@ / fitter@ / stock@ crown.demo
 *
 * Run: npm run db:seed
 */
import {
  AppointmentType,
  AvailabilityStatus,
  OrderItemType,
  OrderStatus,
  Ownership,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  PrismaClient,
  UnitCondition,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const TENANT_SLUG = 'demo-shop';
const ADMIN_EMAIL = 'owner@crown.demo';
const ADMIN_PASSWORD = 'WalitShop@2026';
const BCRYPT_ROUNDS = 12;

const DEFAULT_ROLES = [
  'admin',
  'manager',
  'cashier',
  'fitter',
  'inventory',
] as const;
const DEFAULT_PERMISSIONS = [
  'refund',
  'discount_override',
  'price_change',
] as const;

function ymd(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function dateOnly(d: Date) {
  return new Date(d.toISOString().slice(0, 10));
}

async function wipeTenant(tenantId: string) {
  // Child tables first (no DB-level cascades on most FKs)
  await prisma.payment.deleteMany({ where: { tenantId } });
  await prisma.unitReservation.deleteMany({ where: { tenantId } });
  await prisma.orderFee.deleteMany({ where: { tenantId } });
  await prisma.layawaySchedule.deleteMany({ where: { tenantId } });
  await prisma.invoice.deleteMany({ where: { tenantId } });
  await prisma.damageRecord.deleteMany({ where: { tenantId } });
  await prisma.cleaningJob.deleteMany({ where: { tenantId } });
  await prisma.returnEvent.deleteMany({ where: { tenantId } });
  await prisma.document.deleteMany({ where: { tenantId } });
  await prisma.notificationLog.deleteMany({ where: { tenantId } });
  await prisma.orderItem.deleteMany({ where: { tenantId } });
  await prisma.appointment.deleteMany({ where: { tenantId } });
  await prisma.rentalOrder.deleteMany({ where: { tenantId } });
  await prisma.partyMember.deleteMany({
    where: { party: { tenantId } },
  });
  await prisma.party.deleteMany({ where: { tenantId } });
  await prisma.customerMeasurement.deleteMany({ where: { tenantId } });
  await prisma.customer.deleteMany({ where: { tenantId } });
  await prisma.inventoryMovement.deleteMany({ where: { tenantId } });
  await prisma.retailSku.deleteMany({ where: { tenantId } });
  await prisma.inventoryUnit.deleteMany({ where: { tenantId } });
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
  await prisma.productStyle.deleteMany({ where: { tenantId } });
  await prisma.category.deleteMany({ where: { tenantId } });
  await prisma.supplier.deleteMany({ where: { tenantId } });
  await prisma.offlineSyncEvent.deleteMany({ where: { tenantId } });
  await prisma.apiKey.deleteMany({ where: { tenantId } });
  await prisma.webhookEndpoint.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId } } });
  await prisma.rolePermission.deleteMany({
    where: { role: { tenantId } },
  });
  await prisma.role.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.featureFlag.deleteMany({ where: { tenantId } });
  await prisma.tenantSubscription.deleteMany({ where: { tenantId } });
  await prisma.store.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

async function main() {
  const existing = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
  });
  if (existing) {
    console.log(`Removing previous "${TENANT_SLUG}" tenant…`);
    await wipeTenant(existing.id);
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);
  const now = new Date();
  const today = dateOnly(ymd(0));
  const pickup = dateOnly(ymd(0));
  const event = dateOnly(ymd(1));
  const returnDue = dateOnly(ymd(2));
  const futurePickup = dateOnly(ymd(5));
  const futureReturn = dateOnly(ymd(7));

  console.log('Seeding demo shop…');

  for (const code of DEFAULT_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      create: { code },
      update: {},
    });
  }

  const plan = await prisma.plan.upsert({
    where: { code: 'starter' },
    create: {
      code: 'starter',
      name: 'Starter',
      priceInr: 999,
      limits: { stores: 1, users: 5 },
      features: { pos: true, fittings: true },
    },
    update: {},
  });

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Crown Formal Wear',
      slug: TENANT_SLUG,
      gstin: '29AABCU9603R1ZM',
      status: 'active',
      settings: { currency: 'INR', timezone: 'Asia/Kolkata' },
    },
  });

  await prisma.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'active',
      seatsUsed: 1,
      locationsUsed: 1,
      currentPeriodEnd: ymd(365),
    },
  });

  const store = await prisma.store.create({
    data: {
      tenantId: tenant.id,
      name: 'MG Road Flagship',
      code: 'MAIN',
      address: '12 MG Road, Bengaluru, KA 560001',
      stateCode: '29',
      isActive: true,
    },
  });

  const roleRecords = [];
  for (const code of DEFAULT_ROLES) {
    roleRecords.push(
      await prisma.role.create({
        data: { tenantId: tenant.id, code },
      }),
    );
  }
  const adminRole = roleRecords.find((r) => r.code === 'admin')!;
  const managerRole = roleRecords.find((r) => r.code === 'manager')!;
  const cashierRole = roleRecords.find((r) => r.code === 'cashier')!;
  const fitterRole = roleRecords.find((r) => r.code === 'fitter')!;
  const inventoryRole = roleRecords.find((r) => r.code === 'inventory')!;
  const permissions = await prisma.permission.findMany({
    where: { code: { in: [...DEFAULT_PERMISSIONS] } },
  });
  for (const role of [adminRole, managerRole]) {
    for (const permission of permissions) {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      primaryStoreId: store.id,
      email: ADMIN_EMAIL,
      phone: '9876543210',
      passwordHash,
      fullName: 'Shop Admin',
      isActive: true,
      passwordChangedAt: now,
    },
  });

  await prisma.userRole.create({
    data: {
      userId: admin.id,
      roleId: adminRole.id,
      storeId: store.id,
    },
  });

  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      primaryStoreId: store.id,
      email: 'manager@crown.demo',
      phone: '9876543212',
      passwordHash,
      fullName: 'Floor Manager',
      isActive: true,
      passwordChangedAt: now,
    },
  });
  await prisma.userRole.create({
    data: {
      userId: manager.id,
      roleId: managerRole.id,
      storeId: store.id,
    },
  });

  const cashier = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      primaryStoreId: store.id,
      email: 'cashier@crown.demo',
      phone: '9876543211',
      passwordHash,
      fullName: 'Counter Cashier',
      isActive: true,
      passwordChangedAt: now,
    },
  });
  await prisma.userRole.create({
    data: {
      userId: cashier.id,
      roleId: cashierRole.id,
      storeId: store.id,
    },
  });

  const fitter = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      primaryStoreId: store.id,
      email: 'fitter@crown.demo',
      phone: '9876543213',
      passwordHash,
      fullName: 'Fitting Specialist',
      isActive: true,
      passwordChangedAt: now,
    },
  });
  await prisma.userRole.create({
    data: {
      userId: fitter.id,
      roleId: fitterRole.id,
      storeId: store.id,
    },
  });

  const stockUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      primaryStoreId: store.id,
      email: 'stock@crown.demo',
      phone: '9876543214',
      passwordHash,
      fullName: 'Inventory Staff',
      isActive: true,
      passwordChangedAt: now,
    },
  });
  await prisma.userRole.create({
    data: {
      userId: stockUser.id,
      roleId: inventoryRole.id,
      storeId: store.id,
    },
  });

  // ── Categories & styles ──────────────────────────────────────────────────
  const catTux = await prisma.category.create({
    data: { tenantId: tenant.id, name: 'Tuxedos' },
  });
  const catAccessories = await prisma.category.create({
    data: { tenantId: tenant.id, name: 'Accessories' },
  });

  const styleClassic = await prisma.productStyle.create({
    data: {
      tenantId: tenant.id,
      categoryId: catTux.id,
      name: 'Classic Black Tux',
      styleCode: 'TUX-BLK-01',
      color: 'Black',
      isRental: true,
      hsnSac: '9988',
      description: 'Peak lapel dinner jacket set',
    },
  });
  const styleNavy = await prisma.productStyle.create({
    data: {
      tenantId: tenant.id,
      categoryId: catTux.id,
      name: 'Navy Shawl Tux',
      styleCode: 'TUX-NVY-02',
      color: 'Navy',
      isRental: true,
      hsnSac: '9988',
    },
  });
  const styleBow = await prisma.productStyle.create({
    data: {
      tenantId: tenant.id,
      categoryId: catAccessories.id,
      name: 'Silk Bow Tie',
      styleCode: 'ACC-BOW-01',
      color: 'Black',
      isRental: false,
      hsnSac: '6215',
    },
  });

  const units = await Promise.all(
    [
      {
        barcodeSku: 'TUX-BLK-42-A',
        size: '42',
        styleId: styleClassic.id,
        rentalPrice: 3500,
        depositAmount: 5000,
      },
      {
        barcodeSku: 'TUX-BLK-42-B',
        size: '42',
        styleId: styleClassic.id,
        rentalPrice: 3500,
        depositAmount: 5000,
      },
      {
        barcodeSku: 'TUX-BLK-44-A',
        size: '44',
        styleId: styleClassic.id,
        rentalPrice: 3500,
        depositAmount: 5000,
      },
      {
        barcodeSku: 'TUX-NVY-40-A',
        size: '40',
        styleId: styleNavy.id,
        rentalPrice: 4200,
        depositAmount: 6000,
      },
      {
        barcodeSku: 'TUX-NVY-42-A',
        size: '42',
        styleId: styleNavy.id,
        rentalPrice: 4200,
        depositAmount: 6000,
      },
      {
        barcodeSku: 'TUX-NVY-44-A',
        size: '44',
        styleId: styleNavy.id,
        rentalPrice: 4200,
        depositAmount: 6000,
        status: AvailabilityStatus.CLEANING,
      },
    ].map((u) =>
      prisma.inventoryUnit.create({
        data: {
          tenantId: tenant.id,
          storeId: store.id,
          productStyleId: u.styleId,
          barcodeSku: u.barcodeSku,
          size: u.size,
          condition: UnitCondition.GOOD,
          availabilityStatus: u.status ?? AvailabilityStatus.AVAILABLE,
          ownership: Ownership.own,
          rentalPrice: u.rentalPrice,
          depositAmount: u.depositAmount,
          purchaseCost: 18000,
        },
      }),
    ),
  );

  await prisma.retailSku.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      productStyleId: styleBow.id,
      sku: 'BOWTIE-BLK-01',
      qtyOnHand: 25,
      sellPrice: 799,
    },
  });

  // ── Customers ────────────────────────────────────────────────────────────
  const groom = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      fullName: 'Arjun Sharma',
      phone: '9811111111',
      email: 'arjun@example.com',
      eventDate: event,
      notes: 'Wedding – prefer classic black',
      marketingOptIn: true,
      consentAt: now,
    },
  });
  const bestMan = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      fullName: 'Rohan Mehta',
      phone: '9822222222',
      email: 'rohan@example.com',
      eventDate: event,
    },
  });
  const walkIn = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      fullName: 'Vikram Patel',
      phone: '9833333333',
      eventDate: dateOnly(ymd(10)),
      notes: 'Walk-in inquiry',
    },
  });

  await prisma.customerMeasurement.create({
    data: {
      tenantId: tenant.id,
      customerId: groom.id,
      heightCm: 178,
      weightKg: 76,
      chest: 42,
      waist: 34,
      inseam: 32,
      sleeve: 25,
      shoeSize: '9',
      takenByUserId: admin.id,
    },
  });

  const party = await prisma.party.create({
    data: {
      tenantId: tenant.id,
      name: 'Sharma Wedding Party',
      eventDate: event,
      primaryCustomerId: groom.id,
      members: {
        create: [
          { customerId: groom.id, roleLabel: 'groom' },
          { customerId: bestMan.id, roleLabel: 'best_man' },
        ],
      },
    },
  });

  // ── Orders for Floor / Terminal testing ──────────────────────────────────
  const unitA = units[0]!;
  const unitB = units[3]!;

  // Ready for pickup today — balance still due
  const readyOrder = await prisma.rentalOrder.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      customerId: groom.id,
      partyId: party.id,
      orderNumber: 'ORD-DEMO-READY',
      status: OrderStatus.ready,
      eventDate: event,
      pickupDate: pickup,
      returnDueDate: returnDue,
      createdById: admin.id,
      subtotal: 3500,
      taxTotal: 630,
      depositTotal: 5000,
      balanceDue: 4130,
      items: {
        create: [
          {
            tenantId: tenant.id,
            itemType: OrderItemType.rental_unit,
            inventoryUnitId: unitA.id,
            wearerCustomerId: groom.id,
            size: unitA.size,
            unitPrice: 3500,
            taxAmount: 630,
          },
        ],
      },
    },
    include: { items: true },
  });

  await prisma.unitReservation.create({
    data: {
      tenantId: tenant.id,
      inventoryUnitId: unitA.id,
      orderItemId: readyOrder.items[0]!.id,
      startDate: pickup,
      endDate: returnDue,
      status: 'held',
    },
  });
  await prisma.inventoryUnit.update({
    where: { id: unitA.id },
    data: { availabilityStatus: AvailabilityStatus.RESERVED },
  });

  await prisma.payment.create({
    data: {
      tenantId: tenant.id,
      orderId: readyOrder.id,
      type: PaymentType.deposit,
      method: PaymentMethod.upi,
      amount: 5000,
      status: PaymentStatus.succeeded,
      idempotencyKey: 'seed-deposit-ready-1',
      takenById: admin.id,
      paidAt: now,
    },
  });

  // Quote — empty cart for scanning practice
  await prisma.rentalOrder.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      customerId: walkIn.id,
      orderNumber: 'ORD-DEMO-QUOTE',
      status: OrderStatus.quote,
      eventDate: dateOnly(ymd(10)),
      pickupDate: futurePickup,
      returnDueDate: futureReturn,
      createdById: admin.id,
      subtotal: 0,
      taxTotal: 0,
      depositTotal: 0,
      balanceDue: 0,
    },
  });

  // Reserved future pickup with item
  const reservedOrder = await prisma.rentalOrder.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      customerId: bestMan.id,
      partyId: party.id,
      orderNumber: 'ORD-DEMO-RSVD',
      status: OrderStatus.reserved,
      eventDate: event,
      pickupDate: futurePickup,
      returnDueDate: futureReturn,
      createdById: admin.id,
      subtotal: 4200,
      taxTotal: 756,
      depositTotal: 6000,
      balanceDue: 4956,
      items: {
        create: [
          {
            tenantId: tenant.id,
            itemType: OrderItemType.rental_unit,
            inventoryUnitId: unitB.id,
            wearerCustomerId: bestMan.id,
            size: unitB.size,
            unitPrice: 4200,
            taxAmount: 756,
          },
        ],
      },
    },
    include: { items: true },
  });

  await prisma.unitReservation.create({
    data: {
      tenantId: tenant.id,
      inventoryUnitId: unitB.id,
      orderItemId: reservedOrder.items[0]!.id,
      startDate: futurePickup,
      endDate: futureReturn,
      status: 'held',
    },
  });
  await prisma.inventoryUnit.update({
    where: { id: unitB.id },
    data: { availabilityStatus: AvailabilityStatus.RESERVED },
  });

  await prisma.payment.create({
    data: {
      tenantId: tenant.id,
      orderId: reservedOrder.id,
      type: PaymentType.deposit,
      method: PaymentMethod.cash,
      amount: 6000,
      status: PaymentStatus.succeeded,
      idempotencyKey: 'seed-deposit-rsvd-1',
      takenById: cashier.id,
      paidAt: now,
    },
  });

  // Checked out — return due today (returns desk)
  const outUnit = units[1]!;
  const outOrder = await prisma.rentalOrder.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      customerId: walkIn.id,
      orderNumber: 'ORD-DEMO-OUT',
      status: OrderStatus.checked_out,
      eventDate: dateOnly(ymd(-1)),
      pickupDate: dateOnly(ymd(-2)),
      returnDueDate: today,
      createdById: admin.id,
      subtotal: 3500,
      taxTotal: 630,
      depositTotal: 5000,
      balanceDue: 0,
      items: {
        create: [
          {
            tenantId: tenant.id,
            itemType: OrderItemType.rental_unit,
            inventoryUnitId: outUnit.id,
            size: outUnit.size,
            unitPrice: 3500,
            taxAmount: 630,
          },
        ],
      },
    },
    include: { items: true },
  });
  await prisma.unitReservation.create({
    data: {
      tenantId: tenant.id,
      inventoryUnitId: outUnit.id,
      orderItemId: outOrder.items[0]!.id,
      startDate: dateOnly(ymd(-2)),
      endDate: today,
      status: 'checked_out',
    },
  });
  await prisma.inventoryUnit.update({
    where: { id: outUnit.id },
    data: { availabilityStatus: AvailabilityStatus.CHECKED_OUT },
  });
  await prisma.payment.create({
    data: {
      tenantId: tenant.id,
      orderId: outOrder.id,
      type: PaymentType.payment,
      method: PaymentMethod.upi,
      amount: 4130,
      status: PaymentStatus.succeeded,
      idempotencyKey: 'seed-pay-out-1',
      takenById: cashier.id,
      paidAt: ymd(-2),
    },
  });

  // Fitting today
  await prisma.appointment.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      customerId: groom.id,
      orderId: readyOrder.id,
      aptType: AppointmentType.fitting,
      startsAt: new Date(
        `${today.toISOString().slice(0, 10)}T10:30:00.000+05:30`,
      ),
      status: 'scheduled',
      assignedUserId: admin.id,
      fittingNotes: 'Check jacket length and pants break',
    },
  });

  console.log('\n✅ Demo shop ready\n');
  console.log('────────────────────────────────────────');
  console.log('  LOGIN (frontend)');
  console.log(`  Tenant slug : ${TENANT_SLUG}`);
  console.log(`  Email       : ${ADMIN_EMAIL}`);
  console.log(`  Password    : ${ADMIN_PASSWORD}`);
  console.log('────────────────────────────────────────');
  console.log('  Also staff (same password):');
  console.log('    manager@crown.demo  · Floor Manager');
  console.log('    cashier@crown.demo  · Counter Cashier');
  console.log('    fitter@crown.demo   · Fitting Specialist');
  console.log('    stock@crown.demo    · Inventory Staff');
  console.log('  Customers : Arjun 9811111111, Rohan 9822222222, Vikram 9833333333');
  console.log('  Orders    : ORD-DEMO-READY (pickup today), ORD-DEMO-QUOTE (scan), ORD-DEMO-OUT (return)');
  console.log('  Barcodes  : TUX-BLK-42-A, TUX-BLK-44-A, TUX-NVY-42-A, …');
  console.log('────────────────────────────────────────\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
