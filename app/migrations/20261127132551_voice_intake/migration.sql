-- Voice calls get the intake safety net: their transcript is kept as an IntakeConversation (channel VOICE),
-- keyed by the browser's id for the call attempt, which is also the request id of the call's report.

-- AlterTable
ALTER TABLE "IntakeConversation" ADD COLUMN     "channel" "IntakeChannel" NOT NULL DEFAULT 'CHAT',
ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IntakeConversation_residentId_clientRequestId_key" ON "IntakeConversation"("residentId", "clientRequestId");
