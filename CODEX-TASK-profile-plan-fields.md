# Codex Task: Expose plan + planStartedAt on Profile API

## Why
The UI now displays premium tenure badges on public profiles (Twitch-style: Supporter, Patron, Champion, Veteran, Legend). The badge computation needs `plan` and `planStartedAt` from the profile API response, but the endpoint currently doesn't return these fields.

## What to Change

### File: `src/controllers/social.controller.ts` — `getProfileHandler` (~line 110)

Add `plan` and `planStartedAt` to the Prisma `select` query:

```typescript
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true,
    username: true,
    displayName: true,
    createdAt: true,
    profilePublic: true,
    trackingActive: true,
    leaderboardEligible: true,
    region: true,
    showRegion: true,
    holdingsVisibility: true,
    bio: true,
    plan: true,           // ADD THIS
    planStartedAt: true,   // ADD THIS
  },
});
```

That's it. Both fields already exist on the User model in the Prisma schema (lines 61, 65). No migration needed.

## Testing
- `GET /users/:userId/profile` should now include `plan` (string) and `planStartedAt` (ISO date or null) in the response
- Verify with: `curl http://localhost:3001/users/237198da-612e-411c-9ef8-f267c887a9f1/profile`

## Notes
- These are non-sensitive fields — safe to expose on public profiles
- The UI type (`UserProfile` in `src/types.ts`) has already been updated with optional `plan?: string` and `planStartedAt?: string`
