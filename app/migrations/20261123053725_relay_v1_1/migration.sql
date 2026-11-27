-- CreateEnum
CREATE TYPE "DiscoveryStatus" AS ENUM ('AWAITING_MANAGER', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('NEW', 'SHORTLISTED', 'VERIFIED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'ACCEPTED', 'CAPTURED', 'FAILED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Category" ADD VALUE 'ELECTRICAL';
ALTER TYPE "Category" ADD VALUE 'ACCESS';
ALTER TYPE "Category" ADD VALUE 'ELEVATOR';
ALTER TYPE "Category" ADD VALUE 'NOISE';

-- DropIndex
DROP INDEX "Notification_userId_readAt_idx";

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "assumptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "intakeGroup" TEXT,
ADD COLUMN     "observations" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "openQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "IntakeConversation" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "pendingAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pendingSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "ackDueAt" TIMESTAMP(3),
ADD COLUMN     "ackRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "actionUrl" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN     "eventType" TEXT NOT NULL DEFAULT 'case.update',
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "status" "DeliveryStatus" NOT NULL DEFAULT 'DELIVERED',
ADD COLUMN     "statusNote" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "appointmentReminderMinutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "autoDiscovery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "city" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "maxReminders" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "region" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "residentResponseMinutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "serviceRadiusKm" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT,
ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable (the old global "approved" flag is dropped at the end, after its data is carried over)
ALTER TABLE "Vendor" ADD COLUMN     "address" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "VendorAssignment" ADD COLUMN     "changeDecidedAt" TIMESTAMP(3),
ADD COLUMN     "changeDecidedById" INTEGER,
ADD COLUMN     "changeRequestCents" INTEGER,
ADD COLUMN     "changeRequestReason" TEXT,
ADD COLUMN     "changeRequestStatus" TEXT,
ADD COLUMN     "changeRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PropertyVendor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "propertyId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMP(3),
    "approvedById" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,

    CONSTRAINT "PropertyVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDiscovery" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "propertyId" TEXT NOT NULL,
    "caseId" TEXT,
    "trade" "Category" NOT NULL,
    "query" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "status" "DiscoveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedById" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "chargeInfo" JSONB,
    "warnings" JSONB,
    "advice" JSONB,
    "creditsCharged" DOUBLE PRECISION,
    "creditsBefore" DOUBLE PRECISION,
    "placesReturned" INTEGER,
    "candidatesKept" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "reusedFromId" TEXT,

    CONSTRAINT "VendorDiscovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCandidate" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "propertyId" TEXT NOT NULL,
    "discoveryId" TEXT NOT NULL,
    "lastDiscoveryId" TEXT,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "trade" "Category" NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "categories" TEXT[],
    "rating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION,
    "openingHours" JSONB,
    "checks" JSONB NOT NULL,
    "missing" TEXT[],
    "duplicateOfVendorId" TEXT,
    "recommendation" TEXT NOT NULL,
    "reasons" TEXT[],
    "concerns" TEXT[],
    "assessedBy" TEXT NOT NULL,
    "aiNote" TEXT,
    "status" "CandidateStatus" NOT NULL DEFAULT 'NEW',
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "verifiedById" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "verificationNote" TEXT,
    "vendorId" TEXT,

    CONSTRAINT "VendorCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyVendor_vendorId_idx" ON "PropertyVendor"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyVendor_propertyId_vendorId_key" ON "PropertyVendor"("propertyId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorDiscovery_propertyId_trade_createdAt_idx" ON "VendorDiscovery"("propertyId", "trade", "createdAt");

-- CreateIndex
CREATE INDEX "VendorDiscovery_status_updatedAt_idx" ON "VendorDiscovery"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "VendorDiscovery_cacheKey_status_idx" ON "VendorDiscovery"("cacheKey", "status");

-- CreateIndex
CREATE INDEX "VendorDiscovery_caseId_idx" ON "VendorDiscovery"("caseId");

-- CreateIndex
CREATE INDEX "VendorCandidate_discoveryId_idx" ON "VendorCandidate"("discoveryId");

-- CreateIndex
CREATE INDEX "VendorCandidate_propertyId_trade_status_idx" ON "VendorCandidate"("propertyId", "trade", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VendorCandidate_propertyId_trade_sourceRef_key" ON "VendorCandidate"("propertyId", "trade", "sourceRef");

-- CreateIndex
CREATE INDEX "IntakeConversation_pendingSince_idx" ON "IntakeConversation"("pendingSince");

-- CreateIndex
CREATE INDEX "Notification_userId_channel_readAt_idx" ON "Notification"("userId", "channel", "readAt");

-- CreateIndex
CREATE INDEX "Notification_channel_status_scheduledFor_idx" ON "Notification"("channel", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Notification_ackRequired_acknowledgedAt_ackDueAt_idx" ON "Notification"("ackRequired", "acknowledgedAt", "ackDueAt");

-- CreateIndex
CREATE INDEX "Notification_caseId_createdAt_idx" ON "Notification"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "PropertyVendor" ADD CONSTRAINT "PropertyVendor_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyVendor" ADD CONSTRAINT "PropertyVendor_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDiscovery" ADD CONSTRAINT "VendorDiscovery_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDiscovery" ADD CONSTRAINT "VendorDiscovery_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCandidate" ADD CONSTRAINT "VendorCandidate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCandidate" ADD CONSTRAINT "VendorCandidate_discoveryId_fkey" FOREIGN KEY ("discoveryId") REFERENCES "VendorDiscovery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Relay V1.1 data steps (hand-written)

-- Vendor approval moves from a global flag to each property's directory. Every vendor that was approved is
-- approved at every existing property, so no property loses a vendor it could use before this migration.
INSERT INTO "PropertyVendor" ("id", "propertyId", "vendorId", "approved", "approvedAt", "source", "note")
SELECT gen_random_uuid()::text, p."id", v."id", true, CURRENT_TIMESTAMP, 'MANUAL', 'Carried over from the global approval flag (V1.1 migration)'
FROM "Vendor" v CROSS JOIN "Property" p
WHERE v."approved" = true
ON CONFLICT ("propertyId", "vendorId") DO NOTHING;

ALTER TABLE "Vendor" DROP COLUMN "approved";

-- At most one discovery in flight per case and trade, so concurrent triggers cannot start two paid searches.
CREATE UNIQUE INDEX "one_active_discovery_per_case_trade" ON "VendorDiscovery"("caseId", "trade")
WHERE "status" IN ('AWAITING_MANAGER', 'QUEUED', 'RUNNING') AND "caseId" IS NOT NULL;
