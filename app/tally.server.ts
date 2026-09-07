export type TallyItem = {
  sku: string;
  name: string;
  variant?: string;
  quantity: number;
};

type LineItemNode = {
  title?: string | null;
  name?: string | null;
  quantity?: number | null;
  sku?: string | null;
  variantTitle?: string | null;
  product?: {
    productType?: string | null;
  } | null;
};

type OrderNode = {
  lineItems?: {
    nodes?: Array<LineItemNode | null> | null;
  } | null;
};

type GroupedCount = {
  count: number;
  sku: string;
  name: string;
  variants: string[];
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

function customCoffeeSort(a: { title: string }, b: { title: string }) {
  const getProductName = (title: string) =>
    title.split(/[-\s]/, 1)[0].toUpperCase();

  const nameA = getProductName(a.title);
  const nameB = getProductName(b.title);

  const namePriority: Record<string, number> = {
    CHAMPION: 1,
    THE: 2,
    DELICATE: 3,
    PLACEBO: 4,
    SINGLE: 5,
  };

  const priorityA = namePriority[nameA] || 100;
  const priorityB = namePriority[nameB] || 100;

  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  if (priorityA === 100 && a.title !== b.title) {
    return a.title.localeCompare(b.title);
  }

  const extractWeightValue = (title: string) => {
    const match = title.match(/(\d+)(g|kg)/i);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      return unit === "kg" ? value * 1000 : value;
    }
    return 99999;
  };

  const weightA = extractWeightValue(a.title);
  const weightB = extractWeightValue(b.title);

  if (weightA !== weightB) {
    return weightA - weightB;
  }

  return a.title.localeCompare(b.title);
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
) {
  const existing = groupedTally[groupKey][displayTitle];
  const variant = variantLabel(variantTitle);

  if (existing) {
    existing.count += quantity;
    if (variant && !existing.variants.includes(variant)) {
      existing.variants.push(variant);
    }
    return;
  }

  groupedTally[groupKey][displayTitle] = {
    count: quantity,
    sku,
    name,
    variants: variant ? [variant] : [],
  };
}

function toTallyItem(row: {
  sku: string;
  name: string;
  count: number;
  variants: string[];
}): TallyItem {
  return {
    sku: row.sku,
    name: row.name,
    variant: row.variants.join(", "),
    quantity: row.count,
  };
}

export function tallyOrders(orders: OrderNode[]): {
  coffeeProducts: TallyItem[];
  accessories: TallyItem[];
} {
  const groupedTally: Record<string, Record<string, GroupedCount>> = {};

  for (const group of GROUP_ORDER) {
    groupedTally[group] = {};
  }

  for (const order of orders) {
    const lineItems = order.lineItems?.nodes;
    if (!lineItems) continue;

    for (const item of lineItems) {
      if (!item) continue;

      const productType = item.product?.productType
        ? item.product.productType.toLowerCase()
        : "";
      let baseTitle = item.title || item.name || "";
      const variantTitle = item.variantTitle || "";
      let quantity = item.quantity || 0;
      const sku = item.sku || "";

      if (
        baseTitle.toLowerCase() === "tip" ||
        productType === "beverage" ||
        !item.product ||
        !productType
      ) {
        continue;
      }

      const groupKey = TYPE_TO_GROUP[productType] || "Everything Else";
      let displayTitle = baseTitle;

      if (groupKey === "Coffees") {
        let numericSize = 0;
        let sizeVariant = "";

        for (const pattern of COFFEE_TITLE_PATTERNS) {
          baseTitle = baseTitle.replace(pattern, "").trim();
        }

        if (variantTitle) {
          sizeVariant = variantTitle.split(/[ /]/, 1)[0].trim().toLowerCase();

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
        addToGroup(
          groupedTally,
          groupKey,
          displayTitle,
          baseTitle,
          quantity,
          sku,
          variantTitle,
        );
      }
    }
  }

  const coffeeProducts = Object.entries(groupedTally.Coffees)
    .map(([title, data]) => ({
      title,
      ...data,
    }))
    .sort(customCoffeeSort)
    .map((row) => toTallyItem(row));

  const accessories = GROUP_ORDER.filter((group) => group !== "Coffees")
    .flatMap((groupName) => {
      const products = Object.entries(groupedTally[groupName]).map(
        ([title, data]) => ({
          title,
          ...data,
        }),
      );

      products.sort((a, b) => {
        const titleComparison = a.title.localeCompare(b.title);
        if (titleComparison !== 0) {
          return titleComparison;
        }
        return b.count - a.count;
      });

      return products.map((row) => toTallyItem(row));
    });

  return {
    coffeeProducts,
    accessories,
  };
}
