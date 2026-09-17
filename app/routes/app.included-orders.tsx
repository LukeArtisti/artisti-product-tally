import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  filterOrdersBySelection,
  parseOrderStatuses,
  parseSalesChannelIds,
} from "../order-filters";
import {
  buildOrderRangeQuery,
  buildTallyOrderQuery,
  fetchOrdersSummary,
  fetchSalesChannels,
  fetchShopTimezone,
  toIncludedOrder,
  withPickupDeliveryFlags,
} from "../orders.server";

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
      orders: [],
    };
  }

  try {
    const shop = await fetchShopTimezone(admin);
    const salesChannels = await fetchSalesChannels(admin);
    const statuses = parseOrderStatuses(url.searchParams.get("orderStatuses"));
    const selectedChannelIds = parseSalesChannelIds(
      url.searchParams.get("salesChannelIds"),
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
    const rangeQuery = buildOrderRangeQuery(
      fromDate,
      fromTime,
      toDate,
      toTime,
      shop.ianaTimezone,
    );
    const orders = filterOrdersBySelection(
      await withPickupDeliveryFlags(
        admin,
        await fetchOrdersSummary(admin, orderQuery),
        rangeQuery,
      ),
      statuses,
      salesChannels,
      selectedChannelIds,
    ).map(toIncludedOrder);

    return {
      success: true as const,
      orders,
    };
  } catch (error) {
    console.error(error);

    return {
      success: false as const,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load included orders.",
      orders: [],
    };
  }
}
