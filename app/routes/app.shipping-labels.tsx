import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  filterOrdersBySelection,
  parseOrderStatuses,
  parseSalesChannelIds,
} from "../order-filters";
import {
  buildTallyOrderQuery,
  fetchSalesChannels,
  fetchShippingLabelOrders,
  fetchShopPrintInfo,
  fetchShopTimezone,
  toShippingLabelOrder,
} from "../orders.server";

function parseExcludedOrderIds(value: string | null) {
  try {
    const parsed = JSON.parse(String(value || "[]"));

    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  } catch {
    return new Set<string>();
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const fromDate = String(url.searchParams.get("fromDate") || "");
  const fromTime = String(url.searchParams.get("fromTime") || "");
  const toDate = String(url.searchParams.get("toDate") || "");
  const toTime = String(url.searchParams.get("toTime") || "");

  if (!fromDate || !fromTime || !toDate || !toTime) {
    return {
      success: false as const,
      error: "Please complete the date and time range.",
      shop: null,
      orders: [],
    };
  }

  try {
    const [shop, shopPrint, salesChannels] = await Promise.all([
      fetchShopTimezone(admin),
      fetchShopPrintInfo(admin),
      fetchSalesChannels(admin),
    ]);
    const statuses = parseOrderStatuses(url.searchParams.get("orderStatuses"));
    const selectedChannelIds = parseSalesChannelIds(
      url.searchParams.get("salesChannelIds"),
    );
    const excludedOrderIds = parseExcludedOrderIds(
      url.searchParams.get("excludedOrderIds"),
    );
    const orderQuery = buildTallyOrderQuery(
      fromDate,
      fromTime,
      toDate,
      toTime,
      shop.ianaTimezone,
      statuses,
      salesChannels,
      selectedChannelIds,
    );
    const orders = filterOrdersBySelection(
      await fetchShippingLabelOrders(admin, orderQuery),
      statuses,
      salesChannels,
      selectedChannelIds,
    )
      .filter((order) => !excludedOrderIds.has(order.id))
      .map(toShippingLabelOrder);

    return {
      success: true as const,
      shop: shopPrint,
      orders: orders.slice(0, 50),
    };
  } catch (error) {
    console.error(error);

    return {
      success: false as const,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load shipping labels.",
      shop: null,
      orders: [],
    };
  }
}
