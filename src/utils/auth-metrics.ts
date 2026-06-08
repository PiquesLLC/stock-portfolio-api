// Lightweight in-memory auth metrics for on-call dashboard.
// Resets on deploy. For persistent metrics, wire into your observability stack.

interface AuthMetrics {
  oauth: {
    google: { success: number; fail: number; mfaChallenged: number };
    apple: { success: number; fail: number; mfaChallenged: number };
  };
  login: { success: number; fail: number; mfaChallenged: number };
  signup: { success: number; fail: number };
  rateLimited: { oauth: number; login: number };
  p2002Recovery: { byProvider: number; byEmail: number; failed: number; adoptedUnverified: number };
  startedAt: string;
}

const metrics: AuthMetrics = {
  oauth: {
    google: { success: 0, fail: 0, mfaChallenged: 0 },
    apple: { success: 0, fail: 0, mfaChallenged: 0 },
  },
  login: { success: 0, fail: 0, mfaChallenged: 0 },
  signup: { success: 0, fail: 0 },
  rateLimited: { oauth: 0, login: 0 },
  p2002Recovery: { byProvider: 0, byEmail: 0, failed: 0, adoptedUnverified: 0 },
  startedAt: new Date().toISOString(),
};

export function trackOAuthSuccess(provider: 'google' | 'apple'): void {
  metrics.oauth[provider].success++;
}

export function trackOAuthFail(provider: 'google' | 'apple'): void {
  metrics.oauth[provider].fail++;
}

export function trackOAuthMfa(provider: 'google' | 'apple'): void {
  metrics.oauth[provider].mfaChallenged++;
}

export function trackLoginSuccess(): void { metrics.login.success++; }
export function trackLoginFail(): void { metrics.login.fail++; }
export function trackLoginMfa(): void { metrics.login.mfaChallenged++; }
export function trackSignupSuccess(): void { metrics.signup.success++; }
export function trackSignupFail(): void { metrics.signup.fail++; }
export function trackRateLimited(type: 'oauth' | 'login'): void { metrics.rateLimited[type]++; }
export function trackP2002(outcome: 'byProvider' | 'byEmail' | 'failed' | 'adoptedUnverified'): void { metrics.p2002Recovery[outcome]++; }

export function getAuthMetrics(): AuthMetrics {
  return { ...metrics };
}
