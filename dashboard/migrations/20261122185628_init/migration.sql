-- CreateTable
CREATE TABLE "DemoSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sessionId" TEXT NOT NULL,
    "openKey" TEXT,
    "residence" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "symptom" TEXT NOT NULL,
    "floorStatus" TEXT NOT NULL,
    "reportedErrorCode" TEXT,
    "safetyHazard" BOOLEAN NOT NULL DEFAULT false,
    "hazardDetails" TEXT,
    "intakeCount" INTEGER NOT NULL DEFAULT 1,
    "intakeFingerprint" TEXT NOT NULL,
    "conversationId" TEXT,
    "repairStatus" TEXT NOT NULL DEFAULT 'OPTIONS_PENDING',
    "optionsStartedAt" TIMESTAMP(3),
    "recommendedKey" TEXT,
    "recommendation" TEXT,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffRequest" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "desk" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "assignedTo" TEXT NOT NULL DEFAULT 'STAFF',
    "etaMinutes" INTEGER,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3),
    "unavailableAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorResult" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "contractorKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "availability" TEXT,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "priceNote" TEXT,
    "summary" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractorResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerDecision" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "contractorKey" TEXT NOT NULL,
    "contractorName" TEXT NOT NULL,
    "estimateCents" INTEGER NOT NULL,
    "estimateNote" TEXT NOT NULL,
    "autoApproveLimitCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedCapCents" INTEGER,
    "capNote" TEXT,
    "decidedBy" TEXT,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ManagerDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "contractorKey" TEXT NOT NULL,
    "contractorName" TEXT NOT NULL,
    "arrivalWindow" TEXT NOT NULL,
    "arrivalStart" TIMESTAMP(3) NOT NULL,
    "arrivalEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lane" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "studentMessage" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_openKey_key" ON "WorkOrder"("openKey");

-- CreateIndex
CREATE UNIQUE INDEX "StaffRequest_workOrderId_key" ON "StaffRequest"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorResult_workOrderId_contractorKey_key" ON "ContractorResult"("workOrderId", "contractorKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerDecision_workOrderId_key" ON "ManagerDecision"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_workOrderId_key" ON "Appointment"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_dedupeKey_key" ON "TimelineEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "TimelineEvent_workOrderId_createdAt_idx" ON "TimelineEvent"("workOrderId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DemoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffRequest" ADD CONSTRAINT "StaffRequest_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorResult" ADD CONSTRAINT "ContractorResult_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerDecision" ADD CONSTRAINT "ManagerDecision_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
