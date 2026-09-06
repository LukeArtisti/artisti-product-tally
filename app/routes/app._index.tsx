import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

type TallyItem = {
  sku: string;
  name: string;
  variant?: string;
  quantity: number;
};

type TallyResponse = {
  success?: boolean;
  error?: string;
  orderCount?: number;
  coffeeProducts?: TallyItem[];
  accessories?: TallyItem[];
  totalCoffeeItems?: number;
  totalAccessoryItems?: number;
  totalItems?: number;
};

const dummyCoffeeProducts: TallyItem[] = [
  {
    sku: "B-CHM-1KG",
    name: "Champion",
    variant: "1kg",
    quantity: 2,
  },
  {
    sku: "B-ETH-250F",
    name: "Ethiopia Sidamo",
    variant: "250g",
    quantity: 12,
  },
  {
    sku: "B-ETH-1KGF",
    name: "Ethiopia Sidamo",
    variant: "1kg",
    quantity: 8,
  },
  {
    sku: "B-COL-250E",
    name: "Colombia Supremo",
    variant: "250g",
    quantity: 10,
  },
  {
    sku: "B-COL-1KGF",
    name: "Colombia Supremo",
    variant: "1kg",
    quantity: 6,
  },
];

const dummyAccessories: TallyItem[] = [
  {
    sku: "ACC-CAN-88-1KG-BLK",
    name: "Airscape Kilo Canister – 8” Large",
    variant: "1kg (Black)",
    quantity: 1,
  },
  {
    sku: "ACC-MUG-350-BLK",
    name: "Ceramic Mug",
    variant: "Black, 350ml",
    quantity: 10,
  },
  {
    sku: "ACC-MUG-350-WHT",
    name: "Ceramic Mug",
    variant: "White, 350ml",
    quantity: 6,
  },
  {
    sku: "ACC-JUG-600-SS",
    name: "Milk Jug",
    variant: "Stainless Steel, 600ml",
    quantity: 3,
  },
  {
    sku: "ACC-TAMP-58",
    name: "Coffee Tamper",
    variant: "58mm Flat Base",
    quantity: 2,
  },
];

function convertGMT8ToUTC(date: string, time: string) {
  const dateTime = `${date}T${time}:00+08:00`;
  return new Date(dateTime).toISOString();
}

