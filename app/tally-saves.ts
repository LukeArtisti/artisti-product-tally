import type { OrderStatusValue } from "./order-filters";
import {
  parseOrderStatuses,
  parseSalesChannelIds,
} from "./order-filters";

export type TallySaveParams = {
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
  orderStatuses: OrderStatusValue[];
  salesChannelIds: string[];
  excludedOrderIds: string[];
};

export type SavedTallyRecord = TallySaveParams & {
  id: string;
  name: string;
  createdAt: string;
};

function parseExcludedOrderIdList(value: FormDataEntryValue | string | null) {
  try {
    const parsed = JSON.parse(String(value || "[]"));

    if (!Array.isArray(parsed)) {
      return [] as string[];
    }

    return parsed.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [] as string[];
  }
}

export function parseExcludedOrderIds(
  value: FormDataEntryValue | string | null,
) {
  return new Set(parseExcludedOrderIdList(value));
}

export function parseTallySaveParams(source: {
  get(name: string): FormDataEntryValue | string | null;
}): TallySaveParams | { error: string } {
  const fromDate = String(source.get("fromDate") || "");
  const fromTime = String(source.get("fromTime") || "");
  const toDate = String(source.get("toDate") || "");
  const toTime = String(source.get("toTime") || "");

  if (!fromDate || !fromTime || !toDate || !toTime) {
    return { error: "Please complete the date and time range." };
  }

  return {
    fromDate,
    fromTime,
    toDate,
    toTime,
    orderStatuses: parseOrderStatuses(source.get("orderStatuses")),
    salesChannelIds: parseSalesChannelIds(source.get("salesChannelIds")),
    excludedOrderIds: parseExcludedOrderIdList(source.get("excludedOrderIds")),
  };
}

export function defaultSaveName(params: TallySaveParams) {
  return `${params.fromDate} ${params.fromTime} – ${params.toDate} ${params.toTime}`;
}

export function toSavedTallyRecord(row: {
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
}): SavedTallyRecord {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : (() => {
          const parsed = new Date(row.createdAt);
          return Number.isNaN(parsed.getTime())
            ? String(row.createdAt)
            : parsed.toISOString();
        })();

  return {
    id: row.id,
    name: row.name,
    fromDate: row.fromDate,
    fromTime: row.fromTime,
    toDate: row.toDate,
    toTime: row.toTime,
    orderStatuses: parseOrderStatuses(row.orderStatuses),
    salesChannelIds: parseSalesChannelIds(row.salesChannelIds),
    excludedOrderIds: parseExcludedOrderIdList(row.excludedOrderIds),
    createdAt,
  };
}
