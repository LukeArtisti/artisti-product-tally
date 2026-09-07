export type IncludedOrder = {
  id: string;
  name: string;
  processedAt: string;
  itemCount: number;
};

export type ShopTimezone = {
  ianaTimezone: string;
  timezoneAbbreviation: string;
  timezoneOffset: string;
};

function getTimeZoneOffsetMs(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );

  return asUtc - instant;
}

export function convertShopLocalToUtc(
  date: string,
  time: string,
  timeZone: string,
) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  let instant = desiredAsUtc;
  for (let index = 0; index < 2; index += 1) {
    const offset = getTimeZoneOffsetMs(instant, timeZone);
    instant = desiredAsUtc - offset;
  }

  return new Date(instant).toISOString();
}

function formatOffset(offsetMs: number) {
  const sign = offsetMs >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMs);
  const hours = String(Math.floor(absolute / 3600000)).padStart(2, "0");
  const minutes = String(Math.floor((absolute % 3600000) / 60000)).padStart(
    2,
    "0",
  );

  return `${sign}${hours}:${minutes}`;
}

function toShopQueryDateTime(date: string, time: string, timeZone: string) {
  const utcIso = convertShopLocalToUtc(date, time, timeZone);
  const offsetMs = getTimeZoneOffsetMs(new Date(utcIso).getTime(), timeZone);
  const clock = time.length === 5 ? `${time}:00` : time;

  return `${date}T${clock}${formatOffset(offsetMs)}`;
}

export function buildOrderRangeQuery(
  fromDate: string,
  fromTime: string,
  toDate: string,
  toTime: string,
  timeZone: string,
) {
  const from = toShopQueryDateTime(fromDate, fromTime, timeZone);
  const to = toShopQueryDateTime(toDate, toTime, timeZone);

  return `(processed_at:>='${from}' AND processed_at:<='${to}') OR (created_at:>='${from}' AND created_at:<='${to}')`;
}

export async function fetchShopTimezone(admin: any): Promise<ShopTimezone> {
  const response: any = await admin.graphql(
    `#graphql
      query ShopTimezone {
        shop {
          ianaTimezone
          timezoneAbbreviation
          timezoneOffset
        }
      }`,
  );

  const data = await response.json();

  if (data.errors) {
    throw new Error(data.errors[0]?.message || "Shopify API error");
  }

  const shop = data.data?.shop;

  return {
    ianaTimezone: shop?.ianaTimezone || "UTC",
    timezoneAbbreviation: shop?.timezoneAbbreviation || "UTC",
    timezoneOffset: shop?.timezoneOffset || "+00:00",
  };
}

export async function fetchAllOrders(
  admin: any,
  orderQuery: string,
): Promise<any[]> {
  const orders: any[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
        query GetOrders(
          $first: Int!
          $after: String
          $query: String!
        ) {
          orders(
            first: $first
            after: $after
            query: $query
            sortKey: PROCESSED_AT
          ) {
            nodes {
              id
              name
              createdAt
              processedAt

              lineItems(first: 250) {
                nodes {
                  title
                  name
                  quantity
                  sku
                  variantTitle
                  product {
                    productType
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
      {
        variables: {
          first: 100,
          after,
          query: orderQuery,
        },
      },
    );

    const data = await response.json();

    if (data.errors) {
      throw new Error(data.errors[0]?.message || "Shopify API error");
    }

    const orderData = data.data?.orders;

    if (!orderData) {
      break;
    }

    orders.push(...orderData.nodes);

    hasNextPage = orderData.pageInfo.hasNextPage;
    after = orderData.pageInfo.endCursor;
  }

  return orders;
}

export async function fetchOrdersSummary(
  admin: any,
  orderQuery: string,
): Promise<IncludedOrder[]> {
  const orders: IncludedOrder[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
        query GetOrdersSummary(
          $first: Int!
          $after: String
          $query: String!
        ) {
          orders(
            first: $first
            after: $after
            query: $query
            sortKey: PROCESSED_AT
          ) {
            nodes {
              id
              name
              createdAt
              processedAt
              currentSubtotalLineItemsQuantity
              subtotalLineItemsQuantity
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
      {
        variables: {
          first: 100,
          after,
          query: orderQuery,
        },
      },
    );

    const data = await response.json();

    if (data.errors) {
      throw new Error(data.errors[0]?.message || "Shopify API error");
    }

    const orderData = data.data?.orders;

    if (!orderData) {
      break;
    }

    for (const order of orderData.nodes) {
      orders.push({
        id: order.id,
        name: order.name,
        processedAt: order.processedAt || order.createdAt,
        itemCount:
          order.subtotalLineItemsQuantity ||
          order.currentSubtotalLineItemsQuantity ||
          0,
      });
    }

    hasNextPage = orderData.pageInfo.hasNextPage;
    after = orderData.pageInfo.endCursor;
  }

  return orders;
}
