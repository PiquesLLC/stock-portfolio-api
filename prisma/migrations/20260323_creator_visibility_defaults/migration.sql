-- Fix creator visibility defaults: holdings and sectors should NOT be paywalled by default.
-- Creators must explicitly opt-in to paywalling content.

-- Update existing creators: un-paywall holdings and sectors for everyone.
-- Creators who want to paywall can re-enable in their settings.
UPDATE "CreatorVisibility" SET "showHoldings" = 0 WHERE "showHoldings" = 1;
UPDATE "CreatorVisibility" SET "showSectors" = 0 WHERE "showSectors" = 1;
