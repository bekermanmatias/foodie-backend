-- Preserve legacy columns and columns left by a failed, non-transactional attempt.
-- Keep the remaining statements atomic when the migration is retried.
BEGIN;

-- AlterTable
ALTER TABLE "ReservationDeposit" ADD COLUMN IF NOT EXISTS "confirmationAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "ruleSnapshot" JSONB;

-- AlterTable
ALTER TABLE "DepositEntry" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "DepositProof" ADD COLUMN IF NOT EXISTS "driveError" TEXT,
ADD COLUMN IF NOT EXISTS "driveFileId" TEXT,
ADD COLUMN IF NOT EXISTS "driveFileUrl" TEXT,
ADD COLUMN IF NOT EXISTS "driveStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS "ingestionKey" TEXT,
ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "RestaurantDepositSettings" (
    "restaurantId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantDepositSettings_pkey" PRIMARY KEY ("restaurantId")
);

-- CreateTable
CREATE TABLE "RestaurantDriveConnection" (
    "restaurantId" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "stateHash" TEXT,
    "stateExpiresAt" TIMESTAMP(3),
    "stateUserId" TEXT,
    "rootFolderId" TEXT,
    "proofsFolderId" TEXT,
    "generalFolderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantDriveConnection_pkey" PRIMARY KEY ("restaurantId")
);

-- CreateTable
CREATE TABLE "DepositDelivery" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositUpload" (
    "objectKey" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "requestId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "DepositUpload_pkey" PRIMARY KEY ("objectKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantDriveConnection_stateHash_key" ON "RestaurantDriveConnection"("stateHash");

-- CreateIndex
CREATE INDEX "DepositDelivery_restaurantId_status_idx" ON "DepositDelivery"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DepositDelivery_reservationId_kind_key" ON "DepositDelivery"("reservationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DepositEntry_depositId_idempotencyKey_key" ON "DepositEntry"("depositId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DepositProof_ingestionKey_key" ON "DepositProof"("ingestionKey");

-- AddForeignKey
ALTER TABLE "RestaurantDepositSettings" ADD CONSTRAINT "RestaurantDepositSettings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDriveConnection" ADD CONSTRAINT "RestaurantDriveConnection_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDelivery" ADD CONSTRAINT "DepositDelivery_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


UPDATE "DepositProof" SET "reviewStatus" = 'approved' WHERE "entryId" IS NOT NULL;

COMMIT;
