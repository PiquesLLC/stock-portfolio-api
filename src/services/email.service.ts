import { Resend } from 'resend';
import { config } from '../config';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let resend: Resend | null = null;
const capturedEmailVerificationCodes = new Map<string, { code: string; expiresAt: number }>();

function getResend(): Resend | null {
  // Hard guard: never send real emails from tests, even if RESEND_API_KEY is
  // set in the developer's .env. Vitest sets VITEST=true automatically; we
  // also check NODE_ENV='test' for any other test runner.
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return null;
  }
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
    subject: 'Your Nala verification code',
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

export async function sendUsernameReminderEmail(to: string, username: string): Promise<void> {
  const safeUsername = escapeHtml(username);
  const r = getResend();
  if (!r) {
    console.log(`[Email] Dev mode — username reminder for ${to}: ${username}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: 'Your Nala username',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">The username associated with this email is:</p>
        <p style="font-size: 28px; font-weight: bold; color: #111; margin: 16px 0; font-family: monospace;">${safeUsername}</p>
        <p style="color: #666; font-size: 14px; margin: 16px 0 0;">If you didn't request this, you can safely ignore this email.</p>
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
  const signupUrl = 'https://nalaai.com/invite';
  const result = await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: "You're in! Your Nala account is ready",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 0; background: #050505; border-radius: 12px; overflow: hidden;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #050505 0%, #0a1a0a 100%); padding: 40px 32px 24px; text-align: center;">
          <h1 style="color: #00c805; margin: 0 0 8px; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Nala</h1>
          <p style="color: rgba(255,255,255,0.4); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 0;">Portfolio Intelligence Platform</p>
        </div>

        <!-- Body -->
        <div style="padding: 32px;">
          <h2 style="color: #fff; font-size: 22px; margin: 0 0 16px; font-weight: 600;">Congratulations — You've Been Approved!</h2>
          <p style="color: rgba(255,255,255,0.7); font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
            Your waitlist application has been approved and your account is ready to be created on Nala.
          </p>

          <!-- CTA Button -->
          <div style="text-align: center; margin: 28px 0;">
            <a href="${signupUrl}" style="display: inline-block; background: #00c805; color: #fff; text-decoration: none; padding: 14px 36px; border-radius: 28px; font-size: 15px; font-weight: 600; letter-spacing: 0.3px;">Get Started at NalaAI.com</a>
          </div>

          <!-- Web browser notice -->
          <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin: 24px 0;">
            <p style="color: rgba(255,255,255,0.5); font-size: 13px; line-height: 1.6; margin: 0;">
              <strong style="color: rgba(255,255,255,0.7);">Important — How to access Nala:</strong><br/><br/>
              Nala is currently under review on the iOS App Store. In the meantime, the full platform is available on desktop and mobile browsers at <a href="${signupUrl}" style="color: #00c805; text-decoration: none; font-weight: 600;">nalaai.com</a>. We recommend Chrome, Safari, or Edge for the best experience. We'll notify you as soon as the iOS app is live.
            </p>
          </div>

          <!-- Support -->
          <div style="background: rgba(255,255,255,0.02); border-radius: 8px; padding: 14px 16px; margin: 0 0 8px;">
            <p style="color: rgba(255,255,255,0.5); font-size: 13px; line-height: 1.5; margin: 0;">
              <strong style="color: rgba(255,255,255,0.7);">Need help?</strong> Contact us anytime at <a href="mailto:support@nalaai.com" style="color: #00c805; text-decoration: none; font-weight: 600;">support@nalaai.com</a> — we're here to help with any questions or issues.
            </p>
          </div>

          <!-- What you get -->
          <p style="color: rgba(255,255,255,0.5); font-size: 13px; margin: 24px 0 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">What's waiting for you</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">AI Portfolio Analysis + Daily Briefings</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">Live</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">Social Feed + Creator Subscriptions</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">Live</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">Sector Heatmaps + Market Rotation</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">Live</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">Candlestick Charts + Technical Indicators</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">New</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">AI Divergence Detection</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">New</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.06);">Nala Score + Value Radar</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06);">Live</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: rgba(255,255,255,0.7); font-size: 14px;">Public Leaderboard + Portfolio Sharing</td>
              <td style="padding: 8px 0; color: #00c805; font-size: 14px; text-align: right;">Live</td>
            </tr>
          </table>
        </div>

        <!-- Footer -->
        <div style="padding: 20px 32px; border-top: 1px solid rgba(255,255,255,0.06);">
          <p style="color: rgba(255,255,255,0.25); font-size: 11px; margin: 0; text-align: center;">
            Nala &middot; <a href="https://nalaai.com" style="color: rgba(255,255,255,0.3); text-decoration: none;">NalaAI.com</a>
          </p>
        </div>
      </div>
    `,
  });
  if (result.error) {
    console.error(`[Email] Waitlist approval to ${to} FAILED:`, result.error);
    throw new Error(`Email send failed: ${result.error.message}`);
  }
  console.log(`[Email] Waitlist approval sent to ${to}, id: ${result.data?.id}`);
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
    subject: `New Waitlist Signup: ${escapeHtml(waitlistEmail)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #00c805; margin: 0 0 24px;">Nala — Waitlist</h2>
        <p style="color: #333; font-size: 16px; margin: 0 0 8px;">New signup on the waitlist:</p>
        <p style="font-size: 18px; font-weight: bold; color: #111; margin: 16px 0; font-family: monospace;">${escapeHtml(waitlistEmail)}</p>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">Joined at ${now} ET</p>
        <a href="${reviewUrl}" style="display: inline-block; background: #00c805; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 24px; font-size: 14px; font-weight: 600;">Review in App</a>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="color: #999; font-size: 12px; margin: 0;">Piques LLC</p>
      </div>
    `,
  });
}

