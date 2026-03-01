import { Resend } from 'resend';
import { config } from '../config';

let resend: Resend | null = null;
const capturedEmailVerificationCodes = new Map<string, { code: string; expiresAt: number }>();

function getResend(): Resend | null {
  if (!resend) {
    if (!config.resendApiKey || config.resendApiKey === 'PASTE_YOUR_RESEND_API_KEY_HERE') {
      if (process.env.NODE_ENV !== 'production') {
        return null;
      }
      throw new Error('RESEND_API_KEY is not configured');
    }
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  // Capture for local dev
  if (process.env.NODE_ENV !== 'production') {
    capturedEmailVerificationCodes.set(to.trim().toLowerCase(), {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — OTP code for ${to}: ${code}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
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
  // Non-production capture for CI/local smoke tests.
  if (process.env.NODE_ENV !== 'production') {
    capturedEmailVerificationCodes.set(to.trim().toLowerCase(), {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — verification code for ${to}: ${code}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
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

export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  // Non-production capture for CI/local smoke tests.
  if (process.env.NODE_ENV !== 'production') {
    capturedEmailVerificationCodes.set(to.trim().toLowerCase(), {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — password reset code for ${to}: ${code}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: 'Reset your Nala password',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">Use this code to reset your password:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #111; margin: 16px 0; font-family: monospace;">${code}</p>
        <p style="color: #666; font-size: 14px; margin: 16px 0 0;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}

export async function sendWaitlistApprovalEmail(to: string): Promise<void> {
  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — waitlist approval for ${to}`);
    return;
  }
  const signupUrl = config.stripeReturnUrl || 'https://nalaai.com';
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: "You're in! Create your Nala account",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 16px;">Great news — your spot is ready.</p>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">You've been approved to join Nala. Click below to create your account and start tracking your portfolio.</p>
        <a href="${signupUrl}" style="display: inline-block; background: #00c805; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 24px; font-size: 14px; font-weight: 600;">Create Your Account</a>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}

export async function sendWaitlistJoinNotificationEmail(adminEmail: string, waitlistEmail: string): Promise<void> {
  const r = getResend();
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const frontendUrl = config.appFrontendUrl;
  const reviewUrl = `${frontendUrl}#tab=admin-waitlist`;
  if (!r) {
    console.log(`[Email] Dev mode — waitlist join notification: ${waitlistEmail} joined at ${now}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to: adminEmail,
    subject: `New Waitlist Signup: ${waitlistEmail}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala — Waitlist</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">New signup on the waitlist:</p>
        <p style="font-size: 18px; font-weight: bold; color: #111; margin: 16px 0; font-family: monospace;">${waitlistEmail}</p>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">Joined at ${now} ET</p>
        <a href="${reviewUrl}" style="display: inline-block; background: #00c805; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 24px; font-size: 14px; font-weight: 600;">Review in App</a>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}

const PERIOD_LABELS: Record<string, string> = {
  '1D': '1 Day', '1W': '1 Week', '1M': '1 Month', '3M': '3 Months',
  'YTD': 'Year to Date', '1Y': '1 Year', 'ALL': 'All Time',
};

export async function sendPerformanceReport(to: string, html: string, period: string): Promise<void> {
  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const periodLabel = PERIOD_LABELS[period] || period;

  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — would send performance report to ${to} (period: ${period})`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: `Your Nala Portfolio Report - ${monthYear} (${periodLabel})`,
    html,
  });
}

export function getCapturedEmailVerificationCode(email: string): string | null {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }
  const key = email.trim().toLowerCase();
  const captured = capturedEmailVerificationCodes.get(key);
  if (!captured) {
    return null;
  }
  if (captured.expiresAt < Date.now()) {
    capturedEmailVerificationCodes.delete(key);
    return null;
  }
  return captured.code;
}
