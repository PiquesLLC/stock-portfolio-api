-- Add indexes for Stripe webhook lookup performance
CREATE INDEX IF NOT EXISTS "CreatorSubscription_stripeSubscriptionId_idx" ON "CreatorSubscription"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "CreatorPayout_stripeTransferId_idx" ON "CreatorPayout"("stripeTransferId");
CREATE INDEX IF NOT EXISTS "CreatorPayout_stripePayoutId_idx" ON "CreatorPayout"("stripePayoutId");
