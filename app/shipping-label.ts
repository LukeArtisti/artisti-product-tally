export const SHOP_ABN = "90 641 825 199";

export type ShopTimezone = {
  ianaTimezone: string;
  timezoneAbbreviation: string;
  timezoneOffset: string;
};

export type ShopPrintInfo = {
  name: string;
  email: string;
  address1: string;
  cityLine: string;
  country: string;
};

export type ShippingLabelItem = {
  sku: string;
  name: string;
  quantity: number;
  imageUrl: string;
};

export type ShippingLabelOrder = {
  id: string;
  name: string;
  giftWrapped: boolean;
  note: string;
  thankYouHtml: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerDefaultAddress: string;
  hasShippingAddress: boolean;
  shippingName: string;
  shippingPhone: string;
  shippingCompany: string;
  shippingStreet: string[];
  shippingCityLine: string;
  shippingCountry: string;
  shippingMethod: string;
  items: ShippingLabelItem[];
};

export type IncludedOrder = {
  id: string;
  name: string;
  processedAt: string;
  itemCount: number;
};
