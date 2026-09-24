import {
  buildOrderStatusQuery,
  EXTRA_SALES_CHANNELS,
  hasPickupDeliveryMethod,
  orderSalesChannelLabel,
  orderStatusLabel,
  pickFilterSalesChannels,
  splitQuantityByFulfillmentStatus,
  type OrderStatusValue,
  type SalesChannelOption,
} from "./order-filters";
import type {
  IncludedOrder,
  ShippingLabelItem,
  ShippingLabelOrder,
  ShopPrintInfo,
  ShopTimezone,
} from "./shipping-label";

export type {
  IncludedOrder,
  SalesChannelOption,
  ShippingLabelItem,
  ShippingLabelOrder,
  ShopPrintInfo,
  ShopTimezone,
};

export function gidNumericId(gid: string | null | undefined) {
  if (!gid) return "";

  const match = String(gid).match(/(\d+)\s*$/);
  return match?.[1] || "";
}

export function buildTallyOrderQuery(
  fromDate: string,
  fromTime: string,
  toDate: string,
  toTime: string,
  timeZone: string,
  statuses: OrderStatusValue[],
  channels: SalesChannelOption[],
  selectedChannelIds: string[],
) {
  const rangeQuery = buildOrderRangeQuery(
    fromDate,
    fromTime,
    toDate,
    toTime,
    timeZone,
  );
  const extras = [buildOrderStatusQuery(statuses)].filter(Boolean);

  if (extras.length === 0) {
    return rangeQuery;
  }

  return `(${rangeQuery}) AND ${extras.map((part) => `(${part})`).join(" AND ")}`;
}

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

const ORDER_FULFILLMENT_FIELDS = `
  displayFulfillmentStatus
  shippingLine {
    title
    code
    source
  }
  shippingLines(first: 5) {
    nodes {
      title
      code
      source
    }
  }
`;

const ORDER_CHANNEL_FIELDS = `
  sourceName
  publication {
    id
    name
  }
  app {
    id
    name
  }
  channelInformation {
    channelId
    displayName
    channelDefinition {
      id
      handle
      channelName
      subChannelName
    }
    app {
      id
      title
    }
  }
`;

function channelNameKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mergeSalesChannels(lists: SalesChannelOption[][]) {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const channels: SalesChannelOption[] = [];

  for (const list of lists) {
    for (const channel of list) {
      const nameKey = channelNameKey(channel.name);

      if (
        !channel.id ||
        !channel.name ||
        seenIds.has(channel.id) ||
        seenNames.has(nameKey)
      ) {
        continue;
      }

      seenIds.add(channel.id);
      seenNames.add(nameKey);
      channels.push(channel);
    }
  }

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

function collectSalesChannels(publications: any[]) {
  const channels: SalesChannelOption[] = [];

  for (const publication of publications) {
    const id = gidNumericId(publication?.id);
    const name = String(
      publication?.name || publication?.catalog?.title || "",
    ).trim();

    if (!id || !name) {
      continue;
    }

    channels.push({
      id,
      name,
      handle: "",
    });
  }

  return channels;
}

function collectChannelDefinitions(groups: any[]) {
  const channels: SalesChannelOption[] = [];

  for (const group of groups) {
    for (const definition of group?.channelDefinitions || []) {
      const name = String(
        definition?.channelName ||
          definition?.subChannelName ||
          group?.channelName ||
          "",
      ).trim();
      const id =
        gidNumericId(definition?.id) || String(definition?.handle || "").trim();

      if (!id || !name) {
        continue;
      }

      channels.push({
        id,
        name,
        handle: String(definition?.handle || "").trim(),
      });
    }
  }

  return channels;
}

async function fetchPublicationChannels(
  admin: any,
  catalogType?: "APP" | "MARKET",
) {
  const publications: any[] = [];
  let after: string | null = null;
  let hasNextPage = true;
  let pages = 0;

  while (hasNextPage && pages < 8) {
    const response: any = await admin.graphql(
      catalogType
        ? `#graphql
            query SalesChannelPublications(
              $first: Int!
              $after: String
              $catalogType: CatalogType
            ) {
              publications(first: $first, after: $after, catalogType: $catalogType) {
                nodes {
                  id
                  name
                  catalog {
                    title
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }`
        : `#graphql
            query SalesChannelPublications($first: Int!, $after: String) {
              publications(first: $first, after: $after) {
                nodes {
                  id
                  name
                  catalog {
                    title
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
          first: 50,
          after,
          ...(catalogType ? { catalogType } : {}),
        },
      },
    );

    const data = await response.json();
    const connection = data.data?.publications;

    if (data.errors || !connection) {
      break;
    }

    publications.push(...(connection.nodes || []));
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = connection.pageInfo?.endCursor || null;
    pages += 1;
  }

  return collectSalesChannels(publications);
}

async function fetchChannelDefinitionChannels(admin: any) {
  try {
    const response: any = await admin.graphql(
      `#graphql
        query ShopChannelDefinitions {
          shop {
            availableChannelDefinitionsByChannel {
              channelName
              channelDefinitions {
                id
                handle
                channelName
                subChannelName
              }
            }
          }
        }`,
    );

    const data = await response.json();

    if (data.errors) {
      return [];
    }

    return collectChannelDefinitions(
      data.data?.shop?.availableChannelDefinitionsByChannel || [],
    );
  } catch {
    return [];
  }
}

async function fetchProductPublicationChannels(admin: any) {
  try {
    const response: any = await admin.graphql(
      `#graphql
        query ProductSalesChannels {
          products(first: 25, query: "status:active") {
            nodes {
              resourcePublications(first: 20) {
                nodes {
                  publication {
                    id
                    name
                  }
                }
              }
            }
          }
        }`,
    );

    const data = await response.json();

    if (data.errors) {
      return [];
    }

    const publications = (data.data?.products?.nodes || []).flatMap(
      (product: any) =>
        (product?.resourcePublications?.nodes || []).map(
          (item: any) => item?.publication,
        ),
    );

    return collectSalesChannels(publications);
  } catch {
    return [];
  }
}

export async function fetchSalesChannels(
  admin: any,
): Promise<SalesChannelOption[]> {
  const [allPublications, appPublications, definitions] = await Promise.all([
    fetchPublicationChannels(admin).catch(() => []),
    fetchPublicationChannels(admin, "APP").catch(() => []),
    fetchChannelDefinitionChannels(admin),
  ]);

  const productPublications =
    allPublications.length + appPublications.length === 0
      ? await fetchProductPublicationChannels(admin)
      : [];

  return pickFilterSalesChannels(
    mergeSalesChannels([
      allPublications,
      appPublications,
      definitions,
      productPublications,
      EXTRA_SALES_CHANNELS,
    ]),
  );
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
              closed
              closedAt
              cancelledAt
              displayFinancialStatus
              ${ORDER_FULFILLMENT_FIELDS}
              ${ORDER_CHANNEL_FIELDS}

              lineItems(first: 250) {
                nodes {
                  id
                  title
                  name
                  quantity
                  currentQuantity
                  unfulfilledQuantity
                  sku
                  variantTitle
                  variant {
                    selectedOptions {
                      name
                      value
                    }
                  }
                  product {
                    productType
                    templateSuffix
                    tags
                    vendor
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
          first: 25,
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

  await attachFulfillmentOrders(admin, orders);

  return orders;
}

export async function fetchOrdersSummary(
  admin: any,
  orderQuery: string,
): Promise<any[]> {
    const orders: any[] = [];
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
              closed
              closedAt
              cancelledAt
              displayFinancialStatus
              ${ORDER_FULFILLMENT_FIELDS}
              ${ORDER_CHANNEL_FIELDS}
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
          first: 25,
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

async function fetchPickupOrderIds(admin: any, rangeQuery: string) {
  const pickupIds = new Set<string>();
  const searchQueries = [
    `(${rangeQuery}) AND delivery_method:pick-up`,
    `(${rangeQuery}) AND delivery_method:pickup`,
  ];

  for (const query of searchQueries) {
    let after: string | null = null;
    let hasNextPage = true;
    let pages = 0;

    while (hasNextPage && pages < 20) {
      const response: any = await admin.graphql(
        `#graphql
          query PickupOrderIds($first: Int!, $after: String, $query: String!) {
            orders(first: $first, after: $after, query: $query) {
              nodes {
                id
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
        {
          variables: {
            first: 50,
            after,
            query,
          },
        },
      );

      const data = await response.json();

      if (data.errors || !data.data?.orders) {
        break;
      }

      const connection = data.data.orders;

      for (const order of connection.nodes || []) {
        if (!order?.id) continue;
        pickupIds.add(order.id);
        pickupIds.add(gidNumericId(order.id));
      }

      hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
      after = connection.pageInfo?.endCursor || null;
      pages += 1;
    }
  }

  return pickupIds;
}

async function fetchPickupIdsFromShippingLines(
  session: { shop: string; accessToken?: string } | undefined,
  orders: any[],
) {
  const pickupIds = new Set<string>();
  const ids = [
    ...new Set(orders.map((order) => gidNumericId(order?.id)).filter(Boolean)),
  ];

  if (!session?.accessToken || ids.length === 0) {
    return pickupIds;
  }

  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const params = new URLSearchParams({
      ids: chunk.join(","),
      limit: "250",
      status: "any",
      fields: "id,shipping_lines",
    });
    const response = await fetch(
      `https://${session.shop}/admin/api/2026-07/orders.json?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
      },
    );

    if (!response.ok) {
      continue;
    }

    const data = (await response.json()) as { orders?: any[] };

    for (const order of data.orders || []) {
      const lines = Array.isArray(order?.shipping_lines)
        ? order.shipping_lines
        : [];
      const isPickup = lines.some((line: any) =>
        hasPickupDeliveryMethod({
          shippingLine: {
            title: line?.title,
            code: line?.code,
            source: line?.source,
          },
        }),
      );

      if (!isPickup) {
        continue;
      }

      const numericId = String(order.id);
      pickupIds.add(numericId);
      pickupIds.add(`gid://shopify/Order/${numericId}`);
    }
  }

  return pickupIds;
}

export async function withPickupDeliveryFlags<T>(
  admin: any,
  orders: T[],
  rangeQuery: string,
  options?: {
    session?: { shop: string; accessToken?: string };
  },
) {
  const [searchIds, restIds] = await Promise.all([
    fetchPickupOrderIds(admin, rangeQuery).catch(() => new Set<string>()),
    fetchPickupIdsFromShippingLines(options?.session, orders as any[]).catch(
      () => new Set<string>(),
    ),
  ]);

  const pickupIds = new Set<string>([...searchIds, ...restIds]);

  return (orders as any[]).map((order) => ({
    ...order,
    isPickup:
      pickupIds.has(order.id) ||
      pickupIds.has(gidNumericId(order.id)) ||
      hasPickupDeliveryMethod(order),
  })) as T[];
}

export async function fetchOrdersForTallyFilters<T>(
  admin: any,
  session: { shop: string; accessToken?: string },
  fetchOrders: (admin: any, orderQuery: string) => Promise<T[]>,
  orderQuery: string,
  rangeQuery: string,
) {
  const orders = await fetchOrders(admin, orderQuery);

  return withPickupDeliveryFlags(admin, orders, rangeQuery, { session });
}

export function toIncludedOrder(order: any): IncludedOrder {
  return {
    id: order.id,
    name: order.name,
    processedAt: order.processedAt || order.createdAt,
    salesChannel: orderSalesChannelLabel(order),
    orderStatus: orderStatusLabel(order),
    itemCount:
      order.subtotalLineItemsQuantity ||
      order.currentSubtotalLineItemsQuantity ||
      0,
  };
}

function compactLines(values: Array<string | null | undefined>) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function formatPersonName(address: any, fallback = "") {
  const fromParts = [address?.firstName, address?.lastName]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  return String(address?.name || fromParts || fallback).trim();
}

function formatCityLine(address: any) {
  const zip = String(address?.zip || "").trim().toUpperCase();

  return compactLines([
    address?.city,
    address?.provinceCode || address?.province,
    zip,
  ]).join(" ");
}

function formatStreet(address: any) {
  return compactLines([address?.address1, address?.address2]);
}

function formatDefaultAddress(address: any) {
  if (!address) return "";

  if (Array.isArray(address.formatted) && address.formatted.length > 0) {
    return compactLines(address.formatted).join(", ");
  }

  return compactLines([
    address.company,
    ...formatStreet(address),
    formatCityLine(address),
    address.country,
  ]).join(", ");
}

function attributeValue(attributes: any[] | undefined, key: string) {
  const match = (attributes || []).find(
    (attribute) =>
      String(attribute?.key || "").trim().toLowerCase() === key.toLowerCase(),
  );

  return String(match?.value || "").trim();
}

function discountCodesFromOrder(order: any) {
  const values = [
    ...(order?.discountCodes || []),
    ...(order?.discountApplications?.nodes || []).map(
      (application: any) => application?.code,
    ),
  ];

  return values
    .map((value) =>
      String(typeof value === "string" ? value : value?.code || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function hasTag(tags: string[], value: string) {
  return tags.some((tag) => tag.toLowerCase() === value.toLowerCase());
}

function thankYouMessage(order: any) {
  const codes = discountCodesFromOrder(order);
  const tags = (order?.tags || []).map((tag: string) => String(tag || "").trim());
  const ordersCount = Number(order?.customer?.numberOfOrders || 0);
  const isFirstOrder = ordersCount === 1;
  const hasPendleburyDiscount =
    codes.includes("sp10-50") || codes.includes("sp10-20");

  const pendleburyFirst =
    "Thank you for supporting the Artisti Family!\nWe're proud to partner with Scott Pendlebury to bring you great coffee.";
  const pendleburyReturning =
    "Thanks for your continued support of the Artisti Family!\nWe're proud to partner with Scott Pendlebury to bring you great coffee.";

  if (hasPendleburyDiscount) {
    return isFirstOrder ? pendleburyFirst : pendleburyReturning;
  }

  if (hasTag(tags, "Subscription First Order")) {
    if (hasTag(tags, "Prepaid")) {
      return "Thanks for planning ahead! Here's your next pre-paid delivery!";
    }

    return "We are excited for you! Your regular coffee supply is locked in!";
  }

  if (isFirstOrder) {
    return "Thank you for supporting the Artisti Family!";
  }

  if (hasTag(tags, "Subscription")) {
    return "Thanks for your continued support, here's your next subscription order!";
  }

  return null;
}

const SHIPPING_LABEL_ORDER_FIELDS = `
  id
  name
  email
  phone
  note
  tags
  discountCodes
  createdAt
  processedAt
  closed
  closedAt
  cancelledAt
  displayFinancialStatus
  ${ORDER_FULFILLMENT_FIELDS}
  ${ORDER_CHANNEL_FIELDS}
  customAttributes {
    key
    value
  }
  discountApplications(first: 20) {
    nodes {
      ... on DiscountCodeApplication {
        code
      }
    }
  }
  shippingAddress {
    name
    firstName
    lastName
    company
    address1
    address2
    city
    zip
    province
    provinceCode
    country
    phone
  }
  billingAddress {
    name
    firstName
    lastName
    company
    address1
    address2
    city
    zip
    province
    provinceCode
    country
    phone
  }
  lineItems(first: 100) {
    nodes {
      id
      name
      title
      sku
      quantity
      currentQuantity
      unfulfilledQuantity
      variantTitle
      image {
        url(transform: { maxWidth: 200, maxHeight: 200 })
      }
    }
  }
`;

const CUSTOMER_FIELDS = `
  customer {
    displayName
    firstName
    lastName
    email
    phone
    numberOfOrders
    defaultAddress {
      name
      formatted
      company
      address1
      address2
      city
      zip
      province
      provinceCode
      country
      phone
    }
  }
`;

export async function fetchShopPrintInfo(admin: any): Promise<ShopPrintInfo> {
  const response: any = await admin.graphql(
    `#graphql
      query ShopPrintInfo {
        shop {
          name
          email
          billingAddress {
            address1
            city
            zip
            province
            provinceCode
            country
          }
        }
      }`,
  );

  const data = await response.json();

  if (data.errors) {
    throw new Error(data.errors[0]?.message || "Shopify API error");
  }

  const shop = data.data?.shop;
  const address = shop?.billingAddress;

  return {
    name: String(shop?.name || "Store").trim(),
    email: String(shop?.email || "").trim(),
    address1: String(address?.address1 || "").trim(),
    cityLine: formatCityLine(address),
    country: String(address?.country || "").trim(),
  };
}

async function fetchShippingLabelOrderPage(
  admin: any,
  orderQuery: string,
  after: string | null,
  includeCustomer: boolean,
) {
  const response: any = await admin.graphql(
    `#graphql
      query GetShippingLabelOrders(
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
            ${SHIPPING_LABEL_ORDER_FIELDS}
            ${includeCustomer ? CUSTOMER_FIELDS : ""}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
    {
      variables: {
        first: 25,
        after,
        query: orderQuery,
      },
    },
  );

  return response.json();
}

export async function fetchShippingLabelOrders(
  admin: any,
  orderQuery: string,
): Promise<any[]> {
  const orders: any[] = [];
  let hasNextPage = true;
  let after: string | null = null;
  let includeCustomer = true;

  while (hasNextPage) {
    let data = await fetchShippingLabelOrderPage(
      admin,
      orderQuery,
      after,
      includeCustomer,
    );

    if (data.errors && includeCustomer) {
      const message = String(data.errors[0]?.message || "");
      if (/customer|access scope|access denied/i.test(message)) {
        includeCustomer = false;
        data = await fetchShippingLabelOrderPage(
          admin,
          orderQuery,
          after,
          includeCustomer,
        );
      }
    }

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

  await attachFulfillmentOrders(admin, orders);

  return orders;
}

const FULFILLMENT_ORDER_BATCH_SIZE = 1;

async function adminGraphql(
  admin: any,
  query: string,
  variables: Record<string, unknown>,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response: any = await admin.graphql(query, { variables });
    const data = await response.json();

    if (data.errors) {
      const throttled = data.errors.some(
        (error: { extensions?: { code?: string } }) =>
          error?.extensions?.code === "THROTTLED",
      );

      if (throttled && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      throw new Error(data.errors[0]?.message || "Shopify API error");
    }

    const available = Number(
      data.extensions?.cost?.throttleStatus?.currentlyAvailable,
    );
    const restoreRate = Number(
      data.extensions?.cost?.throttleStatus?.restoreRate || 50,
    );

    if (Number.isFinite(available) && available < 250 && restoreRate > 0) {
      const waitMs = Math.ceil(((250 - available) / restoreRate) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 4000)));
    }

    return data.data;
  }

  throw new Error("Shopify API error");
}

async function collectFulfillmentLineItems(admin: any, fulfillmentOrder: any) {
  const lines = [...(fulfillmentOrder?.lineItems?.nodes || [])];
  let hasNextPage = Boolean(fulfillmentOrder?.lineItems?.pageInfo?.hasNextPage);
  let after = fulfillmentOrder?.lineItems?.pageInfo?.endCursor || null;

  while (hasNextPage && fulfillmentOrder?.id) {
    const data = await adminGraphql(
      admin,
      `#graphql
        query FulfillmentOrderLines($id: ID!, $after: String) {
          fulfillmentOrder(id: $id) {
            lineItems(first: 25, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                remainingQuantity
                lineItem {
                  id
                }
              }
            }
          }
        }`,
      { id: fulfillmentOrder.id, after },
    );
    const connection = data?.fulfillmentOrder?.lineItems;
    lines.push(...(connection?.nodes || []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
  }

  return lines;
}

async function collectFulfillmentOrders(admin: any, orderNode: any) {
  const collected = [];
  let connection = orderNode?.fulfillmentOrders;

  while (connection) {
    for (const fulfillmentOrder of connection.nodes || []) {
      if (!fulfillmentOrder) continue;

      collected.push({
        status: fulfillmentOrder.status,
        lineItems: {
          nodes: await collectFulfillmentLineItems(admin, fulfillmentOrder),
        },
      });
    }

    if (!connection.pageInfo?.hasNextPage || !orderNode?.id) break;

    const data = await adminGraphql(
      admin,
      `#graphql
        query MoreFulfillmentOrders($id: ID!, $after: String) {
          order(id: $id) {
            fulfillmentOrders(first: 8, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                status
                lineItems(first: 25) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    remainingQuantity
                    lineItem {
                      id
                    }
                  }
                }
              }
            }
          }
        }`,
      { id: orderNode.id, after: connection.pageInfo.endCursor },
    );
    connection = data?.order?.fulfillmentOrders;
  }

  return collected;
}

async function attachFulfillmentOrders(admin: any, orders: any[]) {
  const ids = [
    ...new Set(
      orders
        .map((order) => String(order?.id || ""))
        .filter(Boolean),
    ),
  ];

  if (ids.length === 0) return;

  const byOrderId = new Map<string, any[]>();

  for (let index = 0; index < ids.length; index += FULFILLMENT_ORDER_BATCH_SIZE) {
    const batch = ids.slice(index, index + FULFILLMENT_ORDER_BATCH_SIZE);
    const data = await adminGraphql(
      admin,
      `#graphql
        query OrderFulfillmentOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              fulfillmentOrders(first: 8) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  status
                  lineItems(first: 25) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      remainingQuantity
                      lineItem {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
      { ids: batch },
    );

    for (const node of data?.nodes || []) {
      if (!node?.id) continue;
      byOrderId.set(node.id, await collectFulfillmentOrders(admin, node));
    }
  }

  for (const order of orders) {
    const nodes = byOrderId.get(order.id);

    if (nodes) {
      order.fulfillmentOrders = { nodes };
    }
  }
}

function shippingLabelItems(order: any): ShippingLabelItem[] {
  type SlipLine = {
    id: string;
    sku: string;
    name: string;
    quantity: number;
    unfulfilledQuantity: number;
    imageUrl: string;
  };

  const items: SlipLine[] = (order?.lineItems?.nodes || []).map((item: any) => {
    const orderedQuantity = Number(item?.currentQuantity ?? item?.quantity ?? 0);
    const unfulfilledQuantity = Number(item?.unfulfilledQuantity);
    const variantTitle = String(item?.variantTitle || "").trim();
    const title = String(item?.name || item?.title || "").trim();

    return {
      id: String(item?.id || ""),
      sku: String(item?.sku || "").trim(),
      name:
        title.includes(variantTitle) || !variantTitle
          ? title
          : `${title} - ${variantTitle}`,
      quantity: orderedQuantity,
      unfulfilledQuantity: Number.isFinite(unfulfilledQuantity)
        ? unfulfilledQuantity
        : orderedQuantity,
      imageUrl: String(item?.image?.url || "").trim(),
    };
  });

  const unfulfilledItems = items.filter((item) => item.unfulfilledQuantity > 0);
  const visibleItems =
    unfulfilledItems.length > 0
      ? unfulfilledItems.map((item) => ({
          ...item,
          quantity: item.unfulfilledQuantity,
        }))
      : items.filter((item) => item.quantity > 0);

  return visibleItems.flatMap((item) =>
    splitQuantityByFulfillmentStatus(order, item.id, item.quantity).map(
      (part) => ({
        sku: item.sku,
        name: item.name,
        quantity: part.quantity,
        imageUrl: item.imageUrl,
        fulfillmentStatus: part.status,
      }),
    ),
  );
}

export function toShippingLabelOrder(order: any): ShippingLabelOrder {
  const customer = order?.customer;
  const shippingAddress = order?.shippingAddress;
  const billingAddress = order?.billingAddress;
  const customerName =
    formatPersonName(customer) ||
    customer?.displayName ||
    formatPersonName(shippingAddress) ||
    formatPersonName(billingAddress);
  const customerEmail = String(
    customer?.email || order?.email || "",
  ).trim();
  const customerPhone = String(
    (shippingAddress
      ? shippingAddress.phone || billingAddress?.phone || customer?.phone
      : billingAddress?.phone || customer?.phone) ||
      order?.phone ||
      "",
  ).trim();

  return {
    id: order.id,
    name: order.name,
    giftWrapped: attributeValue(order?.customAttributes, "Gift Wrapped") === "Yes",
    note: String(order?.note || "").trim(),
    thankYouHtml: thankYouMessage(order),
    customerName,
    customerPhone,
    customerEmail,
    customerDefaultAddress: formatDefaultAddress(customer?.defaultAddress),
    hasShippingAddress: Boolean(shippingAddress),
    shippingName: formatPersonName(shippingAddress),
    shippingPhone: String(shippingAddress?.phone || "").trim(),
    shippingCompany: String(shippingAddress?.company || "").trim(),
    shippingStreet: formatStreet(shippingAddress),
    shippingCityLine: formatCityLine(shippingAddress),
    shippingCountry: String(shippingAddress?.country || "").trim(),
    shippingMethod: String(order?.shippingLines?.nodes?.[0]?.title || "").trim(),
    items: shippingLabelItems(order),
  };
}
