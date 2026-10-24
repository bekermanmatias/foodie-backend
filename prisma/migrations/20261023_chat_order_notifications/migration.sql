CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'chat_order',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "activeKey" TEXT,
  "channelId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "contactName" TEXT,
  "contactPhone" TEXT NOT NULL,
  "orderMode" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "attendedAt" TIMESTAMP(3),
  "attendedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Notification_attendedByUserId_fkey" FOREIGN KEY ("attendedByUserId") REFERENCES "RestaurantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Notification_restaurantId_activeKey_key" ON "Notification"("restaurantId", "activeKey");
CREATE INDEX "Notification_restaurantId_status_occurredAt_idx" ON "Notification"("restaurantId", "status", "occurredAt");
CREATE TABLE "NotificationEvent" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationEvent_restaurantId_eventKey_key" ON "NotificationEvent"("restaurantId", "eventKey");
CREATE INDEX "NotificationEvent_notificationId_idx" ON "NotificationEvent"("notificationId");
CREATE TABLE "NotificationRead" (
  "notificationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("notificationId", "userId"),
  CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "RestaurantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotificationRead_userId_idx" ON "NotificationRead"("userId");
