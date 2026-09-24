export type MachineOrGrinderKind = "machine" | "grinder";

export type TallyItem = {
  sku: string;
  name: string;
  variant?: string;
  vendor?: string;
  salesChannel: string;
  fulfillmentStatus?: string;
  quantity: number;
  bagCount?: number;
  unitGrams?: number;
  sizeLabel?: string;
  kind?: MachineOrGrinderKind;
};

export type CoffeeGrindSizeLine = {
  sizeLabel: string;
  bags: number;
  grams: number;
};

export type CoffeeGrindSummary = {
  name: string;
  sizes: CoffeeGrindSizeLine[];
  totalGrams: number;
};

export function parseCoffeePackSize(text: string): { grams: number; label: string } | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2].toLowerCase();
  const grams = unit === "kg" ? value * 1000 : value;
  const label = `${value}${unit}`;

  return { grams, label };
}

export function formatCoffeeWeight(grams: number) {
  if (grams >= 1000) {
    const kg = grams / 1000;
    const text = Number.isInteger(kg)
      ? String(kg)
      : kg.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${text} kg`;
  }

  const text = Number.isInteger(grams)
    ? String(grams)
    : grams.toFixed(1).replace(/\.0$/, "");
  return `${text} g`;
}

export function customCoffeeSort(a: { title: string }, b: { title: string }) {
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

export function summarizeCoffeeToGrind(items: TallyItem[]): CoffeeGrindSummary[] {
  const byName = new Map<string, Map<string, CoffeeGrindSizeLine>>();

  for (const item of items) {
    const name = (item.name.trim() || "Unknown coffee")
      .replace(/\s*[-–—]?\s*\d+(?:\.\d+)?\s*(kg|g)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim() || item.name.trim() || "Unknown coffee";
    const bags = item.bagCount ?? 0;
    const unitGrams = item.unitGrams ?? 0;
    const sizeLabel = item.sizeLabel || (unitGrams > 0 ? formatCoffeeWeight(unitGrams) : "Unknown size");
    const grams = bags * unitGrams;

    let sizes = byName.get(name);
    if (!sizes) {
      sizes = new Map();
      byName.set(name, sizes);
    }

    const existing = sizes.get(sizeLabel);
    if (existing) {
      existing.bags += bags;
      existing.grams += grams;
    } else {
      sizes.set(sizeLabel, { sizeLabel, bags, grams });
    }
  }

  return [...byName.entries()]
    .map(([name, sizes]) => {
      const sizeList = [...sizes.values()].sort((a, b) => {
        const gramsA = a.bags > 0 ? a.grams / a.bags : 0;
        const gramsB = b.bags > 0 ? b.grams / b.bags : 0;
        return gramsA - gramsB || a.sizeLabel.localeCompare(b.sizeLabel);
      });

      return {
        name,
        sizes: sizeList,
        totalGrams: sizeList.reduce((sum, line) => sum + line.grams, 0),
      };
    })
    .sort((a, b) => customCoffeeSort({ title: a.name }, { title: b.name }));
}
