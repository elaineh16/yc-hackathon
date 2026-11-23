-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AppointmentSlot_assignmentId_status_idx" ON "AppointmentSlot"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "Case_status_statusChangedAt_idx" ON "Case"("status", "statusChangedAt");

-- CreateIndex
CREATE INDEX "VendorAssignment_caseId_status_idx" ON "VendorAssignment"("caseId", "status");


-- Emergencies the previous sweep already re-alerted (its key named the original notification) are marked, so the
-- new once-per-emergency re-alert does not send them a second time.
UPDATE "Notification" n SET "escalatedAt" = CURRENT_TIMESTAMP
WHERE n."channel" = 'IN_APP' AND n."kind" = 'EMERGENCY'
  AND EXISTS (SELECT 1 FROM "Notification" r WHERE r."dedupeKey" LIKE '%:ack-overdue:' || n."id" || ':%');
