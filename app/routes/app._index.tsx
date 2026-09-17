import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  filterOrdersBySelection,
  ORDER_STATUS_OPTIONS,
  parseOrderStatuses,
  parseSalesChannelIds,
  type OrderStatusValue,
} from "../order-filters";
import {
  buildOrderRangeQuery,
  buildTallyOrderQuery,
  fetchAllOrders,
  fetchSalesChannels,
  fetchShopTimezone,
  gidNumericId,
  withReadyForPickupFlags,
} from "../orders.server";
import { SHOP_ABN } from "../shipping-label";
import type {
  IncludedOrder,
  ShippingLabelOrder,
  ShopPrintInfo,
  ShopTimezone,
} from "../shipping-label";
import { tallyOrders, type TallyItem } from "../tally.server";
import {
  defaultSaveName,
  parseExcludedOrderIds,
  type TallySaveParams,
} from "../tally-saves";
import { getSavedTally } from "../tally-saves.server";

type TallyResponse = {
  success?: boolean;
  error?: string;
  orderCount?: number;
  orderIds?: string[];
  coffeeProducts?: TallyItem[];
  accessories?: TallyItem[];
  totalCoffeeItems?: number;
  totalAccessoryItems?: number;
  totalItems?: number;
};

type OrdersListResponse = {
  success?: boolean;
  error?: string;
  orders?: IncludedOrder[];
};

type ShippingLabelsResponse = {
  success?: boolean;
  error?: string;
  shop?: ShopPrintInfo | null;
  orders?: ShippingLabelOrder[];
};

function formatYmdInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftYmd(dateStr: string, days: number) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));

  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatTimezoneLabel(shop: Pick<ShopTimezone, "timezoneAbbreviation" | "timezoneOffset">) {
  return `${shop.timezoneAbbreviation} ${shop.timezoneOffset}`;
}

function orderAdminNumericId(gid: string | null | undefined) {
  const match = String(gid || "").match(/(\d+)\s*$/);
  return match?.[1] || "";
}

type FilterOption = {
  value: string;
  label: string;
};

function isEventInside(event: Event, ...elements: Array<EventTarget | null | undefined>) {
  const path = event.composedPath();
  return elements.some((element) => !!element && path.includes(element));
}

