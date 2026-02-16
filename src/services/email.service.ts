import { Resend } from 'resend';
import { config } from '../config';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const r = getResend();
  await r.emails.send({
    from: 'Nala <noreply@piques.io>',
    to,
    subject: `${code} is your Nala verification code`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">Your verification code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #111; margin: 16px 0; font-family: monospace;">${code}</p>
        <p style="color: #666; font-size: 14px; margin: 16px 0 0;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}

export async function sendEmailVerification(to: string, code: string): Promise<void> {
  const r = getResend();
  await r.emails.send({
    from: 'Nala <noreply@piques.io>',
    to,
    subject: 'Verify your email for Nala',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">Verify your email address with this code:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #111; margin: 16px 0; font-family: monospace;">${code}</p>
        <p style="color: #666; font-size: 14px; margin: 16px 0 0;">This code expires in 10 minutes.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}
