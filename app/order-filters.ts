export type SalesChannelOption = {
  id: string;
  name: string;
  handle: string;
};

export const EXTRA_SALES_CHANNELS: SalesChannelOption[] = [
  {
    id: "recharge-subscriptions",
    name: "Recharge Subscriptions",
    handle: "recharge",
  },
  {
    id: "beanz-connect-integration",
    name: "Beanz Connect Integration",
    handle: "beanz-connect",
  },
];

export const ORDER_STATUS_OPTIONS = [
  { value: "unfulfilled", label: "Unfulfilled" },
  { value: "on_hold", label: "On hold" },
  { value: "unpaid", label: "Unpaid" },
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;

export type OrderStatusValue = (typeof ORDER_STATUS_OPTIONS)[number]["value"];

const ORDER_STATUS_VALUES = new Set<string>(
  ORDER_STATUS_OPTIONS.map((option) => option.value),
);

function normalizeSavedStatus(value: string): OrderStatusValue | null {
  return ORDER_STATUS_VALUES.has(value) ? (value as OrderStatusValue) : null;
}

function quoteQueryValue(value: string) {
  return `'${value.replace(/'/g, "\\'")}'`;
}

function joinOr(terms: string[]) {
  if (terms.length === 0) return "";
  if (terms.length === 1) return terms[0];

  return `(${terms.join(" OR ")})`;
}

export function parseOrderStatuses(value: FormDataEntryValue | string | null) {
  try {
    const parsed = JSON.parse(String(value || "[]"));

    if (!Array.isArray(parsed)) {
      return ["open"] as OrderStatusValue[];
    }

    const statuses = parsed
      .filter((item): item is string => typeof item === "string")
      .map(normalizeSavedStatus)
      .filter((item): item is OrderStatusValue => item !== null);

    return statuses.length > 0 ? statuses : (["open"] as OrderStatusValue[]);
  } catch {
    return ["open"] as OrderStatusValue[];
  }
}

export function parseSalesChannelIds(value: FormDataEntryValue | string | null) {
  try {
    const parsed = JSON.parse(String(value || "[]"));

    if (!Array.isArray(parsed)) {
      return [] as string[];
    }

    return parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  } catch {
    return [] as string[];
  }
}

const STATUS_FACETS: OrderStatusValue[] = [
  "unfulfilled",
  "on_hold",
  "unpaid",
  "open",
  "archived",
];

function selectedAllStatuses(statuses: OrderStatusValue[]) {
  const selected = new Set(statuses);

  return (
    selected.has("all") ||
    selected.size === 0 ||
    STATUS_FACETS.every((facet) => selected.has(facet))
  );
}

export function buildOrderStatusQuery(statuses: OrderStatusValue[]) {
  if (selectedAllStatuses(statuses)) {
    return "(status:open OR status:closed OR status:cancelled)";
  }

  if (statuses.length === 1 && statuses[0] === "open") {
    return "status:open";
  }

  if (statuses.length === 1 && statuses[0] === "archived") {
    return "status:closed";
  }

  return "(status:open OR status:closed OR status:cancelled)";
}

function asNodes(value: any): any[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.nodes)) {
    return value.nodes;
  }

  if (Array.isArray(value?.edges)) {
    return value.edges
      .map((edge: any) => edge?.node)
      .filter(Boolean);
  }

  return [];
}

function normalizeStatus(value: unknown) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function deliveryTokens(order: any) {
  const lines = [
    order?.shippingLine,
    ...asNodes(order?.shippingLines),
  ].filter(Boolean);

  return [
    order?.shippingMethod,
    order?.deliveryMethod,
    ...lines.map((line) => line?.title),
    ...lines.map((line) => line?.code),
    ...lines.map((line) => line?.source),
    ...lines.map((line) => line?.shippingRateHandle),
  ]
    .map((value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ""),
    )
    .filter(Boolean);
}

