import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/* =====================
   Config via ENV
   - VITE_ORDERS_API  → full URL to orders endpoint
   - VITE_PRICES_API  → full URL to prices endpoint
   (Optional fallback) VITE_PROXY_BASE → base URL if you still want one host providing
     /api/orders and /api/prices
   ===================== */

const proxyBase = import.meta.env.VITE_PROXY_BASE || ""; // optional legacy fallback
const ORDERS_API = import.meta.env.VITE_ORDERS_API || `${proxyBase}/api/orders`;
const PRICES_API = import.meta.env.VITE_PRICES_API || `${proxyBase}/api/prices`;

const POLL_MS = Number(import.meta.env.VITE_POLL_MS || 3000);

const TIMEZONE = "Asia/Ho_Chi_Minh";
const tsVNT = (t) =>
  t
    ? new Date(t)
        .toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false })
        .replace(",", "")
    : "";

const num = (x) => (typeof x === "number" ? x : Number(x || 0));
const fmt = (n, d = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: d })
    : n;

function useInterval(cb, delay) {
  const savedRef = useRef(cb);
  useEffect(() => {
    savedRef.current = cb;
  }, [cb]);
  useEffect(() => {
    if (delay == null) return;
    const id = setInterval(() => savedRef.current?.(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

async function fetchJSON(url, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(url + (qs ? `?${qs}` : ""));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- PNL/ROI helpers (robust) ---------- */
const dir = (mode) => (mode === "long" ? 1 : mode === "short" ? -1 : 0);
const getSymbolKey = (r) => r?.raw?.symbol || r?.symbolUnderscore || r?.symbol || "";
const getCloseAvg = (r) => {
  const v = r?.raw?.closeAvgPrice;
  return v === 0 || v ? v : r?.closeAvgPrice;
};
const isClosed = (r) => num(getCloseAvg(r)) > 0;

const pnlClosed = (r) => {
  const openP = num(r.openPrice);
  const closeP = num(getCloseAvg(r));
  const qty = num(r.amount);
  const d = dir(r.mode);
  if (!openP || !closeP || !qty || !d) return NaN;
  return (closeP - openP) * d * qty;
};
const pnlOpenWithLive = (r, live) => {
  const openP = num(r.openPrice);
  const qty = num(r.amount);
  const d = dir(r.mode);
  const lp = num(live);
  if (!openP || !qty || !d || !lp) return NaN;
  return (lp - openP) * d * qty;
};
const roiFrom = (pnl, margin) =>
  Number.isFinite(pnl) && num(margin) ? (pnl / num(margin)) * 100 : NaN;

/* ---------- Number cell with colors ---------- */
function ColorNumber({ value, decimals = 2, suffix = "" }) {
  if (!Number.isFinite(value)) return <span className="dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "num-pos" : v < 0 ? "num-neg" : "num-zero";
  return (
    <span className={cls}>
      {fmt(v, decimals)}
      {suffix}
    </span>
  );
}

function ModeCell({ mode }) {
  const m = String(mode || "").toLowerCase();
  const cls = m === "long" ? "mode-long" : m === "short" ? "mode-short" : "";
  return <span className={cls}>{m || "?"}</span>;
}

/* ---------- CSV helpers (export exactly what is shown) ---------- */
function escapeCsv(val) {
  if (val == null) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsvFromRows(columns, rows, filename = "leaders_table.csv") {
  const header = columns.map((c) => escapeCsv(c.header)).join(",");
  const lines = rows.map((r) =>
    columns
      .map((c) => escapeCsv(c.get?.(r)))
      .join(",")
  );
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setError("");
      setLoading(true);

      // Backend tự lấy UIDs từ .env
      const data = await fetchJSON(ORDERS_API);
      if (!data.success) throw new Error(data.error || "Unknown error");
      let baseRows = Array.isArray(data.data) ? data.data : [];

      // Lấy symbol cần giá live (cho lệnh đang mở)
      const needSymbols = [
        ...new Set(baseRows.filter((r) => !isClosed(r)).map(getSymbolKey).filter(Boolean)),
      ];

      // Gọi batch price
      let priceMap = {};
      if (needSymbols.length) {
        const res = await fetchJSON(PRICES_API, { symbols: needSymbols.join(",") });
        if (res.success && res.prices) priceMap = res.prices;
      }

      // Tính PNL/ROI
      baseRows = baseRows.map((r) => {
        const closed = isClosed(r);
        const live = priceMap[getSymbolKey(r)];
        const pnl = closed ? pnlClosed(r) : pnlOpenWithLive(r, live);
        const roi = roiFrom(pnl, r.margin);
        const changePct =
          num(r.openPrice) && num(live) ? ((live - r.openPrice) / r.openPrice) * 100 : NaN;
        return {
          ...r,
          __pnl: Number.isFinite(pnl) ? pnl : NaN,
          __roi: Number.isFinite(roi) ? roi : NaN,
          __marketPrice: live,
          __changePct: Number.isFinite(changePct) ? changePct : NaN,
        };
      });

      setRows(baseRows);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);
  useInterval(load, POLL_MS);

  const sorted = useMemo(() => [...rows].sort((a, b) => b.openAt - a.openAt), [rows]);

  // Define columns (what you see is what you export)
  const columns = useMemo(
    () => [
      { header: "Trader", get: (r) => r.trader ?? "" },
      { header: "Symbol", get: (r) => r.symbol ?? "" },
      { header: "Mode", get: (r) => <ModeCell mode={r.mode} /> },
      { header: "Lev", get: (r) => (r.lev ? `${fmt(num(r.lev), 0)}x` : "") },
      { header: "Margin Mode", get: (r) => r.marginMode ?? "" },
      { header: "PNL (USDT)", get: (r) => (Number.isFinite(r.__pnl) ? fmt(num(r.__pnl), 2) : "") },
      { header: "ROI %", get: (r) => (Number.isFinite(r.__roi) ? `${fmt(num(r.__roi), 2)}%` : "") },
      { header: "Open Price", get: (r) => (Number.isFinite(num(r.openPrice)) ? fmt(num(r.openPrice), 6) : "") },
      { header: "Market Price", get: (r) => (Number.isFinite(num(r.__marketPrice)) ? fmt(num(r.__marketPrice), 6) : "") },
      { header: "Δ % vs Open", get: (r) => (Number.isFinite(r.__changePct) ? `${fmt(num(r.__changePct), 2)}%` : "") },
      { header: "Amount", get: (r) => (Number.isFinite(num(r.amount)) ? fmt(num(r.amount), 4) : "") },
      { header: "Margin (USDT)", get: (r) => (Number.isFinite(num(r.margin)) ? fmt(num(r.margin), 4) : "") },
      { header: "Notional (USDT)", get: (r) => (Number.isFinite(num(r.notional)) ? fmt(num(r.notional), 2) : "") },
      { header: "Open At (VNT)", get: (r) => r.openAtStr || tsVNT(r.openAt) },
      { header: "Margin %", get: (r) => (Number.isFinite(num(r.marginPct)) ? `${fmt(num(r.marginPct), 2)}%` : "") },
      { header: "Followers", get: (r) => (r.followers ?? "") },
      // 👉 UID column at the END, from raw.traderUid
      { header: "UID", get: (r) => (r.raw?.traderUid != null ? String(r.raw.traderUid) : "") },
    ],
    []
  );

  const handleDownloadCsv = () => {
    downloadCsvFromRows(columns, sorted, "leaders_table.csv");
  };

  useEffect(() => {
    const script = document.createElement("script");
    script.defer = true;
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    script.setAttribute("data-cf-beacon", '{"token": "96cad86762d54523b1f7736f0f345953"}');
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script); // cleanup on unmount
    };
  }, []);

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1 className="h1">MEXC Copy Futures — Leaders' Orders (Realtime)</h1>
          <p className="note">Timezone: VNT (Asia/Ho_Chi_Minh) • Refresh: {Math.round(POLL_MS / 1000)}s</p>
        </div>
        <div className="header-actions" style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={handleDownloadCsv}>Download CSV (what you see)</button>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            padding: 12,
            borderColor: "#7a2d2d",
            background: "#26161a",
            color: "#ffb4b4",
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.header}>{c.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.header}>
                      {c.header === "PNL (USDT)" ? (
                        <ColorNumber value={r.__pnl} decimals={2} />
                      ) : c.header === "ROI %" ? (
                        <ColorNumber value={r.__roi} decimals={2} suffix="%" />
                      ) : c.header === "Δ % vs Open" ? (
                        <ColorNumber value={r.__changePct} decimals={2} suffix="%" />
                      ) : c.header === "Mode" ? (
                        <ModeCell mode={r.mode} />
                      ) : (
                        c.get(r)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
