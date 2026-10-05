import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ENGO_API_KEY = process.env.ENGO_API_KEY;
const ENGO_BASE_URL = "https://engo.capital";

const CANARY_TICKERS = ["AAPL", "MSFT", "AMZN", "GOOGL", "JNJ"];

if (!ENGO_API_KEY) {
  console.error("FATAL: ENGO_API_KEY environment variable is not set.");
  process.exit(1);
}

async function engoFetch(path, params = {}) {
  const url = new URL(`${ENGO_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response;

  try {
    response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ENGO_API_KEY}`,
      },
    });
  } catch (err) {
    throw new Error(`Network error calling Engo: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Engo returned non-JSON (status ${response.status}): ${text.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Engo error (status ${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${err.message || String(err)}`,
      },
    ],
  };
}

async function engoPost(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response;

  try {
    response = await fetch(`${ENGO_BASE_URL}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ENGO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Network error calling Engo (POST ${path}): ${err.message}`
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Engo returned non-JSON (status ${response.status}) for POST ${path}: ${text.slice(
        0,
        400
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Engo error (status ${response.status}) for POST ${path}: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

function chunkArray(arr, size) {
  const out = [];

  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }

  return out;
}

/**
 * Server-side panel cache.
 *
 * Lost on Railway redeploy/restart.
 */
const panelCache = new Map();

function makeCacheKey(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      runOne
    )
  );

  return results;
}

/**
 * Subtract N calendar months from YYYY-MM-DD.
 */
function subtractMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Last daily row with date <= target.
 */
function lastOnOrBefore(rows, targetDate) {
  let found = null;

  for (const r of rows) {
    if (r.date <= targetDate) {
      found = r;
    } else {
      break;
    }
  }

  return found;
}

/**
 * YYYY-MM-DD -> YYYY-MM
 */
function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

/**
 * Convert daily observations into month-end observations.
 *
 * For each calendar month, the last available trading
 * observation is retained.
 */
function buildMonthlyCloses(rows) {
  const sorted = [...rows]
    .filter(
      (r) =>
        r &&
        r.date &&
        Number.isFinite(Number(r.close))
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const monthly = new Map();

  for (const row of sorted) {
    monthly.set(monthKey(row.date), {
      month: monthKey(row.date),
      date_used: row.date,
      close: Number(row.close),
    });
  }

  return [...monthly.values()];
}

/**
 * Last monthly close available at or before asof.
 */
function monthlyCloseOnOrBefore(monthlyRows, asof) {
  const target = monthKey(asof);
  let found = null;

  for (const row of monthlyRows) {
    if (row.month <= target) {
      found = row;
    } else {
      break;
    }
  }

  return found;
}

/**
 * Monthly close at or before:
 *
 * asof month - N months.
 */
function previousMonthlyClose(monthlyRows, asof, monthsBack) {
  const targetDate = new Date(
    `${monthKey(asof)}-01T00:00:00Z`
  );

  targetDate.setUTCMonth(
    targetDate.getUTCMonth() - monthsBack
  );

  const targetMonth = targetDate
    .toISOString()
    .slice(0, 7);

  let found = null;

  for (const row of monthlyRows) {
    if (row.month <= targetMonth) {
      found = row;
    } else {
      break;
    }
  }

  return found;
}

/**
 * Cross-sectional percentile.
 *
 * Lowest = 0
 * Highest = 100
 *
 * Ties receive average rank.
 */
function percentileRanks(values) {
  const valid = values
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!valid.length) {
    return new Map();
  }

  if (valid.length === 1) {
    return new Map([[valid[0], 100]]);
  }

  const groups = new Map();

  for (let i = 0; i < valid.length; i++) {
    const value = valid[i];

    if (!groups.has(value)) {
      groups.set(value, []);
    }

    groups.get(value).push(i);
  }

  const result = new Map();

  for (const [value, positions] of groups.entries()) {
    const avgRank =
      positions.reduce(
        (sum, position) => sum + position,
        0
      ) / positions.length;

    result.set(
      value,
      Number(
        (
          (avgRank / (valid.length - 1)) *
          100
        ).toFixed(4)
      )
    );
  }

  return result;
}

function addPercentiles(rows, field) {
  const values = rows
    .map((r) => r[field])
    .filter((v) => Number.isFinite(v));

  const ranks = percentileRanks(values);

  for (const row of rows) {
    row[`${field}_pct`] = Number.isFinite(row[field])
      ? ranks.get(row[field]) ?? null
      : null;
  }
}

/**
 * Alpha Zen weighted momentum score.
 *
 * M1  = 10%
 * M3  = 30%
 * M6  = 30%
 * M12 = 30%
 */
function computeAlphaZenScore(row, weights) {
  const required = [
    "m1_pct",
    "m3_pct",
    "m6_pct",
    "m12_pct",
  ];

  if (
    !required.every((key) =>
      Number.isFinite(row[key])
    )
  ) {
    return null;
  }

  return Number(
    (
      row.m1_pct * weights.m1 +
      row.m3_pct * weights.m3 +
      row.m6_pct * weights.m6 +
      row.m12_pct * weights.m12
    ).toFixed(4)
  );
}

function buildServer() {
  const server = new McpServer({
    name: "mcp-az-recon",
    version: "0.2.0",
  });

  /* ========================================================
     PHASE 0 — CONNECTIVITY
     ======================================================== */

  server.tool(
    "engo_whoami",
    "Phase 0 connectivity check: calls GET /api/v1/me on Engo Arena.",
    {},
    async () => {
      try {
        return textResult(
          await engoFetch("/api/v1/me")
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     PHASE 0A / 0B — PIT S&P 500
     ======================================================== */

  server.tool(
    "engo_sp500_members",
    "Fetches point-in-time S&P 500 membership from Engo's lake as of a given date.",
    {
      asof: z
        .string()
        .describe("Date, YYYY-MM-DD"),

      strict: z
        .boolean()
        .optional()
        .describe(
          "If true, reject thin membership history."
        ),
    },

    async ({ asof, strict = true }) => {
      try {
        const data = await engoFetch(
          "/api/v1/lake/members",
          {
            asof,
            strict,
          }
        );

        const tickers = (
          data.members ||
          data.tickers ||
          []
        ).map((m) =>
          typeof m === "string"
            ? m
            : m.symbol || m.ticker
        );

        const missingCanaries =
          CANARY_TICKERS.filter(
            (t) => !tickers.includes(t)
          );

        return textResult({
          asof,
          strict,

          raw_status:
            data.status ?? null,

          member_count:
            tickers.length,

          members:
            tickers,

          sample_members:
            tickers.slice(0, 15),

          canary_check: {
            checked:
              CANARY_TICKERS,

            all_present:
              missingCanaries.length === 0,

            missing:
              missingCanaries,
          },

          note:
            "Missing canaries after 2018-06-30 is a red flag.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     PHASE 0C — EOD DIAGNOSTIC
     ======================================================== */

  server.tool(
    "engo_price_sample",
    "Fetches adjusted daily EOD history for up to 10 symbols and returns compact diagnostic summaries.",
    {
      symbols: z
        .array(z.string())
        .max(10),

      from: z
        .string()
        .describe("Start date, YYYY-MM-DD"),

      to: z
        .string()
        .describe("End date, YYYY-MM-DD"),

      dataset: z
        .string()
        .optional()
        .describe(
          "us_eod or us_eod_native"
        ),
    },

    async ({
      symbols,
      from,
      to,
      dataset,
    }) => {
      try {
        const results =
          await withConcurrency(
            symbols,
            4,
            async (symbol) => {
              try {
                const data =
                  await engoFetch(
                    `/api/v1/lake/eod/${encodeURIComponent(
                      symbol
                    )}`,
                    {
                      from,
                      to,
                      dataset,
                    }
                  );

                const rows = (
                  data.rows ||
                  data.bars ||
                  data.data ||
                  []
                )
                  .map((r) => ({
                    date:
                      r.date || r.t,
                    close:
                      r.close ?? r.c,
                  }))
                  .sort((a, b) =>
                    a.date.localeCompare(
                      b.date
                    )
                  );

                let suspiciousGaps = 0;

                for (
                  let i = 1;
                  i < rows.length;
                  i++
                ) {
                  const prev =
                    new Date(
                      `${rows[i - 1].date}T00:00:00Z`
                    );

                  const cur =
                    new Date(
                      `${rows[i].date}T00:00:00Z`
                    );

                  if (
                    (cur - prev) /
                      86400000 >
                    5
                  ) {
                    suspiciousGaps++;
                  }
                }

                return {
                  symbol,

                  dataset:
                    data.dataset ??
                    dataset ??
                    "us_eod",

                  source:
                    data.source ??
                    null,

                  close_basis:
                    data.close_basis ??
                    null,

                  row_count:
                    rows.length,

                  first_date:
                    rows[0]?.date ??
                    null,

                  last_date:
                    rows[rows.length - 1]
                      ?.date ?? null,

                  first_close:
                    rows[0]?.close ??
                    null,

                  last_close:
                    rows[rows.length - 1]
                      ?.close ?? null,

                  suspicious_gaps_gt_5d:
                    suspiciousGaps,

                  data_status:
                    "ok",
                };
              } catch (err) {
                return {
                  symbol,
                  data_status:
                    "error",
                  error:
                    err.message,
                };
              }
            }
          );

        return textResult({
          from,
          to,
          dataset:
            dataset ?? "us_eod",
          results,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     PHASE 0D — INDEPENDENT MOMENTUM CHECK
     ======================================================== */

  server.tool(
    "engo_momentum_snapshot",
    "Computes M1/M3/M6/M12 trailing returns independently from adjusted daily closes.",
    {
      symbols: z
        .array(z.string())
        .max(10),

      asof: z
        .string()
        .describe(
          "Snapshot date, YYYY-MM-DD"
        ),

      dataset: z
        .string()
        .optional(),
    },

    async ({
      symbols,
      asof,
      dataset,
    }) => {
      try {
        const from =
          subtractMonths(
            asof,
            13
          );

        const results =
          await withConcurrency(
            symbols,
            4,
            async (symbol) => {
              try {
                const data =
                  await engoFetch(
                    `/api/v1/lake/eod/${encodeURIComponent(
                      symbol
                    )}`,
                    {
                      from,
                      to: asof,
                      dataset,
                    }
                  );

                const rows = (
                  data.rows ||
                  data.bars ||
                  data.data ||
                  []
                )
                  .map((r) => ({
                    date:
                      r.date || r.t,
                    close:
                      r.close ?? r.c,
                  }))
                  .sort((a, b) =>
                    a.date.localeCompare(
                      b.date
                    )
                  );

                const asofRow =
                  lastOnOrBefore(
                    rows,
                    asof
                  );

                if (!asofRow) {
                  return {
                    symbol,
                    data_status:
                      "no_data_at_asof",
                  };
                }

                const lookbacks = {
                  m1: 1,
                  m3: 3,
                  m6: 6,
                  m12: 12,
                };

                const out = {
                  symbol,

                  asof_date_used:
                    asofRow.date,

                  close_asof:
                    asofRow.close,

                  data_status:
                    "ok",
                };

                for (const [
                  key,
                  months,
                ] of Object.entries(
                  lookbacks
                )) {
                  const target =
                    subtractMonths(
                      asof,
                      months
                    );

                  const baseRow =
                    lastOnOrBefore(
                      rows,
                      target
                    );

                  out[
                    `${key}_date_used`
                  ] =
                    baseRow?.date ??
                    null;

                  out[
                    `${key}_pct`
                  ] =
                    baseRow &&
                    baseRow.close
                      ? Number(
                          (
                            ((asofRow.close -
                              baseRow.close) /
                              baseRow.close) *
                            100
                          ).toFixed(2)
                        )
                      : null;
                }

                return out;
              } catch (err) {
                return {
                  symbol,
                  data_status:
                    "error",
                  error:
                    err.message,
                };
              }
            }
          );

        return textResult({
          asof,

          dataset:
            dataset ?? "us_eod",

          method:
            "Independent daily-close momentum calculation.",

          results,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     PHASE 1 — BULK PANEL LOADER
     ======================================================== */

  server.tool(
    "engo_lake_panel_load",
    "Bulk loads adjusted daily price history, automatically chunks requests into <=100 symbols, and caches the full matrix server-side.",
    {
      symbols: z
        .array(z.string())
        .min(1)
        .describe(
          "Ticker list of any length."
        ),

      start: z
        .string()
        .describe(
          "Start date, YYYY-MM-DD"
        ),

      end: z
        .string()
        .describe(
          "End date, YYYY-MM-DD"
        ),

      fields: z
        .array(z.string())
        .optional(),

      dataset: z
        .string()
        .optional(),

      cache_key: z
        .string()
        .optional(),
    },

    async ({
      symbols,
      start,
      end,
      fields,
      dataset,
      cache_key,
    }) => {
      try {
        const batches =
          chunkArray(
            symbols,
            100
          );

        const merged = {};
        const receipts = [];
        const missing = [];

        for (const batch of batches) {
          const body = {
            symbols: batch,
            start,
            end,
            fields:
              fields ?? ["close"],
            allow_partial: true,
          };

          if (dataset) {
            body.dataset =
              dataset;
          }

          let resp;

          try {
            resp =
              await engoPost(
                "/api/v1/lake/panel",
                body
              );
          } catch (err) {
            receipts.push({
              batch_size:
                batch.length,

              status:
                "error",

              error:
                err.message,
            });

            missing.push(
              ...batch
            );

            continue;
          }

          const panelRows =
            resp.panel ??
            resp.data ??
            resp.series ??
            [];

          const bySymbol = {};

          for (const row of panelRows) {
            const sym =
              row.symbol;

            if (!sym) continue;

            (
              bySymbol[sym] ??
         
