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
  { value: "unpaid", label: "Unpaid" },
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;

export type OrderStatusValue = (typeof ORDER_STATUS_OPTIONS)[number]["value"];

const ORDER_STATUS_VALUES = new Set<string>(
  ORDER_STATUS_OPTIONS.map((option) => option.value),
);

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

    const statuses = parsed.filter(
      (item): item is OrderStatusValue =>
        typeof item === "string" && ORDER_STATUS_VALUES.has(item),
    );

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

function gidNumericId(gid: string | null | undefined) {
  if (!gid) return "";

  const match = String(gid).match(/(\d+)\s*$/);
  return match?.[1] || "";
}

function orderIsOpen(order: any) {
  return !order?.cancelledAt && !order?.closed && !order?.closedAt;
}

function orderIsArchived(order: any) {
  return Boolean(order?.closed || order?.closedAt);
}

function orderIsUnfulfilled(order: any) {
  const status = String(order?.displayFulfillmentStatus || "").toUpperCase();

  return [
    "UNFULFILLED",
    "PARTIAL",
    "PARTIALLY_FULFILLED",
    "UNSHIPPED",
    "ON_HOLD",
    "SCHEDULED",
  ].includes(status);
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

function orderChannelValues(order: any) {
  const sourceName = String(order?.sourceName || "").toLowerCase();
  const aliasNames = SOURCE_NAME_ALIASES[sourceName] || [];
  const channelInfo = order?.channelInformation;

  return [
    gidNumericId(order?.publication?.id),
    order?.publication?.name,
    order?.sourceName,
    ...aliasNames,
    order?.app?.id,
    gidNumericId(order?.app?.id),
    order?.app?.name,
    order?.attribution?.handle,
    order?.attribution?.displayName,
    channelInfo?.channelId,
    gidNumericId(channelInfo?.channelId),
    channelInfo?.displayName,
    channelInfo?.app?.id,
    gidNumericId(channelInfo?.app?.id),
    channelInfo?.app?.title,
    channelInfo?.channelDefinition?.id,
    gidNumericId(channelInfo?.channelDefinition?.id),
    channelInfo?.channelDefinition?.handle,
    channelInfo?.channelDefinition?.channelName,
    channelInfo?.channelDefinition?.subChannelName,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function orderMatchesOneChannel(order: any, channel: SalesChannelOption) {
  const values = orderChannelValues(order);
  const candidates = [channel.id, channel.name, channel.handle]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const normalizedCandidates = candidates.map(normalizeChannelToken);
  const normalizedValues = values.map(normalizeChannelToken);

  if (candidates.some((candidate) => values.includes(candidate))) {
    return true;
  }

  return normalizedCandidates.some(
    (candidate) =>
      candidate.length > 0 &&
      normalizedValues.some(
        (value) =>
          value === candidate ||
          value.includes(candidate) ||
          candidate.includes(value),
      ),
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

  const selected = channels.filter((channel) => selectedIds.includes(channel.id));

  if (selected.length === 0) {
    return true;
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
