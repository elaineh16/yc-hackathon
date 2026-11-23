-- CreateEnum
CREATE TYPE "Role" AS ENUM ('RESIDENT', 'MANAGER', 'CONTRACTOR');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('PLUMBING', 'APPLIANCE', 'HVAC', 'OTHER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('EMERGENCY', 'URGENT', 'ROUTINE');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('NEW', 'TRIAGED', 'AWAITING_ASSIGNMENT', 'AWAITING_VENDOR', 'AWAITING_APPROVAL', 'SCHEDULING', 'SCHEDULED', 'IN_PROGRESS', 'AWAITING_VERIFICATION', 'RESOLVED', 'ESCALATED', 'CANCELLED', 'REOPENED');

-- CreateEnum
CREATE TYPE "Holder" AS ENUM ('SYSTEM', 'RESIDENT', 'MANAGER', 'CONTRACTOR', 'NONE');

-- CreateEnum
CREATE TYPE "IntakeChannel" AS ENUM ('TEXT', 'CHAT', 'VOICE');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('VERIFIED_BY_RESIDENT', 'CLOSED_UNVERIFIED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'SUBMITTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('INTAKE', 'COORDINATOR');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXECUTED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "EstimateType" AS ENUM ('FIXED', 'INSPECTION_REQUIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED', 'VOID');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'SUPERSEDED', 'CANCELLED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "Audience" AS ENUM ('EVERYONE', 'MANAGEMENT', 'VENDOR');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" "Role" NOT NULL DEFAULT 'RESIDENT',
    "displayName" TEXT NOT NULL,
    "vendorId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "approvalThresholdCents" INTEGER NOT NULL DEFAULT 25000,
    "vendorResponseMinutes" INTEGER NOT NULL DEFAULT 1440,
    "verificationReminderMinutes" INTEGER NOT NULL DEFAULT 1440,
    "verificationCloseAfterMinutes" INTEGER NOT NULL DEFAULT 4320,
    "emergencyInstructions" TEXT NOT NULL DEFAULT 'If anyone is in danger, call 911 first.',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "autopilotRoutine" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyMembership" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "propertyId" TEXT NOT NULL,

    CONSTRAINT "PropertyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Residency" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "unitId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Residency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "trades" "Category"[],
    "phone" TEXT,
    "email" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "residentId" INTEGER NOT NULL,
    "channel" "IntakeChannel" NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "severity" "Severity" NOT NULL,
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "triageSource" TEXT NOT NULL,
    "triageReasons" TEXT[],
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "permissionToEnter" BOOLEAN NOT NULL DEFAULT false,
    "accessNotes" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'NEW',
    "holder" "Holder" NOT NULL DEFAULT 'SYSTEM',
    "nextAction" TEXT NOT NULL DEFAULT '',
    "nextActionDueAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationRequestedAt" TIMESTAMP(3),
    "verificationReminders" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolution" "Resolution",
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "aiAssessment" TEXT,
    "aiAssessedAt" TIMESTAMP(3),
    "agentPendingSince" TIMESTAMP(3),
    "agentPendingTrigger" TEXT,
    "agentPendingEventId" INTEGER,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeConversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "residentId" INTEGER NOT NULL,
    "unitId" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "facts" JSONB NOT NULL DEFAULT '{}',
    "clientRequestId" TEXT NOT NULL,
    "caseId" TEXT,

    CONSTRAINT "IntakeConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "kind" "AgentKind" NOT NULL,
    "caseId" TEXT,
    "conversationId" TEXT,
    "trigger" TEXT NOT NULL,
    "triggerKey" TEXT,
    "model" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "finalText" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "policyNote" TEXT NOT NULL,
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssignment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'OFFERED',
    "offeredById" INTEGER NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondByAt" TIMESTAMP(3) NOT NULL,
    "noteToVendor" TEXT,
    "respondedAt" TIMESTAMP(3),
    "respondedById" INTEGER,
    "declineReason" TEXT,
    "estimateType" "EstimateType",
    "estimateCents" INTEGER,
    "estimateNotes" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completionNotes" TEXT,
    "finalCostCents" INTEGER,

    CONSTRAINT "VendorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpendApproval" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "amountCents" INTEGER,
    "thresholdCents" INTEGER NOT NULL,
    "capCents" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" INTEGER,
    "note" TEXT,

    CONSTRAINT "SpendApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentSlot" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedById" INTEGER NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "residentAnsweredAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "AppointmentSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseEvent" (
    "id" SERIAL NOT NULL,
    "caseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" INTEGER,
    "actorRole" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "CaseStatus",
    "toStatus" "CaseStatus",
    "message" TEXT NOT NULL,
    "audience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "vendorId" TEXT,
    "data" JSONB,

    CONSTRAINT "CaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "caseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Auth" (
    "id" TEXT NOT NULL,
    "userId" INTEGER,

    CONSTRAINT "Auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "providerName" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerData" TEXT NOT NULL DEFAULT '{}',
    "authId" TEXT NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("providerName","providerUserId")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyMembership_userId_propertyId_key" ON "PropertyMembership"("userId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_propertyId_label_key" ON "Unit"("propertyId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Residency_userId_unitId_key" ON "Residency"("userId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Case_number_key" ON "Case"("number");

-- CreateIndex
CREATE INDEX "Case_propertyId_status_idx" ON "Case"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Case_holder_status_idx" ON "Case"("holder", "status");

-- CreateIndex
CREATE INDEX "Case_agentPendingSince_idx" ON "Case"("agentPendingSince");

-- CreateIndex
CREATE UNIQUE INDEX "Case_residentId_clientRequestId_key" ON "Case"("residentId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeConversation_caseId_key" ON "IntakeConversation"("caseId");

-- CreateIndex
CREATE INDEX "IntakeConversation_residentId_status_idx" ON "IntakeConversation"("residentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_triggerKey_key" ON "AgentRun"("triggerKey");

-- CreateIndex
CREATE INDEX "AgentRun_caseId_createdAt_idx" ON "AgentRun"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentProposal_caseId_status_idx" ON "AgentProposal"("caseId", "status");

-- CreateIndex
CREATE INDEX "VendorAssignment_vendorId_status_idx" ON "VendorAssignment"("vendorId", "status");

-- CreateIndex
CREATE INDEX "VendorAssignment_status_respondByAt_idx" ON "VendorAssignment"("status", "respondByAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpendApproval_assignmentId_key" ON "SpendApproval"("assignmentId");

-- CreateIndex
CREATE INDEX "AppointmentSlot_vendorId_status_startAt_idx" ON "AppointmentSlot"("vendorId", "status", "startAt");

-- CreateIndex
CREATE INDEX "AppointmentSlot_caseId_status_idx" ON "AppointmentSlot"("caseId", "status");

-- CreateIndex
CREATE INDEX "CaseEvent_caseId_id_idx" ON "CaseEvent"("caseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Auth_userId_key" ON "Auth"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_key" ON "Session"("id");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyMembership" ADD CONSTRAINT "PropertyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyMembership" ADD CONSTRAINT "PropertyMembership_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Residency" ADD CONSTRAINT "Residency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Residency" ADD CONSTRAINT "Residency_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeConversation" ADD CONSTRAINT "IntakeConversation_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeConversation" ADD CONSTRAINT "IntakeConversation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "IntakeConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssignment" ADD CONSTRAINT "VendorAssignment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssignment" ADD CONSTRAINT "VendorAssignment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendApproval" ADD CONSTRAINT "SpendApproval_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendApproval" ADD CONSTRAINT "SpendApproval_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VendorAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSlot" ADD CONSTRAINT "AppointmentSlot_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSlot" ADD CONSTRAINT "AppointmentSlot_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VendorAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentSlot" ADD CONSTRAINT "AppointmentSlot_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvent" ADD CONSTRAINT "CaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auth" ADD CONSTRAINT "Auth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_authId_fkey" FOREIGN KEY ("authId") REFERENCES "Auth"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Auth"("id") ON DELETE CASCADE ON UPDATE CASCADE;