function getFixedMenuStyle(
  trigger: HTMLElement | null,
  width: number,
  estimatedHeight: number,
): CSSProperties {
  if (!trigger) {
    return { position: "fixed", zIndex: 100000 };
  }

  const rect = trigger.getBoundingClientRect();
  const padding = 8;
  const spaceBelow = window.innerHeight - rect.bottom - padding;
  const spaceAbove = rect.top - padding;
  const openUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  const left = Math.min(
    Math.max(padding, rect.left),
    Math.max(padding, window.innerWidth - width - padding),
  );

  return {
    position: "fixed",
    left,
    width,
    top: openUp ? undefined : rect.bottom + 4,
    bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
    zIndex: 100000,
  };
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  allLabel,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedSet = new Set(selected);
  const allSelected =
    options.length > 0 && options.every((option) => selectedSet.has(option.value));
  const summary = allSelected || selected.length === 0
    ? allLabel
    : options
        .filter((option) => selectedSet.has(option.value))
        .map((option) => option.label)
        .join(", ");

  useEffect(() => {
    if (!isOpen) return;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const padding = 8;
      const maxHeight = 220;
      const spaceBelow = window.innerHeight - rect.bottom - padding;
      const spaceAbove = rect.top - padding;
      const openUp = spaceBelow < 140 && spaceAbove > spaceBelow;
      const available = openUp ? spaceAbove : spaceBelow;

      setMenuStyle({
        position: "fixed",
        left: rect.left,
        width: Math.max(rect.width, 180),
        top: openUp ? undefined : rect.bottom + 4,
        bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
        maxHeight: Math.min(maxHeight, Math.max(available - 4, 80)),
        zIndex: 10000,
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (isEventInside(event, rootRef.current, menuRef.current)) {
        return;
      }

      setIsOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((item) => item !== value));
      return;
    }

    onChange([...selected, value]);
  };

  const menu =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div className="filter-select-menu" ref={menuRef} style={menuStyle}>
            {options.length === 0 ? (
              <div className="filter-select-empty">No options available</div>
            ) : (
              options.map((option) => (
                <label key={option.value} className="filter-select-option">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(option.value)}
                    onChange={() => toggleValue(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`filter-select${isOpen ? " is-open" : ""}`} ref={rootRef}>
      <s-text>
        <strong>{label}</strong>
      </s-text>

      <button
        type="button"
        className="filter-select-trigger"
        ref={triggerRef}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        <span>{summary}</span>
        <span className="filter-select-caret">▾</span>
      </button>

      {menu}
    </div>
  );
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeTimeValue(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;

  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));

  return `${pad2(hours)}:${pad2(minutes)}`;
}

function parseTime12h(value: string) {
  const normalized = normalizeTimeValue(value);
  const [hourStr, minuteStr] = normalized.split(":");
  const hour24 = Number(hourStr);

  return {
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minutes: minuteStr,
    period: (hour24 >= 12 ? "PM" : "AM") as "AM" | "PM",
  };
}

function toTime24(hour12: number, minutes: string, period: "AM" | "PM") {
  const hour = hour12 % 12;
  const hour24 = period === "PM" ? hour + 12 : hour;

  return `${pad2(hour24)}:${minutes}`;
}

function formatTime12h(value: string) {
  const { hour12, minutes, period } = parseTime12h(value);

  return `${hour12}:${minutes} ${period}`;
}

function DatePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [view, setView] = useState(() => {
    const [year, month] = value.split("-").map(Number);
    return { year: year || new Date().getFullYear(), month: month || 1 };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = value.split("-").map(Number);
  const selectedYear = selected[0];
  const selectedMonth = selected[1];
  const selectedDay = selected[2];
  const daysInMonth = new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(view.year, view.month - 1, 1)).getUTCDay();
  const monthLabel = new Date(Date.UTC(view.year, view.month - 1, 1)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  useEffect(() => {
    if (!isOpen) return;

    const [year, month] = value.split("-").map(Number);
    if (year && month) {
      setView({ year, month });
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- sync calendar to value only when opened

  useEffect(() => {
    if (!isOpen) return;

    const updateMenuPosition = () => {
      setMenuStyle(getFixedMenuStyle(triggerRef.current, 268, 320));
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (isEventInside(event, rootRef.current, menuRef.current)) return;
      setIsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen]);

  const shiftMonth = (delta: number) => {
    setView((current) => {
      const next = new Date(Date.UTC(current.year, current.month - 1 + delta, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    });
  };

  const selectDay = (day: number) => {
    onChange(`${view.year}-${pad2(view.month)}-${pad2(day)}`);
    setIsOpen(false);
  };

  const menu =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="calendar-menu"
            ref={menuRef}
            style={menuStyle}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="calendar-header">
              <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
                ‹
              </button>
              <span>{monthLabel}</span>
              <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
                ›
              </button>
            </div>
            <div className="calendar-weekdays">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {Array.from({ length: firstWeekday }, (_, index) => (
                <span key={`empty-${index}`} />
              ))}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = index + 1;
                const isSelected =
                  selectedYear === view.year &&
                  selectedMonth === view.month &&
                  selectedDay === day;

                return (
                  <button
                    key={day}
                    type="button"
                    className={isSelected ? "is-selected" : ""}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      selectDay(day);
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`datetime-field${isOpen ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="datetime-trigger"
        ref={triggerRef}
        onClick={() => {
          setMenuStyle(getFixedMenuStyle(triggerRef.current, 268, 320));
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
      >
        <span>{value}</span>
        <span className="datetime-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" focusable="false">
            <path
              fill="currentColor"
              d="M6 2a1 1 0 0 1 1 1v1h6V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1Zm8 4H4v2h12V6Zm0 4H4v6h12v-6Z"
            />
          </svg>
        </span>
      </button>
      {menu}
    </div>
  );
}

function TimePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoursRef = useRef<HTMLDivElement>(null);
  const minutesRef = useRef<HTMLDivElement>(null);
  const { hour12, minutes, period } = parseTime12h(value);

  useEffect(() => {
    if (!isOpen) return;

    const updateMenuPosition = () => {
      setMenuStyle(getFixedMenuStyle(triggerRef.current, 210, 220));
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (isEventInside(event, rootRef.current, menuRef.current)) return;
      setIsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const hourButton = hoursRef.current?.querySelector<HTMLButtonElement>(".is-selected");
    const minuteButton = minutesRef.current?.querySelector<HTMLButtonElement>(".is-selected");
    if (hourButton && hoursRef.current) {
      hoursRef.current.scrollTop =
        hourButton.offsetTop - hoursRef.current.clientHeight / 2 + hourButton.clientHeight / 2;
    }
    if (minuteButton && minutesRef.current) {
      minutesRef.current.scrollTop =
        minuteButton.offsetTop -
        minutesRef.current.clientHeight / 2 +
        minuteButton.clientHeight / 2;
    }
  }, [isOpen, hour12, minutes]);

  const choose = (nextHour: number, nextMinutes: string, nextPeriod: "AM" | "PM", close = false) => {
    onChange(toTime24(nextHour, nextMinutes, nextPeriod));
    if (close) setIsOpen(false);
  };

  const menu =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="time-menu"
            ref={menuRef}
            style={menuStyle}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="time-column" ref={hoursRef}>
              {Array.from({ length: 12 }, (_, index) => {
                const nextHour = index + 1;
                return (
                  <button
                    key={nextHour}
                    type="button"
                    className={nextHour === hour12 ? "is-selected" : ""}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      choose(nextHour, minutes, period);
                    }}
                  >
                    {nextHour}
                  </button>
                );
              })}
            </div>
            <div className="time-column" ref={minutesRef}>
              {Array.from({ length: 60 }, (_, minute) => {
                const next = pad2(minute);
                return (
                  <button
                    key={next}
                    type="button"
                    className={next === minutes ? "is-selected" : ""}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      choose(hour12, next, period);
                    }}
                  >
                    {next}
                  </button>
                );
              })}
            </div>
            <div className="time-column time-period">
              {(["AM", "PM"] as const).map((nextPeriod) => (
                <button
                  key={nextPeriod}
                  type="button"
                  className={nextPeriod === period ? "is-selected" : ""}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    choose(hour12, minutes, nextPeriod, true);
                  }}
                >
                  {nextPeriod}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`datetime-field${isOpen ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="datetime-trigger"
        ref={triggerRef}
        onClick={() => {
          setMenuStyle(getFixedMenuStyle(triggerRef.current, 210, 220));
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
      >
        <span>{formatTime12h(value)}</span>
        <span className="datetime-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" focusable="false">
            <path
              fill="currentColor"
              d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm.75 2v3.19l2.28 2.28a.75.75 0 1 1-1.06 1.06l-2.5-2.5A.75.75 0 0 1 9.25 9.5V6A.75.75 0 0 1 10.75 6Z"
            />
          </svg>
        </span>
      </button>
      {menu}
    </div>
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrintNow(timeZone: string) {
  return new Date().toLocaleDateString("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function thankYouMarkup(text: string) {
  return text
    .split("\n")
    .map((line) => escapeHtml(line))
    .join("<br>");
}

function shippingSlipInnerHtml(
  shop: ShopPrintInfo,
  order: ShippingLabelOrder,
  printedAt: string,
) {
  const itemRows = order.items
    .map(
      (item) => `
        <tr>
          <td class="image-cell">
            ${
              item.imageUrl
                ? `<div class="item-image"><img src="${escapeHtml(item.imageUrl)}" alt="" /></div>`
                : ""
            }
          </td>
          <td class="sku-cell">${escapeHtml(item.sku)}x</td>
          <td class="qty-cell">${escapeHtml(String(item.quantity))} x</td>
          <td class="item-cell"><b>${escapeHtml(item.name)}</b></td>
        </tr>`,
    )
    .join("");

  const giftRow = order.giftWrapped
    ? `<tr>
        <td class="image-cell"></td>
        <td class="sku-cell">Yes</td>
        <td class="qty-cell"></td>
        <td class="item-cell"><b>Gift Wrapped</b></td>
      </tr>`
    : "";

  const thankYouBlock = order.thankYouHtml
    ? `<p class="thanks-under"><b>${thankYouMarkup(order.thankYouHtml)}</b></p>`
    : "";

  const noteBlock = order.note
    ? `<p class="thanks-under">${escapeHtml(order.note)}</p>`
    : "";

  const shippingDetails = order.hasShippingAddress
    ? `
      <h3>Shipping Details</h3>
      <div class="box">
        <strong>${escapeHtml(order.shippingName)}</strong><br>
        ${order.shippingPhone ? `${escapeHtml(order.shippingPhone)}<br>` : ""}
        ${order.shippingCompany ? `${escapeHtml(order.shippingCompany)}<br>` : ""}
        ${order.shippingStreet.map((line) => `${escapeHtml(line)}<br>`).join("")}
        ${order.shippingCityLine ? `${escapeHtml(order.shippingCityLine)}<br>` : ""}
        ${order.shippingCountry ? `${escapeHtml(order.shippingCountry)}<br>` : ""}
        <br>
        <strong>Shipping Method:</strong> ${escapeHtml(order.shippingMethod)}
      </div>`
    : `
      <h3>Shipping Details</h3>
      <div class="box">
        <strong>Shipping Method:</strong> ${escapeHtml(order.shippingMethod)}
      </div>`;

  return `
    <p class="slip-date">
      ${escapeHtml(printedAt)}<br>
      Order / Invoice No. ${escapeHtml(order.name)}
    </p>
    <div class="slip-shop">
      <strong class="shop-name">${escapeHtml(shop.name)}</strong><br><br>
      ${shop.address1 ? `${escapeHtml(shop.address1)}<br>` : ""}
      ${shop.cityLine ? `${escapeHtml(shop.cityLine)}<br>` : ""}
      ${shop.country ? `${escapeHtml(shop.country)}<br>` : ""}
      ABN: ${SHOP_ABN}
    </div>
    <hr>
    <h3>Item Details</h3>
    <table class="item-table">
      <colgroup>
        <col class="col-image" />
        <col class="col-sku" />
        <col class="col-qty" />
        <col class="col-item" />
      </colgroup>
      <thead>
        <tr>
          <th class="image-cell"></th>
          <th class="sku-cell">item sku</th>
          <th class="qty-cell">Quantity</th>
          <th class="item-cell">Item</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
        ${giftRow}
      </tbody>
    </table>
    ${thankYouBlock}
    ${noteBlock}
    <h3>Customer Details</h3>
    <div class="box">
      ${order.customerName ? `${escapeHtml(order.customerName)}<br>` : ""}
      ${order.customerPhone ? `${escapeHtml(order.customerPhone)}<br>` : ""}
      ${order.customerEmail ? `${escapeHtml(order.customerEmail)}<br>` : ""}
      ${order.customerDefaultAddress ? escapeHtml(order.customerDefaultAddress) : ""}
    </div>
    ${shippingDetails}
    <p class="footer">
      If you have any questions, please send an email to <u>${escapeHtml(shop.email)}</u>
    </p>
  `;
}

function printHtmlDocument(html: string) {
  const iframe = document.createElement("iframe");
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));

  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const cleanup = () => {
    URL.revokeObjectURL(url);
    iframe.remove();
  };

  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    window.setTimeout(cleanup, 1000);
  };

  iframe.src = url;
}

function buildShippingLabelPrintHtml(
  shop: ShopPrintInfo,
  orders: ShippingLabelOrder[],
  timeZone: string,
) {
  const printedAt = formatPrintNow(timeZone);
  const slips = orders
    .map(
      (order) =>
        `<article class="slip">${shippingSlipInnerHtml(shop, order, printedAt)}</article>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Shipping labels</title>
    <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: #111;
        font-family: Inter, Helvetica, Arial, sans-serif;
        font-size: 14px;
        line-height: 1.4;
      }
      .slip {
        max-width: 760px;
        margin: 0 auto 24px;
        padding: 24px 28px 16px;
        page-break-after: always;
      }
      .slip:last-child { page-break-after: auto; }
      .slip-date {
        float: right;
        text-align: right;
        margin: 0;
      }
      .slip-shop { margin: 0 0 1.5em 0; }
      .shop-name { font-size: 2em; }
      hr {
        clear: both;
        border: none;
        border-top: 2px solid #111;
        margin: 0 0 1.2em;
      }
      h3 { margin: 0 0 1em; font-size: 16px; }
      .item-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        margin: 0 0 1.5em;
      }
      .col-image { width: 120px; }
      .col-sku { width: 28%; }
      .col-qty { width: 18%; }
      .col-item { width: auto; }
      .item-table th,
      .item-table td {
        border: none;
        border-top: 1px solid #111;
        border-bottom: 1px solid #111;
        padding: 16px 12px;
        vertical-align: middle;
        text-align: left;
      }
      .item-table th:first-child,
      .item-table td:first-child {
        border-left: 1px solid #111;
      }
      .item-table th:last-child,
      .item-table td:last-child {
        border-right: 1px solid #111;
      }
      .item-table th {
        font-weight: 700;
      }
      .item-table td.image-cell {
        padding: 12px;
      }
      .item-image {
        width: 100px;
        height: 100px;
      }
      .item-image img {
        width: 100px;
        height: 100px;
        object-fit: contain;
        display: block;
      }
      .thanks-under {
        margin: 0 0 1.5em;
        text-align: left;
      }
      .box {
        margin: 0 0 1em;
        padding: 1em;
        border: 1px solid #111;
        min-height: 72px;
      }
      .footer { margin: 1em 0 0; }
      @media print {
        .slip { margin: 0; padding: 12px 0; }
      }
    </style>
  </head>
  <body>${slips}</body>
</html>`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const savedId = url.searchParams.get("savedId");
  const [shop, salesChannels, loadedSaved] = await Promise.all([
    fetchShopTimezone(admin),
    fetchSalesChannels(admin),
    savedId ? getSavedTally(session.shop, savedId) : Promise.resolve(null),
  ]);

  return {
    ...shop,
    salesChannels,
    loadedSaved,
    loadedSavedError: savedId && !loadedSaved ? "Saved tally not found." : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

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
    const shop = await fetchShopTimezone(admin);
    const salesChannels = await fetchSalesChannels(admin);
    const statuses = parseOrderStatuses(formData.get("orderStatuses"));
    const selectedChannelIds = parseSalesChannelIds(
      formData.get("salesChannelIds"),
    );
    const orderQuery = buildTallyOrderQuery(
      fromDate,
      fromTime,
      toDate,
      toTime,
      shop.ianaTimezone,
      statuses,
      salesChannels,
      selectedChannelIds,
    );

    const excludedOrderIds = parseExcludedOrderIds(
      formData.get("excludedOrderIds"),
    );
    const rangeQuery = buildOrderRangeQuery(
      fromDate,
      fromTime,
      toDate,
      toTime,
      shop.ianaTimezone,
    );
    const orders = filterOrdersBySelection(
      await withReadyForPickupFlags(
        admin,
        session,
        await fetchAllOrders(admin, orderQuery),
        rangeQuery,
      ),
      statuses,
      salesChannels,
      selectedChannelIds,
    );
    const ordersToTally = orders.filter(
      (order) => !excludedOrderIds.has(order.id),
    );
    const orderIds = ordersToTally
      .map((order) => gidNumericId(order.id))
      .filter(Boolean);
    const { coffeeProducts, accessories } = tallyOrders(ordersToTally);

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
      orderCount: ordersToTally.length,
      orderIds,
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
  const shop = useLoaderData<typeof loader>();
  const fetcher = useFetcher<TallyResponse>();
  const ordersFetcher = useFetcher<OrdersListResponse>();
  const labelsFetcher = useFetcher<ShippingLabelsResponse>();
  const saveFetcher = useFetcher<{
    success?: boolean;
    error?: string;
    savedId?: string;
    name?: string;
  }>();
  const salesChannels = shop.salesChannels ?? [];
  const loadedSaved = shop.loadedSaved;

  const ianaTimezone = shop.ianaTimezone || "UTC";
  const timezoneLabel = formatTimezoneLabel(shop);
  const storeToday = formatYmdInTimeZone(new Date(), ianaTimezone);

  const [fromDate, setFromDate] = useState(loadedSaved?.fromDate ?? storeToday);
  const [fromTime, setFromTime] = useState(loadedSaved?.fromTime ?? "00:00");
  const [toDate, setToDate] = useState(loadedSaved?.toDate ?? storeToday);
  const [toTime, setToTime] = useState(loadedSaved?.toTime ?? "23:59");
  const [isOrdersModalOpen, setIsOrdersModalOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [excludedOrderIds, setExcludedOrderIds] = useState<Set<string>>(
    () => new Set(loadedSaved?.excludedOrderIds ?? []),
  );
  const [orderStatuses, setOrderStatuses] = useState<OrderStatusValue[]>(
    loadedSaved?.orderStatuses ?? ["open"],
  );
  const [salesChannelIds, setSalesChannelIds] = useState<string[]>(
    loadedSaved?.salesChannelIds ?? ["all"],
  );
  const skipExcludeResetRef = useRef(Boolean(loadedSaved));
  const appliedSavedIdRef = useRef<string | null>(null);

  const coffeeProducts = fetcher.data?.coffeeProducts ?? [];
  const accessories = fetcher.data?.accessories ?? [];

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

  const getQuickSelectRange = (type: string) => {
    const today = formatYmdInTimeZone(new Date(), ianaTimezone);

    if (type === "today") {
      return { fromDate: today, toDate: today, fromTime: "00:00", toTime: "23:59" };
    }

    if (type === "yesterday") {
      const yesterday = shiftYmd(today, -1);

      return {
        fromDate: yesterday,
        toDate: yesterday,
        fromTime: "00:00",
        toTime: "23:59",
      };
    }

    if (type === "last7") {
      return {
        fromDate: shiftYmd(today, -6),
        toDate: today,
        fromTime: "00:00",
        toTime: "23:59",
      };
    }

    if (type === "last30") {
      return {
        fromDate: shiftYmd(today, -29),
        toDate: today,
        fromTime: "00:00",
        toTime: "23:59",
      };
    }

    if (type === "thisMonth") {
      return {
        fromDate: `${today.slice(0, 8)}01`,
        toDate: today,
        fromTime: "00:00",
        toTime: "23:59",
      };
    }

    return null;
  };

  const handleQuickSelect = (type: string) => {
    const range = getQuickSelectRange(type);

    if (!range) return;

    setFromDate(range.fromDate);
    setFromTime(range.fromTime);
    setToDate(range.toDate);
    setToTime(range.toTime);
  };

  useEffect(() => {
    if (skipExcludeResetRef.current) {
      skipExcludeResetRef.current = false;
      return;
    }

    setExcludedOrderIds(new Set());
  }, [fromDate, fromTime, toDate, toTime, orderStatuses, salesChannelIds]);

  const activeQuickSelect = (
    ["today", "yesterday", "last7", "last30", "thisMonth"] as const
  ).find((type) => {
    const range = getQuickSelectRange(type);

    return (
      range &&
      range.fromDate === fromDate &&
      range.fromTime === fromTime &&
      range.toDate === toDate &&
      range.toTime === toTime
    );
  });

  const currentParams = (): TallySaveParams => ({
    fromDate,
    fromTime,
    toDate,
    toTime,
    orderStatuses,
    salesChannelIds,
    excludedOrderIds: [...excludedOrderIds],
  });

  const generateTally = (overrides?: TallySaveParams) => {
    const params = overrides ?? currentParams();

    fetcher.submit(
      {
        fromDate: params.fromDate,
        fromTime: params.fromTime,
        toDate: params.toDate,
        toTime: params.toTime,
        orderStatuses: JSON.stringify(params.orderStatuses),
        salesChannelIds: JSON.stringify(params.salesChannelIds),
        excludedOrderIds: JSON.stringify(params.excludedOrderIds),
      },
      {
        method: "POST",
      },
    );
  };

  const applySavedTally = (saved: TallySaveParams) => {
    skipExcludeResetRef.current = true;
    setFromDate(saved.fromDate);
    setFromTime(saved.fromTime);
    setToDate(saved.toDate);
    setToTime(saved.toTime);
    setOrderStatuses(saved.orderStatuses);
    setSalesChannelIds(
      saved.salesChannelIds.length > 0 ? saved.salesChannelIds : ["all"],
    );
    setExcludedOrderIds(new Set(saved.excludedOrderIds));
    generateTally({
      ...saved,
      salesChannelIds:
        saved.salesChannelIds.length > 0 ? saved.salesChannelIds : ["all"],
    });
  };

  useEffect(() => {
    if (!loadedSaved) return;
    if (appliedSavedIdRef.current === loadedSaved.id) return;

    appliedSavedIdRef.current = loadedSaved.id;
    applySavedTally(loadedSaved);
  }, [loadedSaved]);

  useEffect(() => {
    if (!saveFetcher.data?.success) return;

    setIsSaveModalOpen(false);
  }, [saveFetcher.data]);

  const openSaveModal = () => {
    if (!canSaveTally) return;

    setSaveName(defaultSaveName(currentParams()));
    setIsSaveModalOpen(true);
  };

  const saveCurrentTally = () => {
    const params = currentParams();

    saveFetcher.submit(
      {
        intent: "save",
        name: saveName,
        fromDate: params.fromDate,
        fromTime: params.fromTime,
        toDate: params.toDate,
        toTime: params.toTime,
        orderStatuses: JSON.stringify(params.orderStatuses),
        salesChannelIds: JSON.stringify(params.salesChannelIds),
        excludedOrderIds: JSON.stringify(params.excludedOrderIds),
      },
      {
        method: "POST",
        action: "/app/history",
      },
    );
  };

  const openIncludedOrders = () => {
    setIsOrdersModalOpen(true);

    const params = new URLSearchParams({
      fromDate,
      fromTime,
      toDate,
      toTime,
      orderStatuses: JSON.stringify(orderStatuses),
      salesChannelIds: JSON.stringify(salesChannelIds),
    });

    ordersFetcher.load(`/app/included-orders?${params.toString()}`);
  };

  const formatOrderDateTime = (isoDate: string) => {
    return new Date(isoDate).toLocaleString("en-US", {
      timeZone: ianaTimezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  const isGenerating = fetcher.state !== "idle";
  const canSaveTally = Boolean(fetcher.data?.success) && !isGenerating;
  const isLoadingOrders = ordersFetcher.state !== "idle";
  const isLoadingLabels = labelsFetcher.state !== "idle";
  const includedOrders = ordersFetcher.data?.orders ?? [];
  const shippingLabelShop = labelsFetcher.data?.shop ?? null;
  const shippingLabelOrders = labelsFetcher.data?.orders ?? [];
  const selectedOrderCount = includedOrders.filter(
    (order) => !excludedOrderIds.has(order.id),
  ).length;
  const allVisibleSelected =
    includedOrders.length > 0 && selectedOrderCount === includedOrders.length;
  const someVisibleSelected = selectedOrderCount > 0 && !allVisibleSelected;

  const toggleOrderIncluded = (orderId: string) => {
    setExcludedOrderIds((current) => {
      const next = new Set(current);

      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }

      return next;
    });
  };

  const toggleAllVisibleOrders = () => {
    setExcludedOrderIds((current) => {
      const next = new Set(current);

      if (allVisibleSelected) {
        for (const order of includedOrders) {
          next.add(order.id);
        }
      } else {
        for (const order of includedOrders) {
          next.delete(order.id);
        }
      }

      return next;
    });
  };

  const csvCell = (value: string | number) => {
    const text = String(value ?? "");

    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
  };

  const downloadCsv = (filename: string, headers: string[], rows: Array<Array<string | number>>) => {
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map((row) => row.map(csvCell).join(",")),
    ];
    const csv = `\uFEFF${lines.join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const rangeLabel = `${fromDate}_${fromTime.replace(":", "")}-to-${toDate}_${toTime.replace(":", "")}`;

  const downloadCoffeeCsv = () => {
    if (coffeeProducts.length === 0) return;

    downloadCsv(
      `bean-packing-team-${rangeLabel}.csv`,
      ["SKU", "Product Name", "Variant", "Sales Channel", "Quantity"],
      [
        ...coffeeProducts.map((item) => [
          item.sku || "",
          item.name,
          item.variant || "",
          item.salesChannel || "",
          item.quantity,
        ]),
        ["", "", "", "Total Coffee Items", totalCoffeeItems],
      ],
    );
  };

  const downloadAccessoriesCsv = () => {
    if (accessories.length === 0) return;

    downloadCsv(
      `bar-staff-${rangeLabel}.csv`,
      ["SKU", "Item Name", "Sales Channel", "Quantity"],
      [
        ...accessories.map((item) => [
          item.sku || "",
          item.variant ? `${item.name} – ${item.variant}` : item.name,
          item.salesChannel || "",
          item.quantity,
        ]),
        ["", "", "Total Accessory Items", totalAccessoryItems],
      ],
    );
  };

  const printShippingLabels = () => {
    setIsPrintModalOpen(true);

    const params = new URLSearchParams({
      fromDate,
      fromTime,
      toDate,
      toTime,
      orderStatuses: JSON.stringify(orderStatuses),
      salesChannelIds: JSON.stringify(salesChannelIds),
      excludedOrderIds: JSON.stringify([...excludedOrderIds]),
    });

    labelsFetcher.load(`/app/shipping-labels?${params.toString()}`);
  };

  const confirmPrintShippingLabels = () => {
    const shopInfo = labelsFetcher.data?.shop;
    const labelOrders = labelsFetcher.data?.orders ?? [];

    if (!shopInfo || labelOrders.length === 0) return;

    printHtmlDocument(
      buildShippingLabelPrintHtml(shopInfo, labelOrders, ianaTimezone),
    );
  };

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
                      Pull orders based on the order date and time shown in
                      Shopify admin, in the store timezone ({timezoneLabel}).
                    </s-text>
                  </s-stack>

                  <div className="date-tally-row">

                    <div className="date-tally-box">
                      <div className="date-tally-fields">
                        <s-text>
                          <strong>From</strong>
                        </s-text>

                        <DatePickerField
                          value={fromDate}
                          onChange={setFromDate}
                        />

                        <TimePickerField
                          value={fromTime}
                          onChange={setFromTime}
                        />
                      </div>
                    </div>

                    <div className="date-tally-box">
                      <div className="date-tally-fields">
                        <s-text>
                          <strong>To</strong>
                        </s-text>

                        <DatePickerField
                          value={toDate}
                          onChange={setToDate}
                        />

                        <TimePickerField
                          value={toTime}
                          onChange={setToTime}
                        />
                      </div>
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
                            className={
                              activeQuickSelect === "today" ? "is-active" : ""
                            }
                            onClick={() => handleQuickSelect("today")}
                          >
                            Today
                          </button>

                          <button
                            type="button"
                            className={
                              activeQuickSelect === "yesterday"
                                ? "is-active"
                                : ""
                            }
                            onClick={() => handleQuickSelect("yesterday")}
                          >
                            Yesterday
                          </button>

                          <button
                            type="button"
                            className={
                              activeQuickSelect === "last7" ? "is-active" : ""
                            }
                            onClick={() => handleQuickSelect("last7")}
                          >
                            Last 7 Days
                          </button>

                          <button
                            type="button"
                            className={
                              activeQuickSelect === "last30" ? "is-active" : ""
                            }
                            onClick={() => handleQuickSelect("last30")}
                          >
                            Last 30 Days
                          </button>

                          <button
                            type="button"
                            className={
                              activeQuickSelect === "thisMonth"
                                ? "is-active"
                                : ""
                            }
                            onClick={() => handleQuickSelect("thisMonth")}
                          >
                            This Month
                          </button>

                        </div>

                      </s-stack>
                    </div>

                    <div className="note-column">

                      <div className="info-note">
                        <strong>Note:</strong>{" "}
                        The tally will include orders created from{" "}
                        <b>
                          {fromDate} {formatTime12h(fromTime)}
                        </b>{" "}
                        to{" "}
                        <b>
                          {toDate} {formatTime12h(toTime)}
                        </b>.
                      </div>

                      <div className="generate-area">

                        <div className="tally-filters">
                          <MultiSelectFilter
                            label="Order status"
                            allLabel="All"
                            options={ORDER_STATUS_OPTIONS.map((option) => ({
                              value: option.value,
                              label: option.label,
                            }))}
                            selected={orderStatuses}
                            onChange={(next) => {
                              const values = next.filter((value): value is OrderStatusValue =>
                                ORDER_STATUS_OPTIONS.some((option) => option.value === value),
                              );

                              if (values.includes("all") && !orderStatuses.includes("all")) {
                                setOrderStatuses(["all"]);
                                return;
                              }

                              const withoutAll = values.filter((value) => value !== "all");
                              setOrderStatuses(
                                withoutAll.length > 0 ? withoutAll : ["open"],
                              );
                            }}
                          />

                          <MultiSelectFilter
                            label="Sales channel"
                            allLabel="All"
                            options={[
                              { value: "all", label: "All" },
                              ...salesChannels.map((channel) => ({
                                value: channel.id,
                                label: channel.name,
                              })),
                            ]}
                            selected={salesChannelIds}
                            onChange={(next) => {
                              if (next.includes("all") && !salesChannelIds.includes("all")) {
                                setSalesChannelIds(["all"]);
                                return;
                              }

                              const withoutAll = next.filter((value) => value !== "all");
                              setSalesChannelIds(
                                withoutAll.length > 0 ? withoutAll : ["all"],
                              );
                            }}
                          />
                        </div>

                        <div className="generate-actions">
                          <button
                            type="button"
                            className="generate-button"
                            onClick={() => generateTally()}
                            disabled={isGenerating}
                          >
                            {isGenerating
                              ? "Generating..."
                              : "Generate Product Tally"}
                          </button>

                          <button
                            type="button"
                            className="save-button"
                            onClick={openSaveModal}
                            disabled={!canSaveTally || saveFetcher.state !== "idle"}
                          >
                            Save
                          </button>
                        </div>

                        {saveFetcher.data?.success && (
                          <div className="save-status">
                            Saved “{saveFetcher.data.name}”.{" "}
                            <s-link href="/app/history">View history</s-link>
                          </div>
                        )}

                        {saveFetcher.data?.error && (
                          <div className="error-message">
                            {saveFetcher.data.error}
                          </div>
                        )}

                        {shop.loadedSavedError && (
                          <div className="error-message">
                            {shop.loadedSavedError}
                          </div>
                        )}

                        <button
                          type="button"
                          className="included-orders-link"
                          onClick={openIncludedOrders}
                          disabled={isLoadingOrders}
                        >
                          {isLoadingOrders
                            ? "Loading included orders..."
                            : "View included orders"}
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

                      <div className="preview-table-wrap">
                        <table>

                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Product Name</th>
                              <th>Variant</th>
                              <th>Sales Channel</th>
                              <th>Quantity</th>
                            </tr>
                          </thead>

                          <tbody>
                            {isGenerating ? (
                              <tr>
                                <td colSpan={5} className="preview-empty">
                                  Loading coffee products from orders...
                                </td>
                              </tr>
                            ) : coffeeProducts.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="preview-empty">
                                  {fetcher.data?.success
                                    ? "No coffee products in this order range."
                                    : "Generate a product tally to preview coffee items."}
                                </td>
                              </tr>
                            ) : (
                              coffeeProducts.map((item) => (
                                <tr
                                  key={`${item.sku}-${item.name}-${item.variant}-${item.salesChannel}`}
                                >
                                  <td>{item.sku || "—"}</td>
                                  <td>{item.name}</td>
                                  <td>{item.variant}</td>
                                  <td>{item.salesChannel}</td>
                                  <td>{item.quantity}</td>
                                </tr>
                              ))
                            )}
                          </tbody>

                        </table>
                      </div>

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

                      <div className="preview-table-wrap">
                        <table>

                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Item Name</th>
                              <th>Sales Channel</th>
                              <th>Quantity</th>
                            </tr>
                          </thead>

                          <tbody>

                            {isGenerating ? (
                              <tr>
                                <td colSpan={4} className="preview-empty">
                                  Loading accessories from orders...
                                </td>
                              </tr>
                            ) : accessories.length === 0 ? (
                              <tr>
                                <td colSpan={4} className="preview-empty">
                                  {fetcher.data?.success
                                    ? "No accessories in this order range."
                                    : "Generate a product tally to preview accessories."}
                                </td>
                              </tr>
                            ) : (
                              accessories.map((item) => (
                                <tr
                                  key={`${item.sku}-${item.name}-${item.variant}-${item.salesChannel}`}
                                >
                                  <td>{item.sku || "—"}</td>
                                  <td>
                                    {item.name}
                                    {item.variant ? ` – ${item.variant}` : ""}
                                  </td>
                                  <td>{item.salesChannel}</td>
                                  <td>{item.quantity}</td>
                                </tr>
                              ))
                            )}

                          </tbody>

                        </table>
                      </div>

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
                      Download CSV packing sheets, or print shipping labels for
                      the orders in this tally.
                    </div>

                  </div>

                  <div className="print-actions">

                    <button
                      type="button"
                      className="print-button"
                      onClick={downloadCoffeeCsv}
                      disabled={isGenerating || coffeeProducts.length === 0}
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
                      onClick={downloadAccessoriesCsv}
                      disabled={isGenerating || accessories.length === 0}
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


                    <button
                      type="button"
                      className="print-button"
                      onClick={printShippingLabels}
                      disabled={
                        isGenerating ||
                        isLoadingLabels ||
                        (fetcher.data?.orderIds ?? []).length === 0
                      }
                    >

                      <span className="print-icon">
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
                          <path d="M7 7h10v13H7z" />
                          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                          <path d="M9 12h6" />
                          <path d="M9 16h4" />
                        </svg>
                      </span>

                      <span className="print-button-content">

                        <strong>
                          Print Shipping Label
                        </strong>

                        <span>
                          Packing slips for included orders
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
                      {formatTime12h(fromTime)}
                    </div>

                    <div className="summary-to">
                      to
                    </div>

                    <div className="summary-date">
                      {formatDate(toDate)}
                    </div>

                    <div className="summary-time">
                      {formatTime12h(toTime)}
                    </div>

                    <div className="timezone">
                      ({timezoneLabel})
                    </div>

                  </div>

                  <div className="summary-divider" />

                  <div className="summary-row">

                    <span>
                      Total Orders
                    </span>

                    <strong>
                      {fetcher.data?.orderCount ?? 0}
                    </strong>

                  </div>

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

      {isSaveModalOpen && (
        <div
          className="included-orders-overlay"
          onClick={() => setIsSaveModalOpen(false)}
        >
          <div
            className="save-popup"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="included-orders-popup-header">
              <strong>Save tally parameters</strong>
              <button
                type="button"
                className="included-orders-close"
                onClick={() => setIsSaveModalOpen(false)}
              >
                Close
              </button>
            </div>
            <p className="save-popup-copy">
              This stores the current date range, order status, sales channel,
              and excluded orders so you can load them later from History.
            </p>
            <label className="save-name-label" htmlFor="save-tally-name">
              Name
            </label>
            <input
              id="save-tally-name"
              className="save-name-input"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder="e.g. Today open orders"
            />
            <div className="save-popup-actions">
              <button
                type="button"
                className="save-button"
                onClick={saveCurrentTally}
                disabled={saveFetcher.state !== "idle"}
              >
                {saveFetcher.state !== "idle" ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isOrdersModalOpen && (
        <div
          className="included-orders-overlay"
          onClick={() => setIsOrdersModalOpen(false)}
        >
          <div
            className="included-orders-popup"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="included-orders-popup-header">
              <strong>
                Included orders
                {!isLoadingOrders
                  ? ` (${includedOrders.length} Orders)`
                  : ""}
              </strong>
              <button
                type="button"
                className="included-orders-close"
                onClick={() => setIsOrdersModalOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="included-orders-popup-range">
              <p>
                Orders created from {fromDate} {formatTime12h(fromTime)} to {toDate}{" "}
                {formatTime12h(toTime)} ({timezoneLabel})
              </p>
              {!isLoadingOrders && includedOrders.length > 0 && (
                <p>
                  {selectedOrderCount} of {includedOrders.length} selected.
                </p>
              )}
              <p>Uncheck an order to exclude it from the product tally.</p>
            </div>

            {isLoadingOrders && (
              <p>Loading orders in this date and time range...</p>
            )}

            {!isLoadingOrders && ordersFetcher.data?.error && (
              <p className="included-orders-error">
                {ordersFetcher.data.error}
              </p>
            )}

            {!isLoadingOrders &&
              !ordersFetcher.data?.error &&
              includedOrders.length === 0 &&
              ordersFetcher.data && (
                <p>No orders were found in this date and time range.</p>
              )}

            {!isLoadingOrders && includedOrders.length > 0 && (
              <div className="included-orders-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="included-orders-check">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          ref={(element) => {
                            if (element) {
                              element.indeterminate = someVisibleSelected;
                            }
                          }}
                          onChange={toggleAllVisibleOrders}
                          aria-label="Select all orders"
                        />
                      </th>
                      <th>Order</th>
                      <th>Order date</th>
                      <th>Order status</th>
                      <th>Sales channel</th>
                      <th>Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {includedOrders.map((order) => {
                      const isIncluded = !excludedOrderIds.has(order.id);
                      const orderAdminId = orderAdminNumericId(order.id);

                      return (
                        <tr
                          key={order.id}
                          className={isIncluded ? undefined : "is-excluded"}
                        >
                          <td className="included-orders-check">
                            <input
                              type="checkbox"
                              checked={isIncluded}
                              onChange={() => toggleOrderIncluded(order.id)}
                              aria-label={`Include ${order.name}`}
                            />
                          </td>
                          <td>
                            {orderAdminId ? (
                              <a
                                className="included-order-admin-link"
                                href={`shopify://admin/orders/${orderAdminId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {order.name}
                              </a>
                            ) : (
                              order.name
                            )}
                          </td>
                          <td>{formatOrderDateTime(order.processedAt)}</td>
                          <td>{order.orderStatus}</td>
                          <td>{order.salesChannel}</td>
                          <td>{order.itemCount}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {isPrintModalOpen && (
        <div
          className="included-orders-overlay print-labels-overlay"
          onClick={() => setIsPrintModalOpen(false)}
        >
          <div
            className="print-labels-popup"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="print-labels-body">
              <div className="print-labels-preview">
                {isLoadingLabels && (
                  <p className="print-labels-status">
                    Loading shipping labels...
                  </p>
                )}

                {!isLoadingLabels && labelsFetcher.data?.error && (
                  <p className="included-orders-error">
                    {labelsFetcher.data.error}
                  </p>
                )}

                {!isLoadingLabels &&
                  !labelsFetcher.data?.error &&
                  shippingLabelOrders.length === 0 &&
                  labelsFetcher.data && (
                    <p className="print-labels-status">
                      No included orders were found to print.
                    </p>
                  )}

                {!isLoadingLabels &&
                  shippingLabelShop &&
                  shippingLabelOrders.map((order) => (
                    <article
                      key={order.id}
                      className="shipping-slip"
                      dangerouslySetInnerHTML={{
                        __html: shippingSlipInnerHtml(
                          shippingLabelShop,
                          order,
                          formatPrintNow(ianaTimezone),
                        ),
                      }}
                    />
                  ))}
              </div>

              <aside className="print-labels-sidebar">
                <div className="print-labels-sidebar-title">Documents</div>
                <label className="print-labels-option">
                  <input type="checkbox" checked readOnly />
                  <span>Shipping label</span>
                </label>
              </aside>
            </div>

            <div className="print-labels-footer">
              <button
                type="button"
                className="print-labels-cancel"
                onClick={() => setIsPrintModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="print-labels-continue"
                onClick={confirmPrintShippingLabels}
                disabled={
                  isLoadingLabels ||
                  !shippingLabelShop ||
                  shippingLabelOrders.length === 0
                }
              >
                Continue to print
              </button>
            </div>
          </div>
        </div>
      )}


      <style>{`

        * {
          box-sizing: border-box;
          font-family: Inter, -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        }

        :root {
          --p-font-family-sans: Inter, -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
          --p-font-sans: Inter, -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
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
          align-items: start;
          overflow: visible;
        }

        .date-tally-box,
        .quick-select-box {
          min-height: 180px;
          height: auto;
          overflow: visible;
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          padding: 14px;
          min-width: 0;
          background: white;
        }

        .date-tally-fields {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .datetime-field {
          position: relative;
          z-index: 1;
        }

        .datetime-field.is-open {
          z-index: 30;
        }

        .date-tally-box input,
        .datetime-trigger {
          width: 100%;
          height: 38px;
          border: 1px solid #b5b5b5;
          border-radius: 6px;
          padding: 0 10px;
          font-size: 14px;
          background: white;
        }

        .datetime-trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          cursor: pointer;
          text-align: left;
        }

        .datetime-icon {
          display: flex;
          color: #6d7175;
          flex-shrink: 0;
        }

        .datetime-icon svg {
          width: 16px;
          height: 16px;
          display: block;
        }

        .calendar-menu,
        .time-menu {
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          background: white;
          box-shadow: 0 8px 18px rgba(0, 0, 0, 0.12);
        }

        .calendar-menu {
          padding: 10px;
        }

        .calendar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 13px;
          font-weight: 600;
        }

        .calendar-header button {
          width: 28px;
          height: 28px;
          border: 1px solid #d9d9d9;
          border-radius: 6px;
          background: white;
          cursor: pointer;
        }

        .calendar-weekdays,
        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 2px;
          text-align: center;
        }

        .calendar-weekdays span {
          font-size: 11px;
          color: #6d7175;
          padding: 4px 0;
        }

        .calendar-grid button {
          height: 30px;
          border: none;
          border-radius: 6px;
          background: transparent;
          font-size: 12px;
          cursor: pointer;
        }

        .calendar-grid button:hover,
        .time-column button:hover {
          background: #f6f6f6;
        }

        .calendar-grid button.is-selected,
        .time-column button.is-selected {
          background: #303030;
          color: white;
        }

        .time-menu {
          display: grid;
          grid-template-columns: 1fr 1fr 0.8fr;
          width: 210px;
          height: 220px;
          overflow: hidden;
        }

        .time-column {
          overflow: auto;
          padding: 6px 0;
        }

        .time-column + .time-column {
          border-left: 1px solid #eee;
        }

        .time-column button {
          display: block;
          width: 100%;
          height: 28px;
          border: none;
          background: transparent;
          font-size: 13px;
          cursor: pointer;
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

        .quick-grid button.is-active {
          background: #2c6ecb;
          border-color: #2c6ecb;
          color: white;
        }

        .quick-grid button.is-active:hover {
          background: #1f5199;
          border-color: #1f5199;
        }

        .quick-grid button:last-child {
          grid-column: 1 / -1;
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
          border-radius: 6px;
          padding: 8px 10px;
          font-size: 12px;
          line-height: 1.4;
          color: #174a70;
        }

        .info-note strong {
          display: inline;
          margin-right: 4px;
        }


        /* =========================================
           GENERATE PRODUCT TALLY BUTTON
        ========================================= */

        .generate-area {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
          margin-top: 10px;
        }

        .tally-filters {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          position: relative;
          z-index: 5;
        }

        .filter-select {
          position: relative;
          min-width: 0;
        }

        .filter-select.is-open {
          z-index: 6;
        }

        .filter-select-trigger {
          width: 100%;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 10px;
          border: 1px solid #b5b5b5;
          border-radius: 6px;
          background: white;
          font-size: 13px;
          cursor: pointer;
          text-align: left;
        }

        .filter-select-trigger span:first-child {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .filter-select-caret {
          color: #6d7175;
          flex-shrink: 0;
        }

        .filter-select-menu {
          overflow: auto;
          border: 1px solid #d9d9d9;
          border-radius: 6px;
          background: white;
          box-shadow: 0 8px 18px rgba(0, 0, 0, 0.08);
          padding: 6px 0;
        }

        .filter-select-option {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          font-size: 13px;
          cursor: pointer;
        }

        .filter-select-option:hover {
          background: #f6f6f6;
        }

        .filter-select-option input {
          width: 14px;
          height: 14px;
          margin: 0;
        }

        .filter-select-empty {
          padding: 10px;
          font-size: 12px;
          color: #6d7175;
        }

        .included-orders-link {
          background: none;
          border: none;
          padding: 0;
          color: #2c6ecb;
          font-size: 13px;
          text-align: center;
          cursor: pointer;
          text-decoration: underline;
        }

        .included-orders-link:hover {
          color: #1f5199;
        }

        .included-orders-link:disabled {
          color: #8c9196;
          cursor: default;
          text-decoration: none;
        }

        .included-orders-table-wrap {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          overscroll-behavior: contain;
          border: 1px solid #e5e5e5;
          border-radius: 6px;
        }

        .included-orders-table-wrap thead th {
          position: sticky;
          top: 0;
          z-index: 1;
          box-shadow: 0 1px 0 #eeeeee;
        }

        .included-orders-overlay {
          position: fixed;
          inset: 0;
          background: rgba(26, 26, 26, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 1000;
          overflow: hidden;
        }

        .included-orders-popup {
          width: min(760px, 100%);
          max-height: 100%;
          display: flex;
          flex-direction: column;
          flex: 0 1 auto;
          min-height: 0;
          overflow: hidden;
          background: white;
          border: 1px solid #d9d9d9;
          border-radius: 8px;
          padding: 18px;
        }

        .included-orders-popup-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 8px;
          flex-shrink: 0;
        }

        .included-orders-popup-header strong {
          font-size: 16px;
        }

        .included-orders-popup-range,
        .included-orders-popup p {
          font-size: 13px;
          line-height: 1.5;
          margin: 0 0 12px;
          flex-shrink: 0;
        }

        .included-orders-popup-range p {
          margin: 0;
        }

        .included-orders-close {
          height: 32px;
          padding: 0 12px;
          border: 1px solid #c9c9c9;
          border-radius: 6px;
          background: white;
          cursor: pointer;
          font-size: 13px;
        }

        .included-orders-error {
          color: #9b1c1c;
        }

        .included-orders-check {
          width: 36px;
          text-align: center !important;
          vertical-align: middle;
        }

        .included-orders-check input {
          width: 16px;
          height: 16px;
          margin: 0;
          cursor: pointer;
        }

        .included-order-admin-link {
          color: #2c6ecb;
          text-decoration: underline;
        }

        .included-order-admin-link:hover {
          color: #1f5199;
        }

        .included-orders-table-wrap tr.is-excluded td {
          color: #8c9196;
        }

        .included-orders-table-wrap tr.is-excluded .included-order-admin-link {
          color: #8c9196;
        }

        .print-labels-popup {
          width: min(1080px, 100%);
          height: min(760px, 100%);
          display: flex;
          flex-direction: column;
          background: white;
          border: 1px solid #d9d9d9;
          border-radius: 10px;
          overflow: hidden;
        }

        .print-labels-body {
          flex: 1 1 auto;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 260px;
        }

        .print-labels-preview {
          min-height: 0;
          overflow: auto;
          padding: 20px;
          background: #f4f4f4;
        }

        .print-labels-status {
          margin: 0;
          font-size: 13px;
          color: #6d7175;
        }

        .print-labels-sidebar {
          border-left: 1px solid #e5e5e5;
          padding: 20px 18px;
          background: white;
        }

        .print-labels-sidebar-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 14px;
        }

        .print-labels-option {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
        }

        .print-labels-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          padding: 14px 18px;
          border-top: 1px solid #e5e5e5;
          background: white;
        }

        .print-labels-cancel,
        .print-labels-continue {
          height: 36px;
          padding: 0 16px;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
        }

        .print-labels-cancel {
          border: 1px solid #c9c9c9;
          background: white;
        }

        .print-labels-continue {
          border: 1px solid #1a1a1a;
          background: #1a1a1a;
          color: white;
        }

        .print-labels-continue:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .shipping-slip {
          max-width: 720px;
          margin: 0 auto 16px;
          padding: 24px 28px 16px;
          background: white;
          border: 1px solid #d8d8d8;
          border-radius: 8px;
          overflow: hidden;
          color: #111;
          font-family: Inter, Helvetica, Arial, sans-serif;
          font-size: 14px;
          line-height: 1.4;
        }

        .shipping-slip .slip-date {
          float: right;
          text-align: right;
          margin: 0;
        }

        .shipping-slip .slip-shop {
          margin: 0 0 1.5em;
        }

        .shipping-slip .shop-name {
          font-size: 2em;
        }

        .shipping-slip hr {
          clear: both;
          border: none;
          border-top: 2px solid #111;
          margin: 0 0 1.2em;
        }

        .shipping-slip h3 {
          margin: 0 0 1em;
          font-size: 16px;
        }

        .shipping-slip .item-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
          margin: 0 0 1.5em;
        }

        .shipping-slip .col-image {
          width: 120px;
        }

        .shipping-slip .col-sku {
          width: 28%;
        }

        .shipping-slip .col-qty {
          width: 18%;
        }

        .shipping-slip .item-table th,
        .shipping-slip .item-table td {
          border: none;
          border-top: 1px solid #111;
          border-bottom: 1px solid #111;
          padding: 16px 12px;
          vertical-align: middle;
          text-align: left;
        }

        .shipping-slip .item-table th:first-child,
        .shipping-slip .item-table td:first-child {
          border-left: 1px solid #111;
        }

        .shipping-slip .item-table th:last-child,
        .shipping-slip .item-table td:last-child {
          border-right: 1px solid #111;
        }

        .shipping-slip .item-table th {
          font-weight: 700;
        }

        .shipping-slip .item-table td.image-cell {
          padding: 12px;
        }

        .shipping-slip .item-image {
          width: 100px;
          height: 100px;
        }

        .shipping-slip .item-image img {
          width: 100px;
          height: 100px;
          object-fit: contain;
          display: block;
        }

        .shipping-slip .thanks-under {
          margin: 0 0 1.5em;
          text-align: left;
        }

        .shipping-slip .box {
          margin: 0 0 1em;
          padding: 1em;
          border: 1px solid #111;
          min-height: 72px;
        }

        .shipping-slip .footer {
          margin: 1em 0 0;
          font-size: 14px;
        }

        @media (max-width: 800px) {
          .print-labels-body {
            grid-template-columns: 1fr;
          }

          .print-labels-sidebar {
            border-left: none;
            border-top: 1px solid #e5e5e5;
          }
        }

        .generate-actions {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
        }

        .generate-button,
        .save-button {
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

        .save-button {
          background: white;
          color: #1a1a1a;
          min-width: 88px;
        }

        .save-status {
          font-size: 12px;
          color: #1a7f37;
          text-align: center;
        }

        .save-popup {
          width: min(420px, calc(100vw - 32px));
          background: white;
          border-radius: 10px;
          padding: 16px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
        }

        .save-popup-copy {
          margin: 0 0 12px;
          font-size: 13px;
          color: #6d7175;
        }

        .save-name-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 6px;
        }

        .save-name-input {
          width: 100%;
          height: 36px;
          padding: 0 10px;
          border: 1px solid #b5b5b5;
          border-radius: 6px;
          font-size: 13px;
          box-sizing: border-box;
        }

        .save-popup-actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 12px;
        }

        .save-popup-actions .save-button {
          width: auto;
        }

        .generate-button:hover {
          background: #303030;
        }

        .save-button:hover {
          background: #f6f6f6;
        }

        .generate-button:disabled,
        .save-button:disabled {
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

        .preview-table-wrap {
          max-height: 500px;
          overflow: auto;
        }

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
          position: sticky;
          top: 0;
          z-index: 1;
        }

        td:last-child,
        th:last-child {
          text-align: right;
        }

        .preview-empty {
          text-align: center !important;
          color: #6d7175;
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
          flex-wrap: wrap;
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
          flex-wrap: wrap;
          gap: 12px;
          margin-left: auto;
          flex-shrink: 0;
          justify-content: flex-end;
        }

        .print-button {
          height: 50px;
          min-width: 220px;

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

        .print-button:hover:not(:disabled) {
          background: #f6f6f6;
        }

        .print-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
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