import {
  orderSalesChannelLabel,
  splitCountsByFulfillmentStatus,
} from "./order-filters";
import {
  customCoffeeSort,
  parseCoffeePackSize,
  type MachineOrGrinderKind,
  type TallyItem,
} from "./tally";

export type { TallyItem } from "./tally";

type LineItemNode = {
  id?: string | null;
  title?: string | null;
  name?: string | null;
  quantity?: number | null;
  currentQuantity?: number | null;
  sku?: string | null;
  variantTitle?: string | null;
  variant?: {
    selectedOptions?: Array<{
      name?: string | null;
      value?: string | null;
    } | null> | null;
  } | null;
  product?: {
    productType?: string | null;
    templateSuffix?: string | null;
    tags?: string[] | null;
    vendor?: string | null;
  } | null;
};

function asLineItemList(lineItems: any): LineItemNode[] | null {
  if (Array.isArray(lineItems?.nodes)) {
    return lineItems.nodes;
  }

  if (Array.isArray(lineItems)) {
    return lineItems;
  }

  return null;
}

type OrderNode = {
  displayFulfillmentStatus?: string | null;
  fulfillmentOrders?: {
    nodes?: Array<{
      status?: string | null;
      lineItems?: {
        nodes?: Array<{
          remainingQuantity?: number | null;
          lineItem?: { id?: string | null } | null;
        } | null> | null;
      } | null;
    } | null> | null;
  } | null;
  lineItems?: {
    nodes?: Array<LineItemNode | null> | null;
  } | null;
};

type GroupedCount = {
  count: number;
  sku: string;
  name: string;
  vendor: string;
  variants: string[];
  salesChannel: string;
  fulfillmentStatus: string;
  bagCount: number;
  unitGrams: number;
  sizeLabel: string;
  kind?: MachineOrGrinderKind;
};

const GROUP_ORDER = [
  "Coffees",
  "Coffee Machines and Grinders",
  "Brewing Gear and Accessories",
  "Tea, Chocolate and Syrups",
  "Apparel and Accessories",
  "Everything Else",
] as const;

const TYPE_TO_GROUP: Record<string, (typeof GROUP_ORDER)[number]> = {
  subscription: "Coffees",
  coffee: "Coffees",
  "blends 1kg": "Coffees",
  "coffee machines and grinders": "Coffee Machines and Grinders",
  "brewing gear and accessories": "Brewing Gear and Accessories",
  "tea, chocolate and syrups": "Tea, Chocolate and Syrups",
  "apparel & accessories": "Apparel and Accessories",
  merchandise: "Apparel and Accessories",
};

const COFFEE_TITLE_PATTERNS = [
  / - Coffee Beans/i,
  / - Organic Coffee Beans/i,
  / - Colombia Sugarcane Processed Decaf Coffee Beans/i,
  / - Peru Organic Grade 1 Swiss Water Processed Decaf Coffee Beans/i,
  / - Coffee Bean Subscription Auto renew/i,
  / - Coffee Bean Subscription/i,
  / Subscription/i,
  / Auto renew/i,
];

const MACHINE_TAGS = new Set(
  [
    "Coffee machine",
    "coffee machine",
    "COFFEE MACHINE",
    "Home Coffee Machines",
    "home coffee machines",
    "HOME COFFEE MACHINES",
  ].map((tag) => tag.toLowerCase()),
);

const GRINDER_TAGS = new Set(
  [
    "Home Coffee Grinders",
    "home coffee grinders",
    "HOME COFFEE GRINDERS",
  ].map((tag) => tag.toLowerCase()),
);

