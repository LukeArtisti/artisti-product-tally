-- CreateTable
CREATE TABLE "SavedTally" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "fromTime" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "toTime" TEXT NOT NULL,
    "orderStatuses" TEXT NOT NULL,
    "salesChannelIds" TEXT NOT NULL,
    "excludedOrderIds" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SavedTally_shop_createdAt_idx" ON "SavedTally"("shop", "createdAt");
