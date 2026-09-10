import {
  buildOrderStatusQuery,
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

function collectSalesChannels(publications: any[]) {
  const seen = new Set<string>();
  const channels: SalesChannelOption[] = [];

  for (const publication of publications) {
    const id = gidNumericId(publication?.id);
    const name = String(
      publication?.name || publication?.catalog?.title || "",
    ).trim();

    if (!id || !name || seen.has(id)) {
      continue;
    }

    seen.add(id);
    channels.push({
      id,
      name,
      handle: "",
    });
  }

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchSalesChannels(
  admin: any,
): Promise<SalesChannelOption[]> {
  try {
    const response: any = await admin.graphql(
      `#graphql
        query SalesChannels {
          publications(first: 50) {
            nodes {
              id
              name
              catalog {
                title
              }
            }
          }
        }`,
    );

    const data = await response.json();
    const channels = collectSalesChannels(data.data?.publications?.nodes || []);

    if (channels.length > 0) {
      return channels;
    }
  } catch {
    // Fall through to the product-publication lookup.
  }

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
              displayFulfillmentStatus
              sourceName
              publication {
                id
                name
              }
              app {
                id
                name
              }

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
              displayFulfillmentStatus
              sourceName
              publication {
                id
                name
              }
              app {
                id
                name
              }
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

    orders.push(...orderData.nodes);

    hasNextPage = orderData.pageInfo.hasNextPage;
    after = orderData.pageInfo.endCursor;
  }

  return orders;
}

export function toIncludedOrder(order: any): IncludedOrder {
  return {
    id: order.id,
    name: order.name,
    processedAt: order.processedAt || order.createdAt,
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
  displayFulfillmentStatus
  sourceName
  publication {
    id
    name
  }
  app {
    id
    name
  }
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
  shippingLines(first: 5) {
    nodes {
      title
    }
  }
  lineItems(first: 100) {
    nodes {
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
        first: 50,
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

  return orders;
}

function shippingLabelItems(nodes: any[]): ShippingLabelItem[] {
  const items = (nodes || []).map((item: any) => {
    const orderedQuantity = Number(item?.currentQuantity ?? item?.quantity ?? 0);
    const unfulfilledQuantity = Number(item?.unfulfilledQuantity);
    const variantTitle = String(item?.variantTitle || "").trim();
    const title = String(item?.name || item?.title || "").trim();

    return {
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

  const unfulfilledItems = items
    .filter((item) => item.unfulfilledQuantity > 0)
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.unfulfilledQuantity,
      imageUrl: item.imageUrl,
    }));

  if (unfulfilledItems.length > 0) {
    return unfulfilledItems;
  }

  return items
    .filter((item) => item.quantity > 0)
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      imageUrl: item.imageUrl,
    }));
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
    items: shippingLabelItems(order?.lineItems?.nodes || []),
  };
}
