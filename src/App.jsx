import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { createPortal } from "react-dom";
marked.setOptions({ gfm: true, breaks: true }); // cho xuống dòng kiểu Markdown

import "./App.css";

const proxyBase = import.meta.env.VITE_PROXY_BASE || "";
const ORDERS_API = import.meta.env.VITE_ORDERS_API || `${proxyBase}/api/orders`;
const PRICES_API = import.meta.env.VITE_PRICES_API || `${proxyBase}/api/prices`;
const AI_API =  import.meta.env.VITE_AI_API || `${proxyBase}/api/AI/recommend`;
// NEW: API phân tích lệnh futures trực tiếp từ MEXC (server tự fetch)
const ORDERS_AI_API =
  import.meta.env.VITE_ORDERS_AI_API || `${proxyBase}/api/AI/recommend-orders`;

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

/** ===================== API KEY (localStorage) ===================== */
const STORAGE_KEY = "internal_api_key";

function getInternalApiKey() {
  try {
    return (
      window.localStorage.getItem(STORAGE_KEY) ||
      (import.meta.env.VITE_INTERNAL_API_KEY || "")
    );
  } catch {
    return import.meta.env.VITE_INTERNAL_API_KEY || "";
  }
}
function setInternalApiKey(key) {
  try {
    if (key && typeof key === "string") {
      window.localStorage.setItem(STORAGE_KEY, key);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/** fetch JSON helper với header x-api-key tự động */
async function fetchJSON(url, params = {}, init = {}) {
  const qs = new URLSearchParams(params).toString();
  const key = getInternalApiKey();
  const headers = new Headers(init.headers || {});
  if (key) headers.set("x-api-key", key);

  const r = await fetch(url + (qs ? `?${qs}` : ""), { ...init, headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** ===================== UI Helpers ===================== */
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

function escapeCsv(val) {
  if (val == null) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv(columns, rows) {
  const header = columns.map((c) => escapeCsv(c.header)).join(",");
  const lines = rows.map((r) =>
    columns.map((c) => escapeCsv(c.get?.(r))).join(",")
  );
  return [header, ...lines].join("\n");
}
async function copyCsvToClipboard(columns, rows) {
  const csv = buildCsv(columns, rows);
  await navigator.clipboard.writeText(csv);
}

/** ===================== Popup nhập INTERNAL_API_KEY ===================== */

function ApiKeyModal({ open, onClose }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue(getInternalApiKey());
      setTimeout(() => inputRef.current?.focus(), 50);
      document.body.style.overflow = "hidden"; // chặn scroll nền
      return () => { document.body.style.overflow = ""; };
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    const trimmed = (value || "").trim();
    setInternalApiKey(trimmed);
    onClose?.(trimmed);
  };
  const handleClear = () => {
    setInternalApiKey("");
    setValue("");
    onClose?.("");
  };

  return createPortal(
    <div className="modal-root" role="dialog" aria-modal="true">
      <div className="modal-backdrop" onClick={() => onClose?.(getInternalApiKey())} />
      <div className="modal-card">
        <h2 className="modal-title">Set INTERNAL_API_KEY</h2>
        <p className="modal-desc">
          Khóa này sẽ được lưu trong <code>localStorage</code> và tự động gắn vào header <code>x-api-key</code> cho mọi request.
        </p>

        <label className="modal-label" htmlFor="apiKey">INTERNAL_API_KEY</label>
        <input
          id="apiKey"
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Nhập khóa nội bộ..."
          className="modal-input"
        />

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleClear} title="Xóa key khỏi localStorage">Clear</button>
          <div className="modal-actions-right">
            <button className="btn btn-ghost" onClick={() => onClose?.(getInternalApiKey())}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave}>Save Key</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** ===================== MAIN APP ===================== */
export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false); // NEW: loading cho Orders AI
  const [error, setError] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyExists, setKeyExists] = useState(false);

  const load = async () => {
    try {
      setError("");
      setLoading(true);
      const data = await fetchJSON(ORDERS_API);
      if (!data.success) throw new Error(data.error || "Unknown error");
      let baseRows = Array.isArray(data.data) ? data.data : [];

      const needSymbols = [
        ...new Set(
          baseRows
            .filter((r) => !r.closeAvgPrice)
            .map((r) => r.symbol)
            .filter(Boolean)
        ),
      ];
      let priceMap = {};
      if (needSymbols.length) {
        const res = await fetchJSON(PRICES_API, { symbols: needSymbols.join(",") });
        if (res.success && res.prices) priceMap = res.prices;
      }

      baseRows = baseRows.map((r) => {
        const open = num(r.openPrice);
        const live = priceMap[r.symbol];
        const pnl = (live - open) * (r.mode === "long" ? 1 : -1) * num(r.amount);
        const roi = num(r.margin) ? (pnl / num(r.margin)) * 100 : NaN;
        const changePct = open && live ? ((live - open) / open) * 100 : NaN;
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

  const runAI = async () => {
    try {
      setAiResult("Đang phân tích...");
      const csv = buildCsv(columns, sorted);
      const key = getInternalApiKey();
      const headers = new Headers({ "Content-Type": "application/json" });
      if (key) headers.set("x-api-key", key);

      const res = await fetch(`${AI_API}?topN=8`, {
        method: "POST",
        headers,
        body: JSON.stringify({ csv }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "AI error");
      setAiResult(data.resultMarkdown);
    } catch (e) {
      setAiResult("❌ Lỗi: " + (e.message || e));
    }
  };

  // NEW: Gọi Orders AI (server tự lấy lệnh từ MEXC, không cần CSV)
  const runOrdersAI = async () => {
    try {
      const key = getInternalApiKey();
      if (!key) {
        setShowKeyModal(true);
        return;
      }
      setOrdersLoading(true);
      setAiResult("Đang lấy lệnh và phân tích (Orders)…");

      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("x-api-key", key);

      const res = await fetch(`${ORDERS_AI_API}?topN=10&lang=vi`, {
        method: "POST",
        headers,
        body: JSON.stringify({}), // giữ JSON để preflight/Content-Type hợp lệ
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Response không phải JSON (HTTP ${res.status})`);
      }

      if (!res.ok || data?.success === false) {
        const msg = data?.error || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      setAiResult(
        data?.resultMarkdown ||
          "ℹ️ Không có nội dung trả về từ Orders API. Vui lòng kiểm tra lại dữ liệu lệnh."
      );
    } catch (e) {
      setAiResult("❌ Lỗi Orders: " + (e?.message || String(e)));
    } finally {
      setOrdersLoading(false);
    }
  };

  useEffect(() => {
    const has = !!getInternalApiKey();
    setKeyExists(has);
    if (!has) setShowKeyModal(true);
  }, []);

  useEffect(() => {
    load();
  }, []);
  useInterval(load, POLL_MS);

  const sorted = useMemo(() => [...rows].sort((a, b) => b.openAt - a.openAt), [rows]);

  const columns = useMemo(
    () => [
      { header: "Trader", get: (r) => r.trader ?? "" },
      { header: "Symbol", get: (r) => r.symbol ?? "" },
      { header: "Mode", get: (r) => (r.mode ? r.mode : "") },
      { header: "Lev", get: (r) => (r.lev ? `${fmt(num(r.lev), 0)}x` : "") },
      { header: "Margin Mode", get: (r) => r.marginMode ?? "" },
      { header: "PNL (USDT)", get: (r) => (Number.isFinite(r.__pnl) ? fmt(num(r.__pnl), 2) : "") },
      { header: "ROI %", get: (r) => (Number.isFinite(r.__roi) ? `${fmt(num(r.__roi), 2)}%` : "") },
      { header: "Open Price", get: (r) => fmt(num(r.openPrice), 6) },
      { header: "Market Price", get: (r) => fmt(num(r.__marketPrice), 6) },
      { header: "Δ % vs Open", get: (r) => `${fmt(num(r.__changePct), 2)}%` },
      { header: "Amount", get: (r) => fmt(num(r.amount), 4) },
      { header: "Margin (USDT)", get: (r) => fmt(num(r.margin), 4) },
      { header: "Notional (USDT)", get: (r) => fmt(num(r.notional), 2) },
      { header: "Open At (VNT)", get: (r) => r.openAtStr || tsVNT(r.openAt) },
      { header: "Margin %", get: (r) => `${fmt(num(r.marginPct), 2)}%` },
      { header: "Followers", get: (r) => r.followers ?? "" },
      { header: "UID", get: (r) => (r.raw?.traderUid != null ? String(r.raw.traderUid) : "") },
    ],
    []
  );

  return (
    <div className="app">
      {/* Header actions + trạng thái key */}
      <div className="header-actions" style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button
          className="btn"
          onClick={() => setShowKeyModal(true)}
          title="Set INTERNAL_API_KEY"
        >
          {keyExists ? "Update Key" : "Set API Key"}
        </button>

        <button className="btn" onClick={runAI}>AI Recommend</button>

        {/* NEW: Orders AI */}
        <button className="btn" onClick={runOrdersAI} disabled={ordersLoading}>
          {ordersLoading ? "Orders…" : "Orders"}
        </button>

        <button className="btn" onClick={() => copyCsvToClipboard(columns, sorted)}>Copy CSV</button>

        <span
          className="inline-dot"
          style={{
            width: 10,
            height: 10,
            borderRadius: "999px",
            background: keyExists ? "#22c55e" : "#ef4444",
            display: "inline-block",
            marginLeft: 8
          }}
          title={keyExists ? "API key loaded" : "Missing API key"}
        />
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {aiResult && (
        <div className="card" style={{ maxWidth: 1300, marginBottom: 12, paddingLeft: 12, position: "relative" }}>
          {/* X close */}
          <button
            className="btn-icon close"
            aria-label="Close AI result"
            onClick={() => setAiResult("")}
            title="Đóng kết quả AI"
            style={{
              position: "absolute",
              top: 0,
              right: 8,
              border: "none",
              background: "transparent",
              fontSize: 30,
              lineHeight: 1,
              cursor: "pointer",
              opacity: 0.65,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.65")}
          >
            ×
          </button>

          {/* Markdown content */}
          <div
            className="ai-md"
            dangerouslySetInnerHTML={{ __html: marked.parse(aiResult) }}
            style={{
              whiteSpace: "normal",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              margin: 0,
            }}
          />
        </div>
      )}

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

      {/* Modal nhập API key */}
      <ApiKeyModal
        open={showKeyModal}
        onClose={() => {
          setKeyExists(!!getInternalApiKey());
          setShowKeyModal(false);
        }}
      />
    </div>
  );
}
