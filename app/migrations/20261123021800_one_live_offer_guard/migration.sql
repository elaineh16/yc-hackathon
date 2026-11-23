-- Database-level guards behind the case engine's row locks (Prisma cannot express partial indexes).
-- At most one live offer per case: an assignment that is OFFERED or ACCEPTED.
CREATE UNIQUE INDEX "VendorAssignment_one_live_per_case" ON "VendorAssignment" ("caseId") WHERE "status" IN ('OFFERED', 'ACCEPTED');
-- At most one confirmed visit per assignment.
CREATE UNIQUE INDEX "AppointmentSlot_one_confirmed_per_assignment" ON "AppointmentSlot" ("assignmentId") WHERE "status" = 'CONFIRMED';