export function hasPickupDeliveryMethod(order: any) {
  return deliveryTokens(order).some(
    (token) =>
      token.includes("pickupinstore") ||
      token.includes("localpickup") ||
      token.includes("pickup") ||
      token.includes("pickuppoint"),
  );
}

function orderIsPickup(order: any) {
  return order?.isPickup === true || hasPickupDeliveryMethod(order);
}

function orderIsOpen(order: any) {
  return !order?.cancelledAt && !order?.closed && !order?.closedAt;
}

function orderIsArchived(order: any) {
  return Boolean(order?.closed || order?.closedAt);
}

function orderIsUnfulfilled(order: any) {
  const status = normalizeStatus(order?.displayFulfillmentStatus);

  return [
    "UNFULFILLED",
    "PARTIAL",
    "PARTIALLY_FULFILLED",
    "UNSHIPPED",
    "SCHEDULED",
  ].includes(status);
}

function orderIsOnHold(order: any) {
  return normalizeStatus(order?.displayFulfillmentStatus) === "ON_HOLD";
}

export function orderStatusLabel(order: any) {
  if (orderIsPickup(order)) {
    return "Pick up";
  }

  if (orderIsOnHold(order)) {
    return "On hold";
  }

  const status = String(order?.displayFulfillmentStatus || "").toUpperCase();

  if (!status) {
    return "Unknown";
  }

  const labels: Record<string, string> = {
    UNFULFILLED: "Unfulfilled",
    PARTIAL: "Partially fulfilled",
    PARTIALLY_FULFILLED: "Partially fulfilled",
    UNSHIPPED: "Unfulfilled",
    FULFILLED: "Fulfilled",
    IN_PROGRESS: "In progress",
    ON_HOLD: "On hold",
    SCHEDULED: "Scheduled",
    PENDING_FULFILLMENT: "Pending fulfillment",
    OPEN: "Open",
    REQUEST_DECLINED: "Request declined",
    RESTOCKED: "Restocked",
    READY_FOR_PICKUP: "Pick up",
  };

  return (
    labels[status] ||
    status
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

function orderIsUnpaid(order: any) {
  const status = String(order?.displayFinancialStatus || "").toUpperCase();

  return [
    "UNPAID",
    "PENDING",
    "AUTHORIZED",
    "PARTIALLY_PAID",
    "EXPIRED",
  ].includes(status);
}

function orderMatchesStatuses(order: any, statuses: OrderStatusValue[]) {
  if (selectedAllStatuses(statuses)) {
    return true;
  }

  return statuses.some((status) => {
    if (status === "open") return orderIsOpen(order);
    if (status === "archived") return orderIsArchived(order);
    if (status === "unfulfilled") return orderIsUnfulfilled(order);
    if (status === "on_hold") return orderIsOnHold(order);
    if (status === "unpaid") return orderIsUnpaid(order);
    return false;
  });
}

function selectedAllChannels(
  channels: SalesChannelOption[],
  selectedIds: string[],
) {
  const selected = selectedIds.filter((id) => id !== "all");

  return (
    selectedIds.length === 0 ||
    selectedIds.includes("all") ||
    (channels.length > 0 && selected.length === channels.length)
  );
}

function normalizeChannelToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const SOURCE_NAME_ALIASES: Record<string, string[]> = {
  web: ["online store", "online_store", "shopify"],
  pos: ["point of sale", "point_of_sale", "pos"],
  shopify_draft_order: ["draft orders", "draft order", "draft_orders"],
  iphone: ["shop", "shopify app", "buy button"],
  android: ["shop", "shopify app", "buy button"],
  subscription_contract: [
    "subscriptions",
    "subscription",
    "recharge",
    "recharge subscriptions",
  ],
  recharge: ["recharge subscriptions", "subscriptions"],
};

function titleCaseChannel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function orderSalesChannelLabel(order: any) {
  const channelInfo = order?.channelInformation;
  const definition = channelInfo?.channelDefinition;
  const sourceName = String(order?.sourceName || "").trim();
  const labels = [
    channelInfo?.displayName,
    definition?.channelName,
    channelInfo?.app?.title,
    order?.app?.name,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (labels[0]) {
    return labels[0];
  }

  const aliasName = SOURCE_NAME_ALIASES[sourceName.toLowerCase()]?.[0];

  if (aliasName) {
    return titleCaseChannel(aliasName);
  }

  const publicationName = String(order?.publication?.name || "").trim();

  if (publicationName) {
    return publicationName;
  }

  if (!sourceName) {
    return "Unknown";
  }

  return titleCaseChannel(sourceName);
}

function orderChannelIdentity(order: any) {
  const channelInfo = order?.channelInformation;
  const definition = channelInfo?.channelDefinition;

  return {
    label: normalizeChannelToken(orderSalesChannelLabel(order)),
    handle: normalizeChannelToken(String(definition?.handle || "")),
    definitionName: normalizeChannelToken(
      String(definition?.channelName || definition?.subChannelName || ""),
    ),
    sourceName: String(order?.sourceName || "").toLowerCase(),
    appTitle: normalizeChannelToken(
      String(channelInfo?.app?.title || order?.app?.name || ""),
    ),
  };
}

function isRechargeOrder(order: any) {
  const identity = orderChannelIdentity(order);

  return (
    identity.sourceName === "subscription_contract" ||
    identity.sourceName === "recharge" ||
    identity.label.includes("recharge") ||
    identity.appTitle.includes("recharge") ||
    identity.handle.includes("recharge")
  );
}

function isBeanzOrder(order: any) {
  const identity = orderChannelIdentity(order);

  return (
    identity.label.includes("beanz") ||
    identity.appTitle.includes("beanz") ||
    identity.handle.includes("beanz") ||
    identity.sourceName.includes("beanz")
  );
}

function orderMatchesOneChannel(order: any, channel: SalesChannelOption) {
  if (channel.id === "recharge-subscriptions") {
    return isRechargeOrder(order);
  }

  if (channel.id === "beanz-connect-integration") {
    return isBeanzOrder(order);
  }

  const identity = orderChannelIdentity(order);
  const name = normalizeChannelToken(channel.name);
  const handle = normalizeChannelToken(channel.handle);

  return Boolean(
    identity.label &&
      (identity.label === name || (handle.length > 0 && identity.label === handle)),
  );
}

function orderMatchesChannels(
  order: any,
  channels: SalesChannelOption[],
  selectedIds: string[],
) {
  if (selectedAllChannels(channels, selectedIds)) {
    return true;
  }

  const selected = channels.filter((channel) =>
    selectedIds.includes(channel.id),
  );

  if (selected.length === 0) {
    return false;
  }

  return selected.some((channel) => orderMatchesOneChannel(order, channel));
}

export function filterOrdersBySelection<T>(
  orders: T[],
  statuses: OrderStatusValue[],
  channels: SalesChannelOption[],
  selectedChannelIds: string[],
) {
  return orders.filter(
    (order) =>
      orderMatchesStatuses(order, statuses) &&
      orderMatchesChannels(order, channels, selectedChannelIds),
  );
}

export function buildSalesChannelQuery(
  channels: SalesChannelOption[],
  selectedIds: string[],
) {
  if (selectedAllChannels(channels, selectedIds)) {
    return "";
  }

  const selected = new Set(selectedIds.filter((id) => id !== "all"));
  const terms = channels
    .filter((channel) => selected.has(channel.id))
    .flatMap((channel) => {
      const channelTerms: string[] = [];

      if (channel.handle) {
        channelTerms.push(`channel:${channel.handle}`);
      }

      if (channel.name) {
        channelTerms.push(`sales_channel:${quoteQueryValue(channel.name)}`);
      }

      if (channel.id) {
        channelTerms.push(`channel_id:${channel.id}`);
      }

      return channelTerms.length > 0 ? [joinOr(channelTerms)] : [];
    });

  return joinOr(terms);
}
