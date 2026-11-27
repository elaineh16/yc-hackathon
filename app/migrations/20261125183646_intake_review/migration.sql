-- AlterTable
ALTER TABLE "IntakeConversation" ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewOutcome" TEXT,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewSince" TIMESTAMP(3),
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" INTEGER;

-- CreateIndex
CREATE INDEX "IntakeConversation_reviewSince_reviewOutcome_idx" ON "IntakeConversation"("reviewSince", "reviewOutcome");
