import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ORDER_STATUS_OPTIONS,
  type OrderStatusValue,
} from "../order-filters";
import {
  createSavedTally,
  deleteSavedTally,
  listSavedTallies,
} from "../tally-saves.server";
import {
  defaultSaveName,
  parseTallySaveParams,
} from "../tally-saves";

function formatTime12h(value: string) {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minutes = minuteText || "00";

  if (Number.isNaN(hour)) return value;

  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;

  return `${hour12}:${minutes} ${period}`;
}

function formatSavedAt(isoDate: string) {
  return new Date(isoDate).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabels(values: OrderStatusValue[]) {
  if (values.includes("all")) return "All";

  return values
    .map(
      (value) =>
        ORDER_STATUS_OPTIONS.find((option) => option.value === value)?.label ||
        value,
    )
    .join(", ");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const saved = await listSavedTallies(session.shop);

  return { saved };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "delete") {
    const id = String(formData.get("id") || "");

    if (!id) {
      return { success: false, error: "Missing saved tally." };
    }

    const deleted = await deleteSavedTally(session.shop, id);

    return deleted
      ? { success: true }
      : { success: false, error: "Saved tally not found." };
  }

  if (intent === "save") {
    const params = parseTallySaveParams(formData);

    if ("error" in params) {
      return { success: false, error: params.error };
    }

    const name =
      String(formData.get("name") || "").trim() || defaultSaveName(params);
    const saved = await createSavedTally(session.shop, name, params);

    return { success: true, savedId: saved.id, name: saved.name };
  }

  return { success: false, error: "Unknown action." };
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export default function HistoryPage() {
  const { saved } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading="History">
      <s-stack gap="large">
        <s-section>
          <s-stack gap="base">
            <s-text>
              Saved tally parameters for this store. Load one to restore the
              exact date range, filters, and excluded orders on the home page.
            </s-text>

            {saved.length === 0 ? (
              <s-text>
                No saved tallies yet. Generate a tally on Home, then use Save.
              </s-text>
            ) : (
              <div className="history-table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Date &amp; time</th>
                      <th>Filters</th>
                      <th>Excluded</th>
                      <th>Saved</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {saved.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.name}</strong>
                        </td>
                        <td>
                          {item.fromDate} {formatTime12h(item.fromTime)}
                          <br />
                          to {item.toDate} {formatTime12h(item.toTime)}
                        </td>
                        <td>
                          Status: {statusLabels(item.orderStatuses)}
                          <br />
                          Channels:{" "}
                          {item.salesChannelIds.includes("all") ||
                          item.salesChannelIds.length === 0
                            ? "All"
                            : `${item.salesChannelIds.length} selected`}
                        </td>
                        <td>
                          {item.excludedOrderIds.length === 0
                            ? "None"
                            : `${item.excludedOrderIds.length} order${
                                item.excludedOrderIds.length === 1 ? "" : "s"
                              }`}
                        </td>
                        <td>{formatSavedAt(item.createdAt)}</td>
                        <td className="history-actions">
                          <s-link href={`/app?savedId=${item.id}`}>Load</s-link>
                          <fetcher.Form
                            method="post"
                            onSubmit={(event) => {
                              if (!window.confirm("Delete this saved tally?")) {
                                event.preventDefault();
                              }
                            }}
                          >
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={item.id} />
                            <button
                              type="submit"
                              className="history-delete"
                              disabled={fetcher.state !== "idle"}
                            >
                              Delete
                            </button>
                          </fetcher.Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </s-stack>
        </s-section>
      </s-stack>

      <style>{`
        .history-table-wrap {
          overflow: auto;
          border: 1px solid #e5e5e5;
          border-radius: 8px;
          background: white;
        }

        .history-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .history-table th,
        .history-table td {
          padding: 12px 14px;
          text-align: left;
          border-bottom: 1px solid #eee;
          vertical-align: top;
        }

        .history-table th {
          background: #f6f6f7;
          font-weight: 600;
          white-space: nowrap;
        }

        .history-table tr:last-child td {
          border-bottom: none;
        }

        .history-actions {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
          white-space: nowrap;
        }

        .history-delete {
          background: none;
          border: none;
          padding: 0;
          color: #d72c0d;
          font-size: 13px;
          cursor: pointer;
          text-decoration: underline;
        }

        .history-delete:disabled {
          opacity: 0.6;
          cursor: default;
        }
      `}</style>
    </s-page>
  );
}