const PERIOD_LABELS: Record<string, string> = {
  '1D': '1 Day', '1W': '1 Week', '1M': '1 Month', '3M': '3 Months', '6M': '6 Months',
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

export async function sendWelcomeEmail(to: string, displayName: string): Promise<void> {
  const r = getResend();
  const firstName = displayName.split(/\s+/)[0] || displayName;
  if (!r) {
    console.log(`[Email] Dev mode — welcome email for ${to} (${firstName})`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to,
    subject: `Welcome to Nala, ${firstName}!`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 32px; background: #050505; border-radius: 16px;">
        <div style="text-align: center; margin-bottom: 28px;">
          <img src="https://nalaai.com/north-signal-logo.png" alt="Nala" width="48" height="48" style="display: inline-block;" />
        </div>
        <h1 style="color: #00c805; margin: 0 0 8px; font-size: 24px; font-weight: 700; text-align: center;">Welcome to Nala</h1>
        <p style="color: rgba(255,255,255,0.6); font-size: 15px; line-height: 1.6; text-align: center; margin: 0 0 28px;">
          Hey ${escapeHtml(firstName)}, your account is ready. Here's what you can do:
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
              <span style="color: #00c805; font-size: 15px; margin-right: 8px;">1.</span>
              <span style="color: #fff; font-size: 14px;">Add your holdings to track your portfolio</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
              <span style="color: #00c805; font-size: 15px; margin-right: 8px;">2.</span>
              <span style="color: #fff; font-size: 14px;">Get your daily AI briefing on what moved</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
              <span style="color: #00c805; font-size: 15px; margin-right: 8px;">3.</span>
              <span style="color: #fff; font-size: 14px;">Explore Discover for market insights</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px;">
              <span style="color: #00c805; font-size: 15px; margin-right: 8px;">4.</span>
              <span style="color: #fff; font-size: 14px;">Ask Nala anything about your investments</span>
            </td>
          </tr>
        </table>
        <div style="text-align: center; margin-bottom: 28px;">
          <a href="https://nalaai.com" style="display: inline-block; background: #00c805; color: #000; font-size: 14px; font-weight: 700; padding: 12px 32px; border-radius: 8px; text-decoration: none;">Open Nala</a>
        </div>
        <p style="color: rgba(255,255,255,0.3); font-size: 12px; text-align: center; margin: 0;">
          Questions? Reach us at <a href="mailto:support@nalaai.com" style="color: rgba(255,255,255,0.4);">support@nalaai.com</a>
        </p>
        <p style="color: rgba(255,255,255,0.15); font-size: 11px; text-align: center; margin: 16px 0 0;">Piques LLC</p>
      </div>
    `,
  });
}

export async function sendNewSignupNotification(adminEmail: string, username: string, email: string, displayName: string): Promise<void> {
  const r = getResend();
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  if (!r) {
    console.log(`[Email] Dev mode — new signup: ${username} (${email}) at ${now}`);
    return;
  }
  await r.emails.send({
    from: `Nala <${config.resendFromEmail}>`,
    to: adminEmail,
    subject: `New Account Created: ${escapeHtml(username)}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px; background: #050505; border-radius: 12px;">
        <h2 style="color: #00c805; margin: 0 0 20px; font-size: 18px;">New Account Created</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="color: rgba(255,255,255,0.4); font-size: 13px; padding: 6px 0;">Username</td><td style="color: #fff; font-size: 13px; font-weight: 600; padding: 6px 0;">${escapeHtml(username)}</td></tr>
          <tr><td style="color: rgba(255,255,255,0.4); font-size: 13px; padding: 6px 0;">Display Name</td><td style="color: #fff; font-size: 13px; padding: 6px 0;">${escapeHtml(displayName)}</td></tr>
          <tr><td style="color: rgba(255,255,255,0.4); font-size: 13px; padding: 6px 0;">Email</td><td style="color: #fff; font-size: 13px; padding: 6px 0;">${escapeHtml(email)}</td></tr>
          <tr><td style="color: rgba(255,255,255,0.4); font-size: 13px; padding: 6px 0;">Time</td><td style="color: #fff; font-size: 13px; padding: 6px 0;">${now} ET</td></tr>
        </table>
      </div>
    `,
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
