-- AlterTable: Add deterministic ordering fields to PortfolioTrade
ALTER TABLE "PortfolioTrade" ADD COLUMN "rowIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PortfolioTrade" ADD COLUMN "sourceFileId" TEXT;
