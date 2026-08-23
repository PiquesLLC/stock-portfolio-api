import type { Response } from 'express';

/**
 * M-12 — safe error responses.
 *
 * Several controllers used the shape:
 *
 *     catch (error: any) {
 *       const status = error.status || 500;
 *       res.status(status).json({ error: error.message || 'Failed to ...' });
 *     }
 *
 * The intent is right — services deliberately throw errors carrying a numeric
 * `status` to signal a user-facing failure ("You have blocked this user"), and
 * those messages SHOULD reach the client. The bug is the fallback: an
 * *unexpected* error has no `status`, so it lands on 500 — and its `message`
 * is still echoed. A Prisma failure reaching that catch returns model, column
 * and constraint names to the caller, handing an attacker a free schema map
 * and bypassing the generic handler in app.ts.
 *
 * This helper forwards a message ONLY when the error carries an explicit 4xx
 * status, i.e. only when a service deliberately authored it for the user.
 * Everything else is logged server-side and answered generically.
 */

interface MaybeAppError {
  status?: unknown;
  message?: unknown;
}

/**
 * Returns the error's deliberate client-facing status, or null if it has none.
 * Only 4xx is treated as deliberate: a service raising a 5xx is still a server
 * fault and its text is not for the caller.
 */
function explicitClientStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const raw = (error as MaybeAppError).status;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return raw >= 400 && raw <= 499 ? raw : null;
}

/**
 * Send an error response without leaking internals.
 *
 * @param res             Express response
 * @param error           The caught value (unknown — never assume Error)
 * @param fallbackMessage Generic, user-safe text for unexpected failures
 * @param logContext      Short tag for the server-side log line
 */
export function respondWithError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
  logContext: string,
): void {
  const status = explicitClientStatus(error);

  if (status !== null) {
    const message = (error as MaybeAppError).message;
    res.status(status).json({
      error: typeof message === 'string' && message.length > 0 ? message : fallbackMessage,
    });
    return;
  }

  // Unexpected: keep the detail on the server only.
  console.error(`[${logContext}]`, error instanceof Error ? (error.stack ?? error.message) : String(error));
  res.status(500).json({ error: fallbackMessage });
}
