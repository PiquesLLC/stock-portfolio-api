-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "family" TEXT;

-- CreateIndex
CREATE INDEX "RefreshToken_family_idx" ON "RefreshToken"("family");
