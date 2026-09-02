import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

@Injectable()
export class MailService implements OnModuleInit {
  private readonly log = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private host = '';

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const user = this.config.get<string>('SMTP_USER')?.trim();
    // Gmail app passwords are often stored with spaces; nodemailer accepts either form.
    const pass = this.config.get<string>('SMTP_PASS')?.trim();
    if (!host || !user || !pass) return;

    this.host = host;
    const port = Number(this.config.get<string>('SMTP_PORT') || 587);
    const secure =
      this.config.get<string>('SMTP_SECURE') === 'true' || port === 465;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }

  async onModuleInit() {
    if (!this.transporter) {
      this.log.warn(
        'SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS). Forgot-password OTP emails will not be delivered.',
      );
      return;
    }
    try {
      await this.transporter.verify();
      this.log.log(`SMTP ready (${this.host})`);
    } catch (e) {
      this.log.error(`SMTP verify failed: ${String(e)}`);
    }
  }

  isConfigured() {
    return Boolean(this.transporter);
  }

  fromAddress() {
    return (
      this.config.get<string>('EMAIL_FROM')?.trim() ||
      this.config.get<string>('SMTP_USER')?.trim() ||
      'Universal POS <noreply@universal-pos.local>'
    );
  }

  async send(msg: OutboundEmail): Promise<boolean> {
    if (!this.transporter) return false;
    const info = await this.transporter.sendMail({
      from: this.fromAddress(),
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    const rejected = info.rejected ?? [];
    if (rejected.length > 0) {
      this.log.error(
        `SMTP rejected recipient(s): ${rejected.join(', ')} (response=${info.response ?? 'n/a'})`,
      );
      return false;
    }
    this.log.debug(
      `SMTP accepted ${msg.to} messageId=${info.messageId ?? 'n/a'}`,
    );
    return true;
  }

  async sendOtp(params: {
    to: string;
    purpose: 'password_reset' | 'pin_reset';
    code: string;
    expiresMinutes: number;
  }): Promise<boolean> {
    const isPin = params.purpose === 'pin_reset';
    const subject = isPin
      ? 'Your Universal POS PIN reset code'
      : 'Your Universal POS password reset code';
    const what = isPin ? 'counter PIN' : 'password';
    const text = [
      `Your Universal POS ${what} reset code is ${params.code}.`,
      `It expires in ${params.expiresMinutes} minutes.`,
      'If you did not request this, you can ignore this email.',
    ].join('\n');
    const html = this.otpHtml({
      code: params.code,
      what,
      expiresMinutes: params.expiresMinutes,
    });
    return this.send({ to: params.to, subject, text, html });
  }

  private otpHtml(args: {
    code: string;
    what: string;
    expiresMinutes: number;
  }) {
    const code = args.code.replace(/\D/g, '').slice(0, 6);
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#0b1f33;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fa;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e9f0;border-radius:8px;">
          <tr>
            <td style="padding:24px 28px 8px;font-size:13px;letter-spacing:.04em;color:#1a56db;font-weight:600;">UNIVERSAL POS</td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;font-size:20px;font-weight:650;">Reset your ${args.what}</td>
          </tr>
          <tr>
            <td style="padding:0 28px 20px;font-size:14px;line-height:1.5;color:#5a6b7d;">
              Use this 6-digit code. It expires in ${args.expiresMinutes} minutes.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 28px 24px;">
              <div style="display:inline-block;letter-spacing:.28em;font-size:28px;font-weight:700;color:#0b1f33;background:#f4f6fa;border:1px solid #e4e9f0;border-radius:6px;padding:12px 20px 12px 28px;">${code}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 24px;font-size:12px;color:#8a9bb0;">
              If you did not request this, ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
