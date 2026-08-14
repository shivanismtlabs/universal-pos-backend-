import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../database/database.module';

type ServiceAccountJson = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

/**
 * Firebase Cloud Messaging (FCM) push via firebase-admin.
 * No-ops when FIREBASE_SERVICE_ACCOUNT_JSON / PATH / ADC not configured.
 */
@Injectable()
export class FirebasePushService implements OnModuleInit {
  private readonly log = new Logger(FirebasePushService.name);
  private app: App | null = null;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.initFirebase();
  }

  isConfigured() {
    return this.enabled;
  }

  private loadServiceAccount(): ServiceAccountJson | null {
    const pathCfg = this.config
      .get<string>('FIREBASE_SERVICE_ACCOUNT_PATH')
      ?.trim();
    const candidates = [
      pathCfg,
      this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS')?.trim(),
      join(process.cwd(), 'firebase-adminsdk.json'),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ServiceAccountJson;
      } catch (e) {
        this.log.error(`Invalid Firebase JSON at ${p}: ${String(e)}`);
      }
    }

    const raw = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON')?.trim();
    if (raw?.startsWith('{')) {
      try {
        return JSON.parse(raw) as ServiceAccountJson;
      } catch {
        /* dotenv often truncates multiline JSON — recover from .env file */
      }
    }

    const envFile = join(process.cwd(), '.env');
    if (existsSync(envFile)) {
      try {
        const text = readFileSync(envFile, 'utf8');
        const m = text.match(
          /FIREBASE_SERVICE_ACCOUNT_JSON\s*=\s*(\{[\s\S]*?\n\})/,
        );
        if (m?.[1]) {
          return JSON.parse(m[1]) as ServiceAccountJson;
        }
      } catch (e) {
        this.log.error(
          `Could not parse FIREBASE_SERVICE_ACCOUNT_JSON from .env: ${String(e)}`,
        );
      }
    }
    return null;
  }

  private initFirebase() {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID')?.trim();
    const account = this.loadServiceAccount();

    if (!account && !projectId) {
      this.log.warn(
        'Firebase push disabled — set FIREBASE_SERVICE_ACCOUNT_PATH (JSON file) or FIREBASE_SERVICE_ACCOUNT_JSON',
      );
      return;
    }

    try {
      if (getApps().length) {
        this.app = getApps()[0]!;
        this.enabled = true;
        return;
      }

      let credential;
      if (account?.client_email && account.private_key) {
        credential = cert({
          projectId: account.project_id ?? projectId,
          clientEmail: account.client_email,
          privateKey: account.private_key.replace(/\\n/g, '\n'),
        });
      } else {
        credential = applicationDefault();
      }

      this.app = initializeApp({
        credential,
        projectId: projectId || account?.project_id || undefined,
      });
      this.enabled = true;
      this.log.log('Firebase Admin initialized for FCM push');
    } catch (e) {
      this.log.error(
        `Firebase init failed: ${e instanceof Error ? e.message : e}`,
      );
      this.enabled = false;
    }
  }

  async registerToken(opts: {
    tenantId: string;
    userId: string;
    token: string;
    platform?: string;
    userAgent?: string;
  }) {
    const token = opts.token.trim();
    if (!token) throw new Error('token required');
    return this.prisma.devicePushToken.upsert({
      where: {
        tenantId_token: { tenantId: opts.tenantId, token },
      },
      create: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        token,
        platform: opts.platform ?? 'web',
        userAgent: opts.userAgent?.slice(0, 500),
        isActive: true,
        lastSeenAt: new Date(),
      },
      update: {
        userId: opts.userId,
        platform: opts.platform ?? 'web',
        userAgent: opts.userAgent?.slice(0, 500),
        isActive: true,
        lastSeenAt: new Date(),
      },
    });
  }

  async unregisterToken(opts: {
    tenantId: string;
    userId: string;
    token: string;
  }) {
    await this.prisma.devicePushToken.updateMany({
      where: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        token: opts.token,
      },
      data: { isActive: false },
    });
    return { ok: true };
  }

  async sendToUser(opts: {
    tenantId: string;
    userId: string;
    title: string;
    body: string;
    href?: string | null;
    data?: Record<string, string>;
  }) {
    if (!this.enabled || !this.app) {
      return { sent: 0, skipped: true as const, reason: 'firebase_disabled' };
    }

    const tokens = await this.prisma.devicePushToken.findMany({
      where: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        isActive: true,
      },
      select: { id: true, token: true },
    });
    if (!tokens.length) {
      return { sent: 0, skipped: true as const, reason: 'no_tokens' };
    }

    const feOrigin =
      this.config.get<string>('PUBLIC_APP_URL')?.trim() ||
      this.config.get<string>('FRONTEND_URL')?.trim() ||
      '';
    const clickLink =
      opts.href && opts.href.startsWith('http')
        ? opts.href
        : opts.href && feOrigin
          ? `${feOrigin.replace(/\/$/, '')}${opts.href.startsWith('/') ? '' : '/'}${opts.href}`
          : undefined;

    try {
      const res = await getMessaging(this.app).sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: { title: opts.title, body: opts.body },
        data: {
          title: opts.title,
          body: opts.body,
          href: opts.href ?? '',
          ...(opts.data ?? {}),
        },
        webpush: {
          fcmOptions: clickLink ? { link: clickLink } : undefined,
          notification: {
            title: opts.title,
            body: opts.body,
            icon: '/favicon.ico',
          },
        },
      });

      const stale: string[] = [];
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error?.code ?? '';
          if (
            code.includes('registration-token-not-registered') ||
            code.includes('invalid-registration-token')
          ) {
            stale.push(tokens[i]!.token);
          }
        }
      });
      if (stale.length) {
        await this.prisma.devicePushToken.updateMany({
          where: { tenantId: opts.tenantId, token: { in: stale } },
          data: { isActive: false },
        });
      }

      return {
        sent: res.successCount,
        failed: res.failureCount,
        skipped: false as const,
      };
    } catch (e) {
      this.log.warn(
        `FCM send failed: ${e instanceof Error ? e.message : e}`,
      );
      return { sent: 0, skipped: true as const, reason: 'send_error' };
    }
  }
}
