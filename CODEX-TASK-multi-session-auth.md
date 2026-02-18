# Codex Task: Support Multiple Concurrent Sessions

## Problem
Logging in on mobile signs the user out on desktop. Users need to use both devices simultaneously — this is a consumer app, not a bank. Killing the other session is a bad UX.

## Root Cause
`rotateRefreshToken()` in `src/services/auth.service.ts` uses **strict refresh token rotation with family revocation**. When a user logs in on Device B, Device A's next token refresh finds its old refresh token revoked, and after the 30-second grace window, the system treats it as a **reuse attack** and revokes ALL tokens for that user (line 82), logging out Device A.

## What to Change

### File: `src/services/auth.service.ts`

#### 1. Add a `family` field to refresh tokens
Each login creates an independent token "family" (a random ID). Token rotation only tracks reuse within the same family.

```
generateRefreshToken(userId, family?) → if no family, create a new one (crypto.randomUUID())
```

#### 2. Update `rotateRefreshToken()`
When detecting reuse (a revoked token is presented after the 30s grace window):
- **Current behavior**: Revoke ALL tokens for the user (nuclear option)
- **New behavior**: Only revoke tokens in the SAME family (`where: { userId, family, revokedAt: null }`)

This way Device A and Device B each have their own token family and don't interfere with each other.

#### 3. Update `revokeAllRefreshTokens()`
Keep this as-is — it's used for logout and password change, where revoking everything is correct.

### Database: Add `family` column to `RefreshToken`
```prisma
model RefreshToken {
  id        String   @id @default(uuid())
  token     String   @unique
  userId    String
  family    String   // NEW — groups tokens from the same login session
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id])

  @@index([family])
  @@index([userId])
}
```

Run `npx prisma migrate dev --name add-refresh-token-family` after updating the schema.

### Flow After Fix
1. User logs in on Desktop → creates family "abc", gets refresh token R1
2. User logs in on Mobile → creates family "xyz", gets refresh token R2
3. Desktop refreshes with R1 → rotates within family "abc" → gets R3. Mobile unaffected.
4. Mobile refreshes with R2 → rotates within family "xyz" → gets R4. Desktop unaffected.
5. If R1 is replayed (reuse attack) → revoke only family "abc", not "xyz"

## Testing
- Log in on two different browsers/incognito windows
- Verify both sessions stay active after token refresh cycles (wait 15+ minutes or temporarily shorten access token expiry)
- Verify logout on one device doesn't kill the other
- Verify password change still revokes ALL sessions (existing `revokeAllRefreshTokens` behavior)

## Important Notes
- Access tokens (15min JWT) are stateless and don't need changes
- The 30-second grace window for concurrent requests within the same session should stay
- Don't forget to pass the `family` through when creating the rotated token in `rotateRefreshToken()`
- Railway has its own database — after merging, deploy and run migrations there too
