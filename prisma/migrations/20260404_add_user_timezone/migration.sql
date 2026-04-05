-- Add IANA timezone to User for per-user local-time scheduling (weekly/monthly briefs).
-- NULL means "use default" (America/New_York) so existing users keep current behavior.
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;