async function fetchAllOrders(
  admin: any,
  orderQuery: string,
): Promise<any[]> {
  const orders: any[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  while (hasNextPage) {
    const response = await admin.graphql(
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
            sortKey: CREATED_AT
          ) {
            nodes {
              id
              name
              createdAt

              lineItems(first: 250) {
                nodes {
                  title
                  name
                  quantity
                  sku
                  variantTitle
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

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const fromDate = String(formData.get("fromDate") || "");
  const fromTime = String(formData.get("fromTime") || "");
  const toDate = String(formData.get("toDate") || "");
  const toTime = String(formData.get("toTime") || "");

  if (!fromDate || !fromTime || !toDate || !toTime) {
    return Response.json({
      success: false,
      error: "Please complete the date and time range.",
    });
  }

  try {
    const fromUTC = convertGMT8ToUTC(fromDate, fromTime);
    const toUTC = convertGMT8ToUTC(toDate, toTime);

    const orderQuery = `created_at:>='${fromUTC}' created_at:<='${toUTC}'`;

    const orders = await fetchAllOrders(admin, orderQuery);

    const coffeeMap = new Map<string, TallyItem>();
    const accessoryMap = new Map<string, TallyItem>();

    for (const order of orders) {
      for (const lineItem of order.lineItems.nodes) {
        const sku = lineItem.sku || "NO-SKU";

        const item: TallyItem = {
          sku,
          name: lineItem.title || lineItem.name || "Unnamed Product",
          variant: lineItem.variantTitle || "",
          quantity: lineItem.quantity || 0,
        };

        if (sku.startsWith("ACC-")) {
          const existing = accessoryMap.get(sku);

          if (existing) {
            existing.quantity += item.quantity;
          } else {
            accessoryMap.set(sku, item);
          }
        } else {
          const existing = coffeeMap.get(sku);

          if (existing) {
            existing.quantity += item.quantity;
          } else {
            coffeeMap.set(sku, item);
          }
        }
      }
    }

    const coffeeProducts = Array.from(coffeeMap.values());
    const accessories = Array.from(accessoryMap.values());

    const totalCoffeeItems = coffeeProducts.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    const totalAccessoryItems = accessories.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    return Response.json({
      success: true,
      orderCount: orders.length,
      coffeeProducts,
      accessories,
      totalCoffeeItems,
      totalAccessoryItems,
      totalItems: totalCoffeeItems + totalAccessoryItems,
    });
  } catch (error) {
    console.error(error);

    return Response.json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate product tally.",
    });
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export default function Index() {
  const fetcher = useFetcher<TallyResponse>();

  const [fromDate, setFromDate] = useState("2025-05-20");
  const [fromTime, setFromTime] = useState("00:00");
  const [toDate, setToDate] = useState("2025-05-20");
  const [toTime, setToTime] = useState("23:59");

  const [coffeeProducts, setCoffeeProducts] =
    useState<TallyItem[]>(dummyCoffeeProducts);

  const [accessories, setAccessories] =
    useState<TallyItem[]>(dummyAccessories);

  const totalCoffeeItems = coffeeProducts.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );

  const totalAccessoryItems = accessories.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );

  const totalItems = totalCoffeeItems + totalAccessoryItems;

  const formatDate = (date: string) => {
    if (!date) return "";

    return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const handleQuickSelect = (type: string) => {
    const today = new Date();

    const formatInputDate = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");

      return `${year}-${month}-${day}`;
    };

    if (type === "today") {
      const date = formatInputDate(today);

      setFromDate(date);
      setToDate(date);
      setFromTime("00:00");
      setToTime("23:59");
    }

    if (type === "yesterday") {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const date = formatInputDate(yesterday);

      setFromDate(date);
      setToDate(date);
      setFromTime("00:00");
      setToTime("23:59");
    }

    if (type === "last7") {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);

      setFromDate(formatInputDate(start));
      setToDate(formatInputDate(today));
      setFromTime("00:00");
      setToTime("23:59");
    }

    if (type === "last30") {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);

      setFromDate(formatInputDate(start));
      setToDate(formatInputDate(today));
      setFromTime("00:00");
      setToTime("23:59");
    }

    if (type === "thisMonth") {
      const start = new Date(
        today.getFullYear(),
        today.getMonth(),
        1,
      );

      setFromDate(formatInputDate(start));
      setToDate(formatInputDate(today));
      setFromTime("00:00");
      setToTime("23:59");
    }
  };

  const generateTally = () => {
    fetcher.submit(
      {
        fromDate,
        fromTime,
        toDate,
        toTime,
      },
      {
        method: "POST",
      },
    );
  };

  const isGenerating = fetcher.state !== "idle";

  return (
    <>
      <s-page inlineSize="large">
        <s-stack gap="large">

          <div className="tally-layout">

            <div className="main-content">

              {/* SECTION 1 */}
              <s-section>
                <s-stack gap="large">

                  <s-stack gap="small">
                    <s-heading>
                      1. Select Order Date &amp; Time Range
                    </s-heading>

                    <s-text>
                      Pull orders based on the order created date and time.
                    </s-text>
                  </s-stack>

                  <div className="date-tally-row">

                    <div className="date-tally-box">
                      <s-stack gap="small">

                        <s-text>
                          <strong>From</strong>
                        </s-text>

                        <input
                          type="date"
                          value={fromDate}
                          onChange={(event) =>
                            setFromDate(event.target.value)
                          }
                        />

                        <input
                          type="time"
                          value={fromTime}
                          onChange={(event) =>
                            setFromTime(event.target.value)
                          }
                        />

                      </s-stack>
                    </div>

                    <div className="date-tally-box">
                      <s-stack gap="small">

                        <s-text>
                          <strong>To</strong>
                        </s-text>

                        <input
                          type="date"
                          value={toDate}
                          onChange={(event) =>
                            setToDate(event.target.value)
                          }
                        />

                        <input
                          type="time"
                          value={toTime}
                          onChange={(event) =>
                            setToTime(event.target.value)
                          }
                        />

                      </s-stack>
                    </div>

                    <div className="or-column">
                      <s-text>Or</s-text>
                    </div>

                    <div className="quick-select-box">
                      <s-stack gap="small">

                        <s-text>
                          <strong>Quick Select</strong>
                        </s-text>

                        <div className="quick-grid">

                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSelect("today")
                            }
                          >
                            Today
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSelect("yesterday")
                            }
                          >
                            Yesterday
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSelect("last7")
                            }
                          >
                            Last 7 Days
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSelect("last30")
                            }
                          >
                            Last 30 Days
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSelect("thisMonth")
                            }
                          >
                            This Month
                          </button>

                          <button
                            type="button"
                            onClick={() => {}}
                          >
                            Custom Range
                          </button>

                        </div>

                      </s-stack>
                    </div>

                    <div className="note-column">

                      <div className="info-note">

                        <strong>Note</strong>

                        <div>
                          The tally will include orders created from{" "}
                          <b>
                            {fromDate} {fromTime}
                          </b>{" "}
                          to{" "}
                          <b>
                            {toDate} {toTime}
                          </b>.
                        </div>

                      </div>

                      <div className="generate-area">

                        <button
                          type="button"
                          className="generate-button"
                          onClick={generateTally}
                          disabled={isGenerating}
                        >
                          {isGenerating
                            ? "Generating..."
                            : "Generate Product Tally"}
                        </button>

                      </div>

                    </div>

                  </div>

                  {fetcher.data?.error && (
                    <div className="error-message">
                      {fetcher.data.error}
                    </div>
                  )}

                </s-stack>
              </s-section>


              {/* SECTION 2 */}
              <s-section>
                <s-stack gap="large">

                  <s-stack gap="small">

                    <s-heading>
                      2. Preview
                    </s-heading>

                    <s-text>
                      Based on selected date &amp; time range
                    </s-text>

                  </s-stack>

                  <div className="preview-grid">

                    {/* COFFEE */}
                    <div className="preview-card">

                      <div className="preview-header">

                        <strong>
                          Coffee Products Preview
                        </strong>

                        <span>
                          {totalCoffeeItems} items
                        </span>

                      </div>

                      <table>

                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>Product Name</th>
                            <th>Variant</th>
                            <th>Quantity</th>
                          </tr>
                        </thead>

                        <tbody>

                          {coffeeProducts.map((item) => (
                            <tr key={item.sku}>

                              <td>
                                {item.sku}
                              </td>

                              <td>
                                {item.name}
                              </td>

                              <td>
                                {item.variant}
                              </td>

                              <td>
                                {item.quantity}
                              </td>

                            </tr>
                          ))}

                        </tbody>

                      </table>

                      <div className="preview-total">

                        <strong>
                          Total Coffee Items
                        </strong>

                        <strong>
                          {totalCoffeeItems}
                        </strong>

                      </div>

                    </div>


                    {/* ACCESSORIES */}
                    <div className="preview-card">

                      <div className="preview-header">

                        <strong>
                          Accessories Preview
                        </strong>

                        <span>
                          {totalAccessoryItems} items
                        </span>

                      </div>

                      <table>

                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>Item Name</th>
                            <th>Quantity</th>
                          </tr>
                        </thead>

                        <tbody>

                          {accessories.map((item) => (
                            <tr key={item.sku}>

                              <td>
                                {item.sku}
                              </td>

                              <td>
                                {item.name}
                                {item.variant
                                  ? ` – ${item.variant}`
                                  : ""}
                              </td>

                              <td>
                                {item.quantity}
                              </td>

                            </tr>
                          ))}

                        </tbody>

                      </table>

                      <div className="preview-total">

                        <strong>
                          Total Accessory Items
                        </strong>

                        <strong>
                          {totalAccessoryItems}
                        </strong>

                      </div>

                    </div>

                  </div>

                </s-stack>
              </s-section>


              {/* SECTION 4 */}
              <s-section>
                <div className="generate-print-section">

                  <div className="generate-print-info">

                    <div className="generate-print-heading">
                      3. Print
                    </div>

                    <div className="generate-print-description">
                      Generate the tally and print packing sheets for your teams.
                    </div>

                  </div>

                  <div className="print-actions">

                    <button
                      type="button"
                      className="print-button"
                    >

                      <span className="print-icon print-icon-box">
                        <svg
                          viewBox="0 0 24 24"
                          width="21"
                          height="21"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M6 9V3h12v6" />
                          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                          <path d="M6 14h12v7H6z" />
                        </svg>
                      </span>

                      <span className="print-button-content">

                        <strong>
                          Print Bean Packing Team Copy
                        </strong>

                        <span>
                          Coffee products only
                        </span>

                      </span>

                    </button>


                    <button
                      type="button"
                      className="print-button"
                    >

                      <span className="print-icon">
                        <svg
                          viewBox="0 0 24 24"
                          width="22"
                          height="22"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 8h14v3H5z" />
                          <path d="M6 11h12v2a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z" />
                          <path d="M8 4c0 1 1 2 2 2" />
                          <path d="M16 4c0 1-1 2-2 2" />
                        </svg>
                      </span>

                      <span className="print-button-content">

                        <strong>
                          Print Bar Staff Copy
                        </strong>

                        <span>
                          Accessories only
                        </span>

                      </span>

                    </button>

                  </div>

                </div>
              </s-section>

            </div>


            {/* RIGHT SIDEBAR */}
            <aside className="right-sidebar">

              <div className="summary-card">

                <div className="summary-title">
                  Summary
                </div>

                <div className="summary-content">

                  <div className="summary-section">

                    <strong>
                      Date &amp; Time Range
                    </strong>

                    <div className="summary-date">
                      {formatDate(fromDate)}
                    </div>

                    <div className="summary-time">
                      {fromTime}
                    </div>

                    <div className="summary-to">
                      to
                    </div>

                    <div className="summary-date">
                      {formatDate(toDate)}
                    </div>

                    <div className="summary-time">
                      {toTime}
                    </div>

                    <div className="timezone">
                      (GMT+8)
                    </div>

                  </div>

                  <div className="summary-divider" />

                  <div className="summary-row">

                    <span>
                      Total Coffee Items
                    </span>

                    <strong>
                      {totalCoffeeItems}
                    </strong>

                  </div>

                  <div className="summary-row">

                    <span>
                      Total Accessory Items
                    </span>

                    <strong>
                      {totalAccessoryItems}
                    </strong>

                  </div>

                  <div className="summary-divider" />

                  <div className="summary-row total">

                    <span>
                      Total Items
                    </span>

                    <strong>
                      {totalItems}
                    </strong>

                  </div>

                </div>

              </div>


              <div className="help-card">

                <div className="help-title">
                  Need help?
                </div>

                <div className="help-text">
                  Select an order date and time range, then generate
                  the product tally to see the items that need to be
                  packed.
                </div>

              </div>

            </aside>

          </div>

        </s-stack>
      </s-page>


      <style>{`

        * {
          box-sizing: border-box;
        }


        /* =========================================
           MAIN LAYOUT
        ========================================= */

        .tally-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 300px;
          gap: 16px;
          width: 100%;
          align-items: stretch;
        }

        .main-content {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }


        /* =========================================
           RIGHT SIDEBAR
        ========================================= */

        .right-sidebar {
          display: flex;
          flex-direction: column;
          gap: 16px;
          height: 100%;
        }

        .summary-card {
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          background: white;
          overflow: hidden;
          min-height: 420px;
        }

        .summary-title {
          padding: 16px;
          font-size: 16px;
          font-weight: 600;
          border-bottom: 1px solid #e5e5e5;
        }

        .summary-content {
          padding: 16px;
          flex: 1;
        }

        .summary-section {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .summary-date {
          font-size: 14px;
          margin-top: 5px;
        }

        .summary-time {
          font-size: 13px;
        }

        .summary-to {
          font-size: 13px;
          margin: 3px 0;
        }

        .timezone {
          color: #6d7175;
          font-size: 12px;
          margin-top: 2px;
        }

        .summary-divider {
          height: 1px;
          background: #e5e5e5;
          margin: 16px 0;
        }

        .summary-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          font-size: 14px;
          margin: 12px 0;
        }

        .summary-row strong {
          white-space: nowrap;
        }

        .summary-row.total {
          font-size: 15px;
        }


        /* =========================================
           NEED HELP
        ========================================= */

        .help-card {
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          background: white;
          padding: 16px;
        }

        .help-title {
          font-size: 15px;
          font-weight: 600;
          margin-bottom: 8px;
        }

        .help-text {
          font-size: 13px;
          line-height: 1.5;
          color: #6d7175;
        }


        /* =========================================
           DATE / TIME
        ========================================= */

        .date-tally-row {
          display: grid;

          grid-template-columns:
            minmax(150px, 1.05fr)
            minmax(150px, 1.05fr)
            30px
            minmax(190px, 1.25fr)
            minmax(190px, 1.35fr);

          gap: 12px;
          width: 100%;
          align-items: stretch;
        }

        .date-tally-box,
        .quick-select-box {
          height: 180px;
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          padding: 14px;
          min-width: 0;
          background: white;
        }

        .date-tally-box input {
          width: 100%;
          height: 38px;
          border: 1px solid #b5b5b5;
          border-radius: 6px;
          padding: 0 10px;
          font-size: 14px;
          background: white;
        }


        /* =========================================
           OR
        ========================================= */

        .or-column {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 0;
        }


        /* =========================================
           QUICK SELECT
        ========================================= */

        .quick-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .quick-grid button {
          height: 34px;
          border: 1px solid #b5b5b5;
          border-radius: 6px;
          background: white;
          font-size: 13px;
          cursor: pointer;
        }

        .quick-grid button:hover {
          background: #f6f6f6;
        }


        /* =========================================
           NOTE
        ========================================= */

        .note-column {
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .info-note {
          border: 1px solid #b6d7f2;
          background: #f0f7ff;
          border-radius: 8px;
          padding: 14px;
          font-size: 13px;
          line-height: 1.5;
          color: #174a70;
          min-height: 110px;
        }

        .info-note strong {
          display: block;
          margin-bottom: 5px;
        }


        /* =========================================
           GENERATE PRODUCT TALLY BUTTON
        ========================================= */

        .generate-area {
          display: flex;
          justify-content: flex-end;
          margin-top: 10px;
        }

        .generate-button {
          height: 36px;
          padding: 0 14px;

          border: 1px solid #1a1a1a;
          border-radius: 6px;

          background: #1a1a1a;
          color: white;

          font-size: 13px;
          font-weight: 600;

          cursor: pointer;
          white-space: nowrap;
          width: 100%;
        }

        .generate-button:hover {
          background: #303030;
        }

        .generate-button:disabled {
          opacity: 0.6;
          cursor: default;
        }


        /* =========================================
           PREVIEW
        ========================================= */

        .preview-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }

        .preview-card {
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          overflow: hidden;
          background: white;
          min-width: 0;
        }

        .preview-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid #e5e5e5;
        }

        .preview-header span {
          color: #6d7175;
          font-size: 13px;
          white-space: nowrap;
        }


        /* =========================================
           TABLE
        ========================================= */

        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        th,
        td {
          padding: 11px 12px;
          text-align: left;
          border-bottom: 1px solid #eeeeee;
          vertical-align: top;
        }

        th {
          font-weight: 600;
          background: #fafafa;
        }

        td:last-child,
        th:last-child {
          text-align: right;
        }

        .preview-total {
          display: flex;
          justify-content: space-between;
          padding: 14px 16px;
          font-size: 13px;
        }


        /* =========================================
           SECTION 4 - GENERATE & PRINT
        ========================================= */

        .generate-print-section {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          width: 100%;
        }

        .generate-print-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          flex: 1;
        }

        .generate-print-heading {
          font-size: 15px;
          font-weight: 600;
          line-height: 1.4;
        }

        .generate-print-description {
          font-size: 13px;
          line-height: 1.4;
          color: #6d7175;
        }


        /* =========================================
           PRINT BUTTONS
        ========================================= */

        .print-actions {
          display: flex;
          gap: 12px;
          margin-left: auto;
          flex-shrink: 0;
        }

        .print-button {
          height: 50px;
          min-width: 228px;

          padding: 0 16px;

          display: flex;
          align-items: center;
          gap: 12px;

          border: 1px solid #c9c9c9;
          border-radius: 6px;

          background: white;

          cursor: pointer;
          text-align: left;
        }

        .print-button:hover {
          background: #f6f6f6;
        }

        .print-icon {
          width: 24px;
          height: 24px;

          flex-shrink: 0;

          display: flex;
          align-items: center;
          justify-content: center;

          font-size: 22px;
        }

        .print-button-content {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .print-button-content strong {
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
        }

        .print-button-content span {
          font-size: 11px;
          color: #6d7175;
          white-space: nowrap;
        }


        /* =========================================
           ERROR
        ========================================= */

        .error-message {
          padding: 12px 14px;
          border: 1px solid #e0b4b4;
          border-radius: 6px;
          background: #fff5f5;
          color: #9b1c1c;
          font-size: 13px;
        }


        /* =========================================
           RESPONSIVE
        ========================================= */

        @media (max-width: 1200px) {

          .tally-layout {
            grid-template-columns: minmax(0, 1fr);
          }

          .right-sidebar {
            height: auto;
          }

          .summary-card {
            min-height: auto;
          }

          .date-tally-row {
            grid-template-columns: 1fr 1fr;
          }

          .or-column {
            display: none;
          }

          .quick-select-box {
            height: 180px;
          }

          .note-column {
            grid-column: 1 / -1;
          }

          .generate-print-section {
            flex-direction: column;
            align-items: stretch;
          }

          .print-actions {
            margin-left: 0;
          }

        }


        @media (max-width: 700px) {

          .date-tally-row,
          .preview-grid {
            grid-template-columns: 1fr;
          }

          .note-column {
            grid-column: auto;
          }

          .print-actions {
            flex-direction: column;
            width: 100%;
          }

          .print-button {
            width: 100%;
            min-width: 0;
          }

          .generate-print-section {
            gap: 16px;
          }

        }

      `}</style>
    </>
  );
}