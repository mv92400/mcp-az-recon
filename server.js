import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ENGO_API_KEY = process.env.ENGO_API_KEY;
const ENGO_BASE_URL = "https://engo.capital";

// Known mega-caps that should appear in any correct S&P 500 PIT snapshot
// from mid-2018 onward. Used only as a sanity canary (0B), never as data.
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
      headers: { Authorization: `Bearer ${ENGO_API_KEY}` },
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
    throw new Error(`Engo returned non-JSON (status ${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`Engo error (status ${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function errorResult(err) {
  return { isError: true, content: [{ type: "text", text: `Error: ${err.message || String(err)}` }] };
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
    throw new Error(`Network error calling Engo (POST ${path}): ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Engo returned non-JSON (status ${response.status}) for POST ${path}: ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(`Engo error (status ${response.status}) for POST ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Module-scope (not per-request) cache: survives across separate tool calls
 * within the same running Railway process, lost on redeploy/restart.
 * Key -> { symbols, start, end, fields, dataset, data: { symbol: rows[] }, cached_at }
 */
const panelCache = new Map();

function makeCacheKey(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

/** 2024-03-15 minus n months -> "2023-12-15"-ish ISO date (clamped to valid day-of-month). */
function subtractMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** Last row with date <= target, from rows sorted ascending by date (YYYY-MM-DD strings). */
function lastOnOrBefore(rows, targetDate) {
  let found = null;
  for (const r of rows) {
    if (r.date <= targetDate) found = r;
    else break;
  }
  return found;
}

function buildServer() {
  const server = new McpServer({ name: "mcp-az-recon", version: "0.1.0" });

  server.tool(
    "engo_whoami",
    "Phase 0 connectivity check: calls GET /api/v1/me on Engo Arena to confirm the API key works and show account tier/limits.",
    {},
    async () => {
      try {
        return textResult(await engoFetch("/api/v1/me"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "engo_sp500_members",
    "Phase 0A/0B: fetches the point-in-time S&P 500 membership from Engo's lake as of a given date (survivorship-bias-free). Returns member count, a sample of tickers, and a sanity check against known mega-caps that must be present (AAPL, MSFT, AMZN, GOOGL, JNJ) for a correct PIT snapshot. Engo's PIT history is only considered reliable from 2018-06-30 onward.",
    {
      asof: z.string().describe("Date, YYYY-MM-DD, e.g. 2018-06-30"),
      strict: z.boolean().optional().describe("If true (default), Engo returns a 422 instead of a silent partial answer when membership history is too thin for this date."),
    },
    async ({ asof, strict = true }) => {
      try {
        const data = await engoFetch("/api/v1/lake/members", { asof, strict });
        const tickers = (data.members || data.tickers || []).map((m) =>
          typeof m === "string" ? m : m.symbol || m.ticker
        );
        const missingCanaries = CANARY_TICKERS.filter((t) => !tickers.includes(t));
        return textResult({
          asof,
          strict,
          raw_status: data.status ?? null,
          member_count: tickers.length,
          sample_members: tickers.slice(0, 15),
          canary_check: {
            checked: CANARY_TICKERS,
            all_present: missingCanaries.length === 0,
            missing: missingCanaries,
          },
          note: "canary_check.all_present == false on a date after 2018-06-30 is a red flag — do not proceed to Phase 1 until this is resolved.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "engo_price_sample",
    "Phase 0C: fetches adjusted daily EOD history for up to 10 symbols from Engo's lake and returns DIAGNOSTIC SUMMARIES ONLY (date range, row count, first/last close, basic gap check) — never the full daily series, to keep responses compact. Use this to sanity-check data quality before trusting the full universe.",
    {
      symbols: z.array(z.string()).max(10).describe("Up to 10 tickers, e.g. [\"AAPL\",\"MSFT\"]"),
      from: z.string().describe("Start date, YYYY-MM-DD"),
      to: z.string().describe("End date, YYYY-MM-DD"),
      dataset: z.string().optional().describe("us_eod (default, survivorship-free archive) or us_eod_native"),
    },
    async ({ symbols, from, to, dataset }) => {
      try {
        const results = await withConcurrency(symbols, 4, async (symbol) => {
          try {
            const data = await engoFetch(`/api/v1/lake/eod/${encodeURIComponent(symbol)}`, { from, to, dataset });
            const rows = (data.rows || data.bars || data.data || []).map((r) => ({
              date: r.date || r.t,
              close: r.close ?? r.c,
            }));
            // crude gap check: count weekday-to-weekday jumps > 5 calendar days apart
            let suspiciousGaps = 0;
            for (let i = 1; i < rows.length; i++) {
              const prev = new Date(`${rows[i - 1].date}T00:00:00Z`);
              const cur = new Date(`${rows[i].date}T00:00:00Z`);
              if ((cur - prev) / 86400000 > 5) suspiciousGaps++;
            }
            return {
              symbol,
              dataset: data.dataset ?? dataset ?? "us_eod",
              source: data.source ?? null,
              close_basis: data.close_basis ?? null,
              row_count: rows.length,
              first_date: rows[0]?.date ?? null,
              last_date: rows[rows.length - 1]?.date ?? null,
              first_close: rows[0]?.close ?? null,
              last_close: rows[rows.length - 1]?.close ?? null,
              suspicious_gaps_gt_5d: suspiciousGaps,
              data_status: "ok",
            };
          } catch (err) {
            return { symbol, data_status: "error", error: err.message };
          }
        });
        return textResult({ from, to, dataset: dataset ?? "us_eod", results });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "engo_momentum_snapshot",
    "Phase 0D: computes M1/M3/M6/M12 trailing returns OURSELVES (not Engo's own ranking) for up to 10 symbols as of a given date, using raw adjusted daily closes pulled from Engo's lake. For each lookback, finds the trading day closest to (asof - N months) and computes pct change vs the close on asof. Returns one compact row per symbol — purpose is to validate our own momentum engine independently before trusting it on the full universe.",
    {
      symbols: z.array(z.string()).max(10).describe("Up to 10 tickers"),
      asof: z.string().describe("Snapshot date, YYYY-MM-DD"),
      dataset: z.string().optional().describe("us_eod (default) or us_eod_native"),
    },
    async ({ symbols, asof, dataset }) => {
      try {
        const from = subtractMonths(asof, 13); // 1 month buffer before the 12M lookback
        const results = await withConcurrency(symbols, 4, async (symbol) => {
          try {
            const data = await engoFetch(`/api/v1/lake/eod/${encodeURIComponent(symbol)}`, { from, to: asof, dataset });
            const rows = (data.rows || data.bars || data.data || [])
              .map((r) => ({ date: r.date || r.t, close: r.close ?? r.c }))
              .sort((a, b) => (a.date < b.date ? -1 : 1));

            const asofRow = lastOnOrBefore(rows, asof);
            if (!asofRow) {
              return { symbol, data_status: "no_data_at_asof" };
            }
            const lookbacks = { m1: 1, m3: 3, m6: 6, m12: 12 };
            const out = { symbol, asof_date_used: asofRow.date, close_asof: asofRow.close, data_status: "ok" };
            for (const [key, months] of Object.entries(lookbacks)) {
              const target = subtractMonths(asof, months);
              const baseRow = lastOnOrBefore(rows, target);
              out[`${key}_date_used`] = baseRow?.date ?? null;
              out[`${key}_pct`] =
                baseRow && baseRow.close
                  ? Number((((asofRow.close - baseRow.close) / baseRow.close) * 100).toFixed(2))
                  : null;
            }
            return out;
          } catch (err) {
            return { symbol, data_status: "error", error: err.message };
          }
        });
        return textResult({
          asof,
          dataset: dataset ?? "us_eod",
          method: "Each lookback uses the last trading day on or before (asof - N months); return = (close_asof - close_lookback) / close_lookback. This is OUR calculation, not Engo's.",
          results,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "engo_lake_panel_load",
    "Phase 1 bulk loader: fetches adjusted daily price history for MANY symbols from Engo's lake/panel endpoint in one logical call. Automatically chunks the symbol list into batches of <=100 (the API's per-call cap) and fetches each sequentially, merging the result. The full matrix is CACHED SERVER-SIDE under a cache_key and NEVER returned in the response — only a compact summary (symbols loaded/missing, date coverage, row counts, chunk receipts). Use engo_cache_inspect to sanity-check what's cached, and future compute tools will reference the matrix by cache_key without re-fetching or re-transmitting it.",
    {
      symbols: z.array(z.string()).min(1).describe("Ticker list, any length — chunked into batches of 100 automatically."),
      start: z.string().describe("Start date, YYYY-MM-DD"),
      end: z.string().describe("End date, YYYY-MM-DD"),
      fields: z.array(z.string()).optional().describe("Fields to fetch, default [\"close\"]"),
      dataset: z.string().optional().describe("us_eod (default, survivorship-free archive) or us_eod_native"),
      cache_key: z.string().optional().describe("Reuse/overwrite a specific cache key instead of auto-generating one."),
    },
    async ({ symbols, start, end, fields, dataset, cache_key }) => {
      try {
        const batches = chunkArray(symbols, 100);
        const merged = {};
        const receipts = [];
        const missing = [];

        for (const batch of batches) {
          const body = { symbols: batch, start, end, fields: fields ?? ["close"], allow_partial: true };
          if (dataset) body.dataset = dataset;
          let resp;
          try {
            resp = await engoPost("/api/v1/lake/panel", body);
            console.log("ENGO RAW RESPONSE:", JSON.stringify(resp));
          } catch (err) {
            receipts.push({ batch_size: batch.length, status: "error", error: err.message });
            missing.push(...batch);
            continue;
          }
          // Schema not independently verified yet — defensive fallbacks across likely shapes.
          const panelData = resp.data ?? resp.panel ?? resp.series ?? {};
          for (const sym of batch) {
            const rows = panelData[sym] ?? panelData?.symbols?.[sym];
            if (rows && rows.length) merged[sym] = rows;
            else missing.push(sym);
          }
          receipts.push({
            batch_size: batch.length,
            status: "ok",
            dataset: resp.dataset ?? dataset ?? "us_eod",
            missing_in_batch: resp.receipt?.missing_symbols ?? [],
            row_count: resp.receipt?.row_count ?? null,
            manifest_hash: resp.receipt?.manifest_hash ?? null,
            complete: resp.receipt?.complete ?? null,
          });
        }

        const key = cache_key || makeCacheKey("panel");
        panelCache.set(key, {
          symbols,
          start,
          end,
          fields: fields ?? ["close"],
          dataset: dataset ?? "us_eod",
          data: merged,
          cached_at: new Date().toISOString(),
        });

        return textResult({
          cache_key: key,
          symbols_requested: symbols.length,
          symbols_cached: Object.keys(merged).length,
          symbols_missing: [...new Set(missing)],
          date_range: { start, end },
          chunks_fetched: batches.length,
          receipts,
          note: "Full price matrix cached server-side under cache_key — not included in this response. In-memory cache: lost on server redeploy/restart.",
          schema_warning: "lake/panel response shape not yet independently verified — if symbols_cached is 0 despite an 'ok' receipt status, the field-name fallbacks (data/panel/series) likely need adjusting. Share one raw chunk receipt and I'll fix it.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "engo_cache_inspect",
    "Lists what's currently cached server-side from engo_lake_panel_load calls (symbols, date range, row counts per symbol), or inspects one cache_key in detail. Does not re-fetch from Engo. Use this to sanity-check the bulk loader before building anything on top of it.",
    {
      cache_key: z.string().optional().describe("Inspect one specific cache entry; omit to list all cached entries."),
    },
    async ({ cache_key }) => {
      if (cache_key) {
        const entry = panelCache.get(cache_key);
        if (!entry) return textResult({ error: "cache_key not found", available_keys: [...panelCache.keys()] });
        const perSymbol = Object.entries(entry.data).map(([sym, rows]) => ({
          symbol: sym,
          row_count: rows.length,
          first: rows[0] ?? null,
          last: rows[rows.length - 1] ?? null,
        }));
        return textResult({
          cache_key,
          start: entry.start,
          end: entry.end,
          dataset: entry.dataset,
          cached_at: entry.cached_at,
          symbol_count: Object.keys(entry.data).length,
          per_symbol_sample: perSymbol.slice(0, 10),
          truncated: perSymbol.length > 10,
        });
      }
      return textResult({
        cached_entries: [...panelCache.entries()].map(([key, entry]) => ({
          cache_key: key,
          symbol_count: Object.keys(entry.data).length,
          start: entry.start,
          end: entry.end,
          cached_at: entry.cached_at,
        })),
      });
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ status: "ok", service: "mcp-az-recon", phase: "0" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mcp-az-recon listening on port ${PORT}`));
