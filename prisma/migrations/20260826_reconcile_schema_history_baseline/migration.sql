-- CATEGORY B — history gap. Production ALREADY has every object below.
--
-- Multi-portfolio shipped these columns and indexes to production without a
-- migration to describe them, so replaying the migration history produced a
-- schema that did not match production or schema.prisma. This migration teaches
-- a fresh replay how to arrive where production already is.
--
-- PRODUCTION NEVER EXECUTES THIS FILE. It is recorded with
--   prisma migrate resolve --applied 20260826_reconcile_schema_history_baseline
-- only after a preflight has PROVEN each object is genuinely present. That
-- preflight is not a formality: the drift being repaired here was itself caused
-- by marking migrations applied without confirming they had run.
--
-- Statements below are the verbatim output of
--   prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma
-- and are deliberately not hand-edited.

-- AlterTable
ALTER TABLE "DividendCredit" ADD COLUMN "portfolioId" TEXT;

-- AlterTable
ALTER TABLE "DividendReinvestment" ADD COLUMN "portfolioId" TEXT;

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN "portfolioId" TEXT;

-- AlterTable
ALTER TABLE "PortfolioTrade" ADD COLUMN "portfolioId" TEXT;

-- CreateIndex
CREATE INDEX "DividendCredit_portfolioId_ticker_idx" ON "DividendCredit"("portfolioId", "ticker");

-- CreateIndex
CREATE INDEX "DividendReinvestment_portfolioId_ticker_idx" ON "DividendReinvestment"("portfolioId", "ticker");

-- CreateIndex
CREATE INDEX "Lot_portfolioId_ticker_idx" ON "Lot"("portfolioId", "ticker");

-- CreateIndex
CREATE INDEX "PortfolioTrade_portfolioId_ticker_idx" ON "PortfolioTrade"("portfolioId", "ticker");
