import { randomUUID } from "node:crypto";
import prisma from "./db.server";
import {
  toSavedTallyRecord,
  type SavedTallyRecord,
  type TallySaveParams,
} from "./tally-saves";

export type { SavedTallyRecord, TallySaveParams } from "./tally-saves";
export {
  defaultSaveName,
  parseExcludedOrderIds,
  parseTallySaveParams,
} from "./tally-saves";

type SavedTallyRow = {
  id: string;
  name: string;
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
  orderStatuses: string;
  salesChannelIds: string;
  excludedOrderIds: string;
  createdAt: Date | string;
};

let tableReady: Promise<void> | null = null;

function ensureSavedTallyTable() {
  if (!tableReady) {
    tableReady = prisma
      .$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "SavedTally" (
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
        )`,
      )
      .then(() =>
        prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "SavedTally_shop_createdAt_idx" ON "SavedTally"("shop", "createdAt")`,
        ),
      )
      .then(() => undefined)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }

  return tableReady;
}

export async function listSavedTallies(shop: string) {
  await ensureSavedTallyTable();

  const rows = await prisma.$queryRawUnsafe<SavedTallyRow[]>(
    `SELECT "id", "name", "fromDate", "fromTime", "toDate", "toTime",
            "orderStatuses", "salesChannelIds", "excludedOrderIds", "createdAt"
     FROM "SavedTally"
     WHERE "shop" = ?
     ORDER BY "createdAt" DESC`,
    shop,
  );

  return rows.map(toSavedTallyRecord);
}

export async function getSavedTally(shop: string, id: string) {
  await ensureSavedTallyTable();

  const rows = await prisma.$queryRawUnsafe<SavedTallyRow[]>(
    `SELECT "id", "name", "fromDate", "fromTime", "toDate", "toTime",
            "orderStatuses", "salesChannelIds", "excludedOrderIds", "createdAt"
     FROM "SavedTally"
     WHERE "shop" = ? AND "id" = ?
     LIMIT 1`,
    shop,
    id,
  );

  return rows[0] ? toSavedTallyRecord(rows[0]) : null;
}

export async function createSavedTally(
  shop: string,
  name: string,
  params: TallySaveParams,
): Promise<SavedTallyRecord> {
  await ensureSavedTallyTable();

  const id = randomUUID();
  const now = new Date().toISOString();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "SavedTally" (
      "id", "shop", "name", "fromDate", "fromTime", "toDate", "toTime",
      "orderStatuses", "salesChannelIds", "excludedOrderIds", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    shop,
    name,
    params.fromDate,
    params.fromTime,
    params.toDate,
    params.toTime,
    JSON.stringify(params.orderStatuses),
    JSON.stringify(params.salesChannelIds),
    JSON.stringify(params.excludedOrderIds),
    now,
    now,
  );

  const saved = await getSavedTally(shop, id);
  if (!saved) {
    throw new Error("Failed to save tally parameters.");
  }

  return saved;
}

export async function deleteSavedTally(shop: string, id: string) {
  await ensureSavedTallyTable();

  const result = await prisma.$executeRawUnsafe(
    `DELETE FROM "SavedTally" WHERE "shop" = ? AND "id" = ?`,
    shop,
    id,
  );

  return Number(result) > 0;
}
