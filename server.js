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
            const sym = row.symbol;

            if (!sym) continue;

            (bySymbol[sym] ?? (bySymbol[sym] = [])).push({
              date: row.date,
              close: row.close,
            });
          }

          for (const sym of batch) {
            const rows = bySymbol[sym];

            if (rows && rows.length) {
              merged[sym] = rows.sort((a, b) =>
                a.date.localeCompare(b.date)
              );
            } else {
              missing.push(sym);
            }
          }

          receipts.push({
            batch_size: batch.length,
            status: "ok",

            dataset:
              resp.dataset ??
              dataset ??
              "us_eod",

            missing_in_batch:
              resp.receipt?.missing_symbols ??
              [],

            row_count:
              resp.receipt?.rows ??
              resp.n ??
              null,

            manifest_hash:
              resp.receipt?.manifest_sha256 ??
              null,

            complete:
              resp.receipt?.complete ??
              null,
          });
        }

        const key =
          cache_key ||
          makeCacheKey("panel");

        panelCache.set(key, {
          symbols,
          start,
          end,

          fields:
            fields ?? ["close"],

          dataset:
            dataset ?? "us_eod",

          data: merged,

          cached_at:
            new Date().toISOString(),
        });

        return textResult({
          cache_key: key,

          symbols_requested:
            symbols.length,

          symbols_cached:
            Object.keys(merged).length,

          symbols_missing: [
            ...new Set(missing),
          ],

          date_range: {
            start,
            end,
          },

          chunks_fetched:
            batches.length,

          receipts,

          note:
            "Full price matrix cached server-side. Cache is lost on redeploy/restart.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     PHASE 2 — ALPHA ZEN RECONSTRUCTION
     ======================================================== */

  server.tool(
    "engo_alpha_compute",
    "Alpha Zen reconstruction engine: daily data -> monthly closes -> M1/M3/M6/M12 -> cross-sectional percentiles -> weighted Alpha Zen score.",
    {
      cache_key: z.string(),

      asof: z.string(),

      top_n: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional(),

      m1_weight: z
        .number()
        .min(0)
        .max(1)
        .optional(),

      m3_weight: z
        .number()
        .min(0)
        .max(1)
        .optional(),

      m6_weight: z
        .number()
        .min(0)
        .max(1)
        .optional(),

      m12_weight: z
        .number()
        .min(0)
        .max(1)
        .optional(),
    },

    async ({
      cache_key,
      asof,
      top_n = 50,
      m1_weight = 0.10,
      m3_weight = 0.30,
      m6_weight = 0.30,
      m12_weight = 0.30,
    }) => {
      try {
        const entry = panelCache.get(cache_key);

        if (!entry) {
          return textResult({
            status: "error",
            error: "cache_key not found",
            cache_key,
            available_keys: [
              ...panelCache.keys(),
            ],
          });
        }

        const weightSum =
          m1_weight +
          m3_weight +
          m6_weight +
          m12_weight;

        if (Math.abs(weightSum - 1) > 0.000001) {
          return textResult({
            status: "error",
            error:
              "Momentum weights must sum to exactly 1.0",
            weights: {
              m1: m1_weight,
              m3: m3_weight,
              m6: m6_weight,
              m12: m12_weight,
            },
            weight_sum: weightSum,
          });
        }

        const weights = {
          m1: m1_weight,
          m3: m3_weight,
          m6: m6_weight,
          m12: m12_weight,
        };

        /*
         * M12 protection.
         *
         * Example:
         * asof = 2018-12-31
         * reference month = 2017-12
         * required history = 2017-12-01
         */
        const m12TargetDate =
          subtractMonths(asof, 12);

        const requiredStart =
          `${m12TargetDate.slice(0, 7)}-01`;

        if (entry.start > requiredStart) {
          return textResult({
            status:
              "insufficient_history",

            cache_key,
            asof,

            required_history_start:
              requiredStart,

            cache_start:
              entry.start,

            cache_end:
              entry.end,

            message:
              "Cached panel starts too late to calculate a valid M12. Reload the same PIT universe with sufficient history.",
          });
        }

        if (entry.end < asof) {
          return textResult({
            status:
              "insufficient_history",

            cache_key,
            asof,

            cache_start:
              entry.start,

            cache_end:
              entry.end,

            message:
              "Cached panel ends before asof. No look-ahead or extrapolation is performed.",
          });
        }

        const universe =
          Object.keys(entry.data);

        const rows = [];

        let noAsOf = 0;
        let noM1 = 0;
        let noM3 = 0;
        let noM6 = 0;
        let noM12 = 0;

        for (const symbol of universe) {
          const dailyRows =
            entry.data[symbol];

          const monthlyRows =
            buildMonthlyCloses(dailyRows);

          const asofMonthClose =
            monthlyCloseOnOrBefore(
              monthlyRows,
              asof
            );

          const baseM1 =
            previousMonthlyClose(
              monthlyRows,
              asof,
              1
            );

          const baseM3 =
            previousMonthlyClose(
              monthlyRows,
              asof,
              3
            );

          const baseM6 =
            previousMonthlyClose(
              monthlyRows,
              asof,
              6
            );

          const baseM12 =
            previousMonthlyClose(
              monthlyRows,
              asof,
              12
            );

          if (!asofMonthClose) {
            noAsOf++;
            continue;
          }

          const row = {
            symbol,

            asof_month:
              asofMonthClose.month,

            asof_date_used:
              asofMonthClose.date_used,

            close_asof:
              asofMonthClose.close,

            m1_base_date_used:
              baseM1?.date_used ?? null,

            m3_base_date_used:
              baseM3?.date_used ?? null,

            m6_base_date_used:
              baseM6?.date_used ?? null,

            m12_base_date_used:
              baseM12?.date_used ?? null,

            m1_pct: null,
            m3_pct: null,
            m6_pct: null,
            m12_pct: null,

            data_status: "ok",
          };

          if (baseM1 && baseM1.close > 0) {
            row.m1_pct =
              ((asofMonthClose.close -
                baseM1.close) /
                baseM1.close) *
              100;
          } else {
            noM1++;
          }

          if (baseM3 && baseM3.close > 0) {
            row.m3_pct =
              ((asofMonthClose.close -
                baseM3.close) /
                baseM3.close) *
              100;
          } else {
            noM3++;
          }

          if (baseM6 && baseM6.close > 0) {
            row.m6_pct =
              ((asofMonthClose.close -
                baseM6.close) /
                baseM6.close) *
              100;
          } else {
            noM6++;
          }

          if (baseM12 && baseM12.close > 0) {
            row.m12_pct =
              ((asofMonthClose.close -
                baseM12.close) /
                baseM12.close) *
              100;
          } else {
            noM12++;
          }

          for (const key of [
            "m1_pct",
            "m3_pct",
            "m6_pct",
            "m12_pct",
          ]) {
            if (Number.isFinite(row[key])) {
              row[key] =
                Number(row[key].toFixed(6));
            }
          }

          rows.push(row);
        }

        addPercentiles(rows, "m1_pct");
        addPercentiles(rows, "m3_pct");
        addPercentiles(rows, "m6_pct");
        addPercentiles(rows, "m12_pct");

        let completeCount = 0;

        for (const row of rows) {
          row.alpha_zen_score =
            computeAlphaZenScore(
              row,
              weights
            );

          if (
            row.alpha_zen_score !== null
          ) {
            completeCount++;
          }
        }

        const eligible =
          rows
            .filter(
              (r) =>
                r.alpha_zen_score !== null
            )
            .sort((a, b) => {
              if (
                b.alpha_zen_score !==
                a.alpha_zen_score
              ) {
                return (
                  b.alpha_zen_score -
                  a.alpha_zen_score
                );
              }

              if (b.m6_pct !== a.m6_pct) {
                return b.m6_pct - a.m6_pct;
              }

              if (b.m12_pct !== a.m12_pct) {
                return b.m12_pct - a.m12_pct;
              }

              return a.symbol.localeCompare(
                b.symbol
              );
            });

        const ranked =
          eligible.map(
            (row, index) => ({
              rank: index + 1,
              ...row,
            })
          );

        return textResult({
          status: "ok",

          engine:
            "alpha_zen_reconstruction",

          methodology: {
            monthly_close_method:
              "Last available trading observation in each calendar month",

            lookahead_policy:
              "Only observations dated on or before asof are used",

            m1_weight:
              weights.m1,

            m3_weight:
              weights.m3,

            m6_weight:
              weights.m6,

            m12_weight:
              weights.m12,

            score_method:
              "Weighted cross-sectional percentiles of M1/M3/M6/M12",

            raw_return_formula:
              "(month_end_close_asof - month_end_close_base) / month_end_close_base",
          },

          cache: {
            cache_key,

            cache_start:
              entry.start,

            cache_end:
              entry.end,

            dataset:
              entry.dataset,

            universe_size:
              universe.length,
          },

          asof,

          required_history_start:
            requiredStart,

          universe_diagnostics: {
            symbols_in_cache:
              universe.length,

            symbols_with_asof:
              rows.length,

            symbols_missing_asof:
              noAsOf,

            complete_momentum:
              completeCount,

            incomplete_momentum:
              rows.length -
              completeCount,

            missing_m1:
              noM1,

            missing_m3:
              noM3,

            missing_m6:
              noM6,

            missing_m12:
              noM12,
          },

          result_count:
            Math.min(
              top_n,
              ranked.length
            ),

          eligible_count:
            ranked.length,

          results:
            ranked.slice(
              0,
              top_n
            ),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  /* ========================================================
     CACHE INSPECTION
     ======================================================== */

  server.tool(
    "engo_cache_inspect",
    "Lists or inspects server-side panel caches without re-fetching Engo data.",
    {
      cache_key: z
        .string()
        .optional(),
    },

    async ({ cache_key }) => {
      if (cache_key) {
        const entry =
          panelCache.get(cache_key);

        if (!entry) {
          return textResult({
            error:
              "cache_key not found",

            available_keys:
              [...panelCache.keys()],
          });
        }

        const perSymbol =
          Object.entries(entry.data).map(
            ([sym, rows]) => ({
              symbol: sym,

              row_count:
                rows.length,

              first:
                rows[0] ?? null,

              last:
                rows[rows.length - 1] ??
                null,
            })
          );

        return textResult({
          cache_key,

          start:
            entry.start,

          end:
            entry.end,

          dataset:
            entry.dataset,

          cached_at:
            entry.cached_at,

          symbol_count:
            Object.keys(entry.data).length,

          per_symbol_sample:
            perSymbol.slice(0, 10),

          truncated:
            perSymbol.length > 10,
        });
      }

      return textResult({
        cached_entries:
          [...panelCache.entries()].map(
            ([key, entry]) => ({
              cache_key: key,

              symbol_count:
                Object.keys(
                  entry.data
                ).length,

              start:
                entry.start,

              end:
                entry.end,

              cached_at:
                entry.cached_at,
            })
          ),
      });
    }
  );

  return server;
}

/* ==========================================================
   EXPRESS / MCP HTTP SERVER
   ========================================================== */

const app = express();

app.use(express.json());

app.get("/", (_req, res) =>
  res.json({
    status: "ok",

    service:
      "mcp-az-recon",

    phase: "2",

    build:
      "alpha-zen-reconstruction-engine-2026-10-05",
  })
);

app.post(
  "/mcp",
  async (req, res) => {
    try {
      const server =
        buildServer();

      const transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator:
            undefined,
        });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(
        transport
      );

      await transport.handleRequest(
        req,
        res,
        req.body
      );
    } catch (err) {
      console.error(
        "Error handling MCP request:",
        err
      );

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",

          error: {
            code: -32603,

            message:
              "Internal server error",
          },

          id: null,
        });
      }
    }
  }
);

app.get(
  "/mcp",
  (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",

      error: {
        code: -32000,

        message:
          "Method not allowed. Use POST.",
      },

      id: null,
    });
  }
);

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () =>
    console.log(
      `mcp-az-recon listening on port ${PORT}`
    )
);
         
