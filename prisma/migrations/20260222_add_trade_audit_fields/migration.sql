-- Add audit fields to PortfolioTrade for broker tracking and raw action preservation
ALTER TABLE "PortfolioTrade" ADD COLUMN "sourceBroker" TEXT;
ALTER TABLE "PortfolioTrade" ADD COLUMN "rawAction" TEXT;
