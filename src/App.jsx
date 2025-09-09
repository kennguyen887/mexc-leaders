import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const PROXY_BASE = import.meta.env.VITE_PROXY_BASE || "http://localhost:8787";
const POLL_MS = Number(import.meta.env.VITE_POLL_MS || 3000);

const TIMEZONE = "Asia/Ho_Chi_Minh";
const tsVNT = (t) =>
  t ? new Date(t).toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false }).replace(",", "") : "";

const num = (x) => (typeof x === "number" ? x : Number(x || 0));
const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : n;

function useInterval(cb, delay) {
  const savedRef = useRef(cb);
  useEffect(() => { savedRef.current = cb; }, [cb]);
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
  return (v === 0 || v) ? v : r?.closeAvgPrice;
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
const roiFrom = (pnl, margin) => (Number.isFinite(pnl) && num(margin) ? (pnl / num(margin)) * 100 : NaN);

/* ---------- Number cell with colors ---------- */
function ColorNumber({ value, decimals = 2, suffix = "" }) {
  if (!Number.isFinite(value)) return <span className="dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "num-pos" : v < 0 ? "num-neg" : "num-zero";
  return <span className={cls}>{fmt(v, decimals)}{suffix}</span>;
}
const ModeCell = ({ mode }) => {
  const m = String(mode || "");
  return <span className={m === "long" ? "mode-long" : m === "short" ? "mode-short" : ""}>{m || "?"}</span>;
};

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setError(""); setLoading(true);

      // Backend tự lấy UIDs từ .env
      const data = await fetchJSON(`${PROXY_BASE}/api/orders`);
      if (!data.success) throw new Error(data.error || "Unknown error");
      let baseRows = Array.isArray(data.data) ? data.data : [];

      // Lấy symbol cần giá live (cho lệnh đang mở)
      const needSymbols = [...new Set(
        baseRows.filter(r => !isClosed(r)).map(getSymbolKey).filter(Boolean)
      )];

      // Gọi batch price
      let priceMap = {};
      if (needSymbols.length) {
        const res = await fetchJSON(`${PROXY_BASE}/api/prices`, { symbols: needSymbols.join(",") });
        if (res.success && res.prices) priceMap = res.prices;
      }

      // Tính PNL/ROI
      baseRows = baseRows.map(r => {
        const closed = isClosed(r);
        const live = priceMap[getSymbolKey(r)];
        const pnl = closed ? pnlClosed(r) : pnlOpenWithLive(r, live);
        const roi = roiFrom(pnl, r.margin);
        const changePct = (num(r.openPrice) && num(live))
          ? ((live - r.openPrice) / r.openPrice) * 100
          : NaN;
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

  useEffect(() => { load(); }, []);
  useInterval(load, POLL_MS);

  const sorted = useMemo(() => [...rows].sort((a, b) => b.openAt - a.openAt), [rows]);

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1 className="h1">MEXC Copy Futures — Leaders' Orders (Realtime)</h1>
          <p className="note">Timezone: VNT (Asia/Ho_Chi_Minh) • Refresh: {Math.round(POLL_MS / 1000)}s</p>
        </div>
        <div>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, borderColor: "#7a2d2d", background: "#26161a", color: "#ffb4b4", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Trader</th><th>Symbol</th><th>Mode</th><th>Lev</th><th>Margin Mode</th>
                <th>PNL (USDT)</th><th>ROI %</th>
                <th>Open Price</th><th>Market Price</th><th>Δ % vs Open</th>
                <th>Amount</th><th>Margin (USDT)</th><th>Notional (USDT)</th><th>Open At (VNT)</th><th>Margin %</th><th>Followers</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td>{r.trader}</td>
                  <td>{r.symbol}</td>
                  <td><ModeCell mode={r.mode} /></td>
                  <td>{fmt(num(r.lev), 0)}x</td>
                  <td>{r.marginMode}</td>
                  <td><ColorNumber value={r.__pnl} decimals={2} /></td>
                  <td><ColorNumber value={r.__roi} decimals={2} suffix="%" /></td>
                  <td>{fmt(num(r.openPrice), 6)}</td>
                  <td>{fmt(num(r.__marketPrice), 6)}</td>
                  <td><ColorNumber value={r.__changePct} decimals={2} suffix="%" /></td> {/* 👈 */}
                  <td>{fmt(num(r.amount), 4)}</td>
                  <td>{fmt(num(r.margin), 4)}</td>
                  <td>{fmt(num(r.notional), 2)}</td>
                  <td>{r.openAtStr || tsVNT(r.openAt)}</td>
                  <td>{fmt(num(r.marginPct), 2)}%</td>
                  <td>{r.followers ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

        </div>
      </div>
    </div>
  );
}
