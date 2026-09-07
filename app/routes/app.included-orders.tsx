import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  buildOrderRangeQuery,
  fetchOrdersSummary,
  fetchShopTimezone,
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
    const orderQuery = buildOrderRangeQuery(
      fromDate,
      fromTime,
      toDate,
      toTime,
      shop.ianaTimezone,
    );
    const orders = await fetchOrdersSummary(admin, orderQuery);

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
