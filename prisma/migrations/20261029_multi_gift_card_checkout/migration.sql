CREATE TYPE "GiftCardCheckoutStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

ALTER TABLE "GiftCardOrder" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "GiftCardOrder" ADD COLUMN "unitAmount" DECIMAL(12,2);
ALTER TABLE "GiftCardOrder" ADD COLUMN "checkoutId" TEXT;
UPDATE "GiftCardOrder" SET "unitAmount" = "amount";
ALTER TABLE "GiftCardOrder" ALTER COLUMN "unitAmount" SET NOT NULL;

ALTER TABLE "GiftCard" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "GiftCard" ADD COLUMN "sentBy" TEXT;
UPDATE "GiftCard" AS card SET "sentAt" = orders."sentAt", "sentBy" = orders."sentBy"
FROM "GiftCardOrder" AS orders WHERE card."orderId" = orders.id;
DROP INDEX "GiftCard_orderId_key";
CREATE INDEX "GiftCard_orderId_idx" ON "GiftCard"("orderId");

CREATE TABLE "GiftCardCheckout" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "productId" TEXT,
  "type" "GiftCardProductType" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitAmount" DECIMAL(12,2) NOT NULL,
  "totalAmount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ARS',
  "purchaserName" TEXT NOT NULL,
  "purchaserPhone" TEXT NOT NULL,
  "recipientName" TEXT,
  "message" TEXT,
  "partySize" INTEGER,
  "prepareKey" TEXT,
  "requestHash" TEXT,
  "productFingerprint" TEXT,
  "status" "GiftCardCheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GiftCardCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiftCardCheckout_restaurantId_prepareKey_key" ON "GiftCardCheckout"("restaurantId", "prepareKey");
CREATE INDEX "GiftCardCheckout_restaurantId_purchaserPhone_status_createdAt_idx" ON "GiftCardCheckout"("restaurantId", "purchaserPhone", "status", "createdAt");
CREATE UNIQUE INDEX "GiftCardOrder_checkoutId_key" ON "GiftCardOrder"("checkoutId");

ALTER TABLE "GiftCardCheckout" ADD CONSTRAINT "GiftCardCheckout_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GiftCardCheckout" ADD CONSTRAINT "GiftCardCheckout_productId_fkey" FOREIGN KEY ("productId") REFERENCES "GiftCardProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GiftCardOrder" ADD CONSTRAINT "GiftCardOrder_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "GiftCardCheckout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
