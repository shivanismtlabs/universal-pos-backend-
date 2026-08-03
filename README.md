# Walit POS API

NestJS + **Fastify** + **Prisma** + **PostgreSQL 16** + **Redis/BullMQ**.

Schema source of truth: [`../docs/erd/walit-pos-erd.mmd`](../docs/erd/walit-pos-erd.mmd) → [`prisma/schema.prisma`](./prisma/schema.prisma)

## Stack

| Layer | Choice |
|--------|--------|
| API | NestJS + Fastify (`/v1`) |
| ORM | **Prisma** |
| DB | PostgreSQL 16 |
| Jobs | Redis + BullMQ |
| Files | S3 / R2 |
| Payments | Razorpay / Cashfree (env) |
| WhatsApp | BSP via NotifyModule + queue |

## Quick start

```bash
npm run docker:up
cp .env.example .env
npm run prisma:generate
npm run prisma:push
# then run prisma/sql/001_reservation_exclusion.sql (FR-INV-05)
npm run start:dev
```

Health: `GET http://localhost:3001/v1/health`

## Scripts

- `npm run prisma:generate` — client
- `npm run prisma:push` — sync schema (dev)
- `npm run prisma:migrate` — migrations
- `npm run prisma:studio` — GUI
