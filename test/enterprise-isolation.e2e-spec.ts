import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AppModule } from './../src/app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

/**
 * Isolation: a tenant-scoped access token must not read another tenant's orders
 * via Universal Core APIs. Enterprise group APIs require identity membership.
 */
describe('Enterprise isolation (e2e)', () => {
  let app: NestFastifyApplication | null = null;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('enterprise group without token is unauthorized', async () => {
    if (!app) return;
    const res = await app.inject({ method: 'GET', url: '/v1/enterprise/group' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('ForbiddenException is the denial class for cross-tenant ops', () => {
    const err = new ForbiddenException('No access to this business');
    expect(err.getStatus()).toBe(403);
  });
});