function productTagSet(tags: string[] | null | undefined) {
  return new Set(
    (tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
}

function hasAnyProductTag(
  tags: string[] | null | undefined,
  accepted: Set<string>,
) {
  const productTags = productTagSet(tags);

  for (const tag of productTags) {
    if (accepted.has(tag)) return true;
  }

  return false;
}

function machineOrGrinderKind(
  product?: LineItemNode["product"],
): MachineOrGrinderKind | null {
  const suffix = product?.templateSuffix?.trim().toLowerCase() ?? "";

  if (suffix === "coffe-machine" || suffix === "coffee-machine") {
    return "machine";
  }

  if (suffix === "grinder") {
    return "grinder";
  }

  if (hasAnyProductTag(product?.tags, GRINDER_TAGS)) {
    return "grinder";
  }

  if (hasAnyProductTag(product?.tags, MACHINE_TAGS)) {
    return "machine";
  }

  return null;
}

function coffeeSizeOptionValue(item: LineItemNode) {
  const options = item.variant?.selectedOptions ?? [];
  const sizeOption = options.find(
    (option) => option?.name?.trim().toLowerCase() === "size",
  );

  return sizeOption?.value?.trim() || "";
}

function variantLabel(variantTitle: string) {
  if (!variantTitle || variantTitle === "Default") {
    return "";
  }

  return variantTitle;
}

function addToGroup(
  groupedTally: Record<string, Record<string, GroupedCount>>,
  groupKey: string,
  displayTitle: string,
  name: string,
  quantity: number,
  sku: string,
  variantTitle: string,
  salesChannel: string,
  fulfillmentStatus: string,
  bagCount: number,
  unitGrams: number,
  sizeLabel: string,
  kind?: MachineOrGrinderKind,
  vendor = "",
) {
  const groupItemKey = `${displayTitle}\u0001${salesChannel}\u0001${fulfillmentStatus}`;
  const existing = groupedTally[groupKey][groupItemKey];
  const variant = variantLabel(variantTitle);

  if (existing) {
    existing.count += quantity;
    existing.bagCount += bagCount;
    if (variant && !existing.variants.includes(variant)) {
      existing.variants.push(variant);
    }
    if (!existing.vendor && vendor) {
      existing.vendor = vendor;
    }
    return;
  }

  groupedTally[groupKey][groupItemKey] = {
    count: quantity,
    sku,
    name,
    vendor,
    variants: variant ? [variant] : [],
    salesChannel,
    fulfillmentStatus,
    bagCount,
    unitGrams,
    sizeLabel,
    kind,
  };
}

function toTallyItem(row: GroupedCount): TallyItem {
  return {
    sku: row.sku,
    name: row.name,
    variant: row.variants.join(", "),
    vendor: row.vendor,
    salesChannel: row.salesChannel,
    fulfillmentStatus: row.fulfillmentStatus,
    quantity: row.count,
    bagCount: row.bagCount,
    unitGrams: row.unitGrams,
    sizeLabel: row.sizeLabel,
    kind: row.kind,
  };
}

function fulfillmentStatusOrder(status: string) {
  if (status === "Unfulfilled") return 0;
  if (status === "On hold") return 1;
  return 2;
}

function sortGroupedProducts(
  products: Array<{ title: string } & GroupedCount>,
) {
  products.sort((a, b) => {
    const titleComparison = a.title.localeCompare(b.title);
    if (titleComparison !== 0) {
      return titleComparison;
    }
    const statusComparison =
      fulfillmentStatusOrder(a.fulfillmentStatus) -
      fulfillmentStatusOrder(b.fulfillmentStatus);
    if (statusComparison !== 0) {
      return statusComparison;
    }
    return b.count - a.count;
  });

  return products.map((row) => toTallyItem(row));
}

export function tallyOrders(orders: OrderNode[]): {
  coffeeProducts: TallyItem[];
  machinesAndGrinders: TallyItem[];
  accessories: TallyItem[];
} {
  const groupedTally: Record<string, Record<string, GroupedCount>> = {};

  for (const group of GROUP_ORDER) {
    groupedTally[group] = {};
  }

  for (const order of orders) {
    const lineItems = asLineItemList(order.lineItems);
    if (!lineItems || lineItems.length === 0) continue;
    const salesChannel = orderSalesChannelLabel(order);

    for (const item of lineItems) {
      if (!item) continue;

      const equipmentKind = machineOrGrinderKind(item.product);
      const productType = item.product?.productType
        ? item.product.productType.toLowerCase()
        : "";
      let baseTitle = item.title || item.name || "";
      const variantTitle = item.variantTitle || "";
      let quantity = Number(item.currentQuantity ?? item.quantity ?? 0);
      const sku = item.sku || "";

      if (
        baseTitle.toLowerCase() === "tip" ||
        productType === "beverage" ||
        !item.product ||
        (!productType && !equipmentKind)
      ) {
        continue;
      }
      const groupKey = equipmentKind
        ? "Coffee Machines and Grinders"
        : TYPE_TO_GROUP[productType] || "Everything Else";
      let displayTitle = baseTitle;
      let bagCount = quantity;
      let unitGrams = 0;
      let sizeLabel = "";

      if (groupKey === "Coffees") {
        let numericSize = 0;
        let sizeVariant = "";

        for (const pattern of COFFEE_TITLE_PATTERNS) {
          baseTitle = baseTitle.replace(pattern, "").trim();
        }

        const sizeOptionValue = coffeeSizeOptionValue(item);
        const packSize = parseCoffeePackSize(sizeOptionValue);
        unitGrams = packSize?.grams ?? 0;
        sizeLabel = packSize?.label ?? sizeOptionValue;

        if (sizeOptionValue) {
          sizeVariant = sizeOptionValue.split(/[ /]/, 1)[0].trim().toLowerCase();

          const sizeMatch = sizeVariant.match(/^(\d+)kg$/);
          if (sizeMatch) {
            numericSize = parseInt(sizeMatch[1], 10);
          }
        }

        if (numericSize >= 1 && numericSize <= 4) {
          quantity *= numericSize;

          if (baseTitle.toLowerCase().includes("pre-paid")) {
            const variantParts = variantTitle.split(/[/-]/).map((part) =>
              part.trim(),
            );

            if (variantParts.length > 1) {
              baseTitle = variantParts[1];
            }
          }
        }

        if (variantTitle && variantTitle !== "Default") {
          displayTitle = `${baseTitle} - ${variantTitle}`;
        } else {
          displayTitle = baseTitle;
        }
      } else if (variantTitle && variantTitle !== "Default") {
        displayTitle = `${baseTitle} (${variantTitle})`;
      }

      if (quantity > 0) {
        const statusParts = splitCountsByFulfillmentStatus(order, item.id, [
          quantity,
          bagCount,
        ]);

        for (const part of statusParts) {
          const partQuantity = part.quantities[0] ?? 0;
          const partBagCount = part.quantities[1] ?? 0;

          if (partQuantity <= 0) continue;

          addToGroup(
            groupedTally,
            groupKey,
            displayTitle,
            baseTitle,
            partQuantity,
            sku,
            variantTitle,
            salesChannel,
            part.status,
            partBagCount,
            unitGrams,
            sizeLabel,
            equipmentKind ?? undefined,
            item.product?.vendor?.trim() || "",
          );
        }
      }
    }
  }

  const coffeeProducts = Object.entries(groupedTally.Coffees)
    .map(([key, data]) => ({
      title: key.split("\u0001")[0],
      ...data,
    }))
    .sort((a, b) => {
      const titleComparison = customCoffeeSort(a, b);
      if (titleComparison !== 0) return titleComparison;
      return (
        fulfillmentStatusOrder(a.fulfillmentStatus) -
        fulfillmentStatusOrder(b.fulfillmentStatus)
      );
    })
    .map((row) => toTallyItem(row));

  const machineGroupRows = Object.entries(
    groupedTally["Coffee Machines and Grinders"],
  ).map(([key, data]) => ({
    title: key.split("\u0001")[0],
    ...data,
  }));

  const machinesAndGrinders = machineGroupRows
    .filter((row) => row.kind)
    .sort((a, b) => {
      const kindOrder = { machine: 0, grinder: 1 };
      const kindA = a.kind ? kindOrder[a.kind] : 2;
      const kindB = b.kind ? kindOrder[b.kind] : 2;
      if (kindA !== kindB) return kindA - kindB;
      const vendorComparison = (a.vendor || "").localeCompare(b.vendor || "");
      if (vendorComparison !== 0) return vendorComparison;
      return a.title.localeCompare(b.title) ||
        fulfillmentStatusOrder(a.fulfillmentStatus) -
          fulfillmentStatusOrder(b.fulfillmentStatus) ||
        b.count - a.count;
    })
    .map((row) => toTallyItem(row));

  const leftoverEquipment = sortGroupedProducts(
    machineGroupRows.filter((row) => !row.kind),
  );

  const accessories = GROUP_ORDER.filter(
    (group) => group !== "Coffees" && group !== "Coffee Machines and Grinders",
  )
    .flatMap((groupName) => {
      const products = Object.entries(groupedTally[groupName]).map(
        ([key, data]) => ({
          title: key.split("\u0001")[0],
          ...data,
        }),
      );

      return sortGroupedProducts(products);
    })
    .concat(leftoverEquipment);

  return {
    coffeeProducts,
    machinesAndGrinders,
    accessories,
  };
}
