/* eslint-disable no-empty */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { createPortal } from "react-dom";
marked.setOptions({ gfm: true, breaks: true });

import "./App.css";

const proxyBase = import.meta.env.VITE_PROXY_BASE || "";
const ORDERS_API = import.meta.env.VITE_ORDERS_API || `${proxyBase}/api/orders`;
const PRICES_API = import.meta.env.VITE_PRICES_API || `${proxyBase}/api/prices`;
const AI_API = import.meta.env.VITE_AI_API || `${proxyBase}/api/AI/recommend`;
const ORDERS_AI_API =
  import.meta.env.VITE_ORDERS_AI_API || `${proxyBase}/api/AI/recommend-orders`;

const POLL_MS = Number(import.meta.env.VITE_POLL_MS || 3000);
const TIMEZONE = "Asia/Ho_Chi_Minh";
const PER_REQ_DELAY_MS = Number(import.meta.env.VITE_PER_REQ_DELAY_MS || 90);
const BATCH_SIZE = Number(import.meta.env.VITE_BATCH_SIZE || 3);

const TRADERS_INTERVAL = import.meta.env.VITE_TRADERS_INTERVAL || "ALL";
const TRADERS_LIMIT = Number(import.meta.env.VITE_TRADERS_LIMIT || 100);
const TRADERS_PAGE = Number(import.meta.env.VITE_TRADERS_PAGE || 1);

function buildMexcTradersUrlWith(orderBy) {
  const base = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2";
  const params = new URLSearchParams({
    intervalType: TRADERS_INTERVAL,
    limit: String(TRADERS_LIMIT),
    orderBy: orderBy,
    page: String(TRADERS_PAGE),
  });
  return `${base}?${params.toString()}`;
}
function buildProxyCallUrl(callUrl) {
  const u = new URL(`${proxyBase}/api/call`);
  u.searchParams.set("callUrl", callUrl);
  return u.toString();
}

const tsVNT = (t) => {
  if (!t) return "";
  const diff = Date.now() - new Date(t).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24 ? h % 24 + "h" : ""} ago`;
  if (h > 0) return `${h}h${m % 60 ? m % 60 + "m" : ""} ago`;
  if (m > 0) return `${m}m${s % 60 ? s % 60 + "s" : ""} ago`;
  if (s > 5) return `${s}s ago`;
  return "just now";
};

const fmtAbsVNT = (t) =>
  t
    ? new Date(t).toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false }).replace(",", "")
    : "";

const num = (x) => (typeof x === "number" ? x : Number(x || 0));
const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const STORAGE_KEY = "internal_api_key";
function getInternalApiKey() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || (import.meta.env.VITE_INTERNAL_API_KEY || "");
  } catch {
    return import.meta.env.VITE_INTERNAL_API_KEY || "";
  }
}
function setInternalApiKey(key) {
  try {
    if (key && typeof key === "string") window.localStorage.setItem(STORAGE_KEY, key);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

async function fetchJSON(url, params = {}, init = {}) {
  const qs = new URLSearchParams(params).toString();
  const key = getInternalApiKey();
  const headers = new Headers(init.headers || {});
  if (key) headers.set("x-api-key", key);
  const r = await fetch(url + (qs ? `?${qs}` : ""), { ...init, headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function ColorNumber({ value, decimals = 2, suffix = "" }) {
  if (!Number.isFinite(value)) return <span className="dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "num-pos" : v < 0 ? "num-neg" : "num-zero";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  let shortVal;
  if (abs >= 1_000_000_000) shortVal = (abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  else if (abs >= 1_000_000) shortVal = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  else if (abs >= 1_000) shortVal = (abs / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  else shortVal = fmt(abs, decimals);
  return (
    <span className={cls}>
      {sign}
      {shortVal}
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
    columns
      .map((c) => {
        const v = typeof c.csv === "function" ? c.csv(r) : typeof c.get === "function" ? c.get(r) : "";
        const plain = v == null ? "" : typeof v === "number" ? v : String(v);
        return escapeCsv(plain);
      })
      .join(",")
  );
  return [header, ...lines].join("\n");
}
async function copyCsvToClipboard(columns, rows) {
  const csv = buildCsv(columns, rows);
  await navigator.clipboard.writeText(csv);
}

function ApiKeyModal({ open, onClose }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) {
      setValue(getInternalApiKey());
      setTimeout(() => inputRef.current?.focus(), 50);
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
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

export default function App() {
  const [rows, setRows] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [error, setError] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyExists, setKeyExists] = useState(false);
  const [uidList, setUidList] = useState([]);
  const [uidLoading, setUidLoading] = useState(false);
  const [showNegativePNL, setShowNegativePNL] = useState(true);

  const rowsMapRef = useRef(new Map());
  const priceMapRef = useRef({});

  function getRowUid(r) {
    return r?.raw?.traderUid != null ? String(r.raw.traderUid) : r?.uid != null ? String(r.uid) : "";
  }
  const fmtShort = (n) => {
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
    return sign + abs.toFixed(3).replace(/\.00$/, "");
  };

  function enrichWithLive(r, priceMap) {
    const open = num(r.openPrice);
    const live = priceMap?.[r.symbol];
    const amount = num(r.amount);
    const pnl =
      Number.isFinite(live) && Number.isFinite(open) && Number.isFinite(amount)
        ? (live - open) * (String(r.mode).toLowerCase() === "long" ? 1 : -1) * amount
        : NaN;
    const roi =
      Number.isFinite(pnl) && Number.isFinite(num(r.margin)) && num(r.margin) !== 0
        ? (pnl / num(r.margin)) * 100
        : NaN;
    const changePct =
      Number.isFinite(open) && Number.isFinite(live) && open !== 0 ? ((live - open) / open) * 100 : NaN;
    const openAtMs = r.openAt ? new Date(r.openAt).getTime() : typeof r.openAtMs === "number" ? r.openAtMs : NaN;
    return {
      ...r,
      openAt: openAtMs,
      openAtStr: openAtMs ? tsVNT(openAtMs) : "",
      __pnl: Number.isFinite(pnl) ? pnl : NaN,
      __roi: Number.isFinite(roi) ? roi : NaN,
      __marketPrice: Number.isFinite(live) ? live : undefined,
      __changePct: Number.isFinite(changePct) ? changePct : NaN,
    };
  }

  const upsertAndPruneBatch = (arr, batchUids) => {
    const m = rowsMapRef.current;
    const batchSet = new Set(batchUids.map(String));
    const uidToIds = new Map();
    for (const r of Array.isArray(arr) ? arr : []) {
      const uid = getRowUid(r);
      if (!uid) continue;
      if (!uidToIds.has(uid)) uidToIds.set(uid, new Set());
      uidToIds.get(uid).add(r.id);
    }
    for (const [id, row] of m.entries()) {
      const uid = getRowUid(row);
      if (!uid || !batchSet.has(uid)) continue;
      const keepIds = uidToIds.get(uid);
      if (!keepIds || !keepIds.has(id)) {
        m.delete(id);
      }
    }
    for (const r of Array.isArray(arr) ? arr : []) {
      const existing = m.get(r.id);
      const merged = { ...(existing || {}), ...r };
      const enriched = enrichWithLive(merged, priceMapRef.current);
      m.set(r.id, enriched);
    }
    setRows(Array.from(m.values()));
  };

  const VIP_UIDS = [
    "28905362","71312117","87698388","20393898","61775694","58298982","01086225","74785697","90901845","23747691",
    "15480060","22247145","80778881","54447554","98086898","93765871","85581052","42806597","8197321","64877108",
    "7981129","89989257","13040215","70798336","07695752","07867898","01893067","27337672","77143655", "91401780","98695755","94299227","63070731","77587922"
  ];
  const VIP_SET = useMemo(() => new Set(VIP_UIDS), []);

  const iconForPNL = (pnl) => {
    if (pnl > 7000) return "💎";
    if (pnl > 3000) return "💰";
    if (pnl > 2000) return "🔥";
    if (pnl > 1000) return "🟢";
    return "";
  };
  const iconForMargin = (margin) => {
    if (margin > 10000) return "🏦";
    if (margin > 5000) return "💎";
    if (margin > 2000) return "📈";
    if (margin > 1000) return "💼";
    return "";
  };
  const iconForROI = (roi) => {
    if (roi > 100) return "🚀";
    if (roi > 60) return "🔥";
    if (roi > 30) return "💰";
    if (roi > 10) return "🟢";
    return "";
  };

  const refreshPrices = async () => {
    try {
      const list = Array.from(rowsMapRef.current.values());
      const needSymbols = [...new Set(list.filter((r) => !r.closeAvgPrice && r.symbol).map((r) => r.symbol))];
      if (!needSymbols.length) return;
      const res = await fetchJSON(PRICES_API, { symbols: needSymbols.join(",") });
      if (res?.success && res?.prices) {
        priceMapRef.current = { ...priceMapRef.current, ...res.prices };
        const list2 = list.map((r) => enrichWithLive(r, priceMapRef.current));
        setRows(list2);
      }
    } catch {}
  };

  const refreshUIDs = async () => {
    setUidLoading(true);
    setError("");
    try {
      const orderBys = ["ROI", "PNL", "WIN_RATE", "FOLLOWERS"];
      const allUIDs = [];
      for (const orderBy of orderBys) {
        try {
          const url = buildMexcTradersUrlWith(orderBy);
          const proxyUrl = buildProxyCallUrl(url);
          const resp = await fetchJSON(proxyUrl, {});
          const content = resp?.data?.content || resp?.content || [];
          const list = content.map((it) => String(it?.uid)).filter(Boolean);
          allUIDs.push(...list);
        } catch (innerErr) {
          console.warn(`Fetch traders failed (${orderBy}):`, innerErr);
        }
        await sleep(300);
      }
      const merged = Array.from(new Set(allUIDs));
      if (!merged.length) {
        throw new Error("Không lấy được UID từ traders API (ROI/PNL/WIN_RATE/FOLLOWERS)");
      }
      setUidList(merged);
    } catch (e) {
      setError(`Get UIDs error: ${e?.message || String(e)}`);
    } finally {
      setUidLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const startLoop = async () => {
      const has = !!getInternalApiKey();
      setKeyExists(has);
      if (!has) setShowKeyModal(true);
      if (!uidList.length) {
        await refreshUIDs();
      }
      while (!cancelled) {
        const list = uidList.length ? uidList : [];
        if (list.length === 0) {
          await sleep(Math.max(POLL_MS, 2000));
          continue;
        }
        const batches = chunk(list, BATCH_SIZE);
        for (const batch of batches) {
          if (cancelled) break;
          try {
            const uidsParam = batch.join(",");
            const data = await fetchJSON(ORDERS_API, { uids: uidsParam });
            if (data?.success) {
              const arr = Array.isArray(data.data) ? data.data : [];
              upsertAndPruneBatch(arr, batch);
            }
          } catch (e) {
            setError(e.message || String(e));
          }
          await sleep(PER_REQ_DELAY_MS);
        }
      }
    };
    startLoop();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidList]);

  useEffect(() => {
    const id = setInterval(refreshPrices, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const columns = useMemo(
    () => [
      {
        header: "Symbol",
        get: (r) => (r.symbol || "").slice(0, 8),
        csv: (r) => r.symbol || "",
      },
      {
        header: "Mode",
        get: (r) => <ModeCell mode={r.mode} />,
        csv: (r) => String(r.mode || ""),
      },
      {
        header: "Margin",
        get: (r) => {
          const margin = num(r.margin);
          if (!Number.isFinite(margin)) return <span className="dim">—</span>;
          return (
            <span>
              <ColorNumber value={margin} decimals={2} /> {iconForMargin(margin)}
            </span>
          );
        },
        csv: (r) => (Number.isFinite(num(r.margin)) ? String(num(r.margin)) : ""),
      },
      {
        header: "PNL",
        get: (r) => {
          const pnl = num(r.__pnl);
          if (!Number.isFinite(pnl)) return <span className="dim">—</span>;
          return (
            <span>
              <ColorNumber value={pnl} decimals={2} />{iconForPNL(pnl)}
            </span>
          );
        },
        csv: (r) => (Number.isFinite(num(r.__pnl)) ? String(num(r.__pnl)) : ""),
      },
      {
        header: "Lev",
        get: (r) => (r.lev ? `${fmt(num(r.lev), 0)}x` : ""),
        csv: (r) => (Number.isFinite(num(r.lev)) ? String(num(r.lev)) : ""),
      },
      {
        header: "At VNT",
        get: (r) => r.openAtStr || tsVNT(r.openAt),
        csv: (r) => (r.openAt ? fmtAbsVNT(r.openAt) : r.openAtMs ? fmtAbsVNT(r.openAtMs) : ""),
      },
      {
        header: "Trader",
        get: (r) => {
          const uidStr = getRowUid(r);
          const name = r.trader ?? "";
          const isVip = VIP_SET.has(uidStr);
          const truncated = name.length > 6 ? `${name.slice(0, 4)}…${name.slice(-2)}` : name;
          return (
            <>
              <span className="name-6ch" title={name}>{truncated}</span>
              {isVip ? " ⭐" : ""}
            </>
          );
        },
        csv: (r) => r.trader ?? "",
      },
      {
        header: "Flrs",
        get: (r) => r.followers ?? "",
        csv: (r) => (Number.isFinite(num(r.followers)) ? String(num(r.followers)) : ""),
      },
      {
        header: "ROI %",
        get: (r) => {
          const roi = num(r.__roi);
          if (!Number.isFinite(roi)) return <span className="dim">—</span>;
          return (
            <span>
              <ColorNumber value={roi} decimals={2} suffix="%" /> {iconForROI(roi)}
            </span>
          );
        },
        csv: (r) => (Number.isFinite(num(r.__roi)) ? String(num(r.__roi)) : ""),
      },
      {
        header: "M/Mode",
        get: (r) => r.marginMode ?? "",
        csv: (r) => r.marginMode ?? "",
      },
      {
        header: "Notional",
        get: (r) => fmtShort(num(r.notional), 2),
        csv: (r) => (Number.isFinite(num(r.notional)) ? String(num(r.notional)) : ""),
      },
      {
        header: "Open Price",
        get: (r) => fmtShort(num(r.openPrice), 4),
        csv: (r) => (Number.isFinite(num(r.openPrice)) ? String(num(r.openPrice)) : ""),
      },
      {
        header: "Market Price",
        get: (r) => fmtShort(num(r.__marketPrice), 4),
        csv: (r) => (Number.isFinite(num(r.__marketPrice)) ? String(num(r.__marketPrice)) : ""),
      },
      {
        header: "Δ % vs Open",
        get: (r) => <ColorNumber value={num(r.__changePct)} decimals={2} suffix="%" />,
        csv: (r) => (Number.isFinite(num(r.__changePct)) ? String(num(r.__changePct)) : ""),
      },
      {
        header: "Amount",
        get: (r) => fmtShort(num(r.amount), 3),
        csv: (r) => (Number.isFinite(num(r.amount)) ? String(num(r.amount)) : ""),
      },
      {
        header: "Margin %",
        get: (r) => `${fmt(num(r.marginPct), 2)}%`,
        csv: (r) => (Number.isFinite(num(r.marginPct)) ? String(num(r.marginPct)) : ""),
      },
      {
        header: "UID",
        get: (r) => getRowUid(r),
        csv: (r) => getRowUid(r),
      },
    ],
    []
  );

  const filtered = useMemo(
    () => (showNegativePNL ? rows : rows.filter((r) => Number(r.__pnl) >= 0)),
    [rows, showNegativePNL]
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (Number(b.openAt) || 0) - (Number(a.openAt) || 0)),
    [filtered]
  );

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
        body: JSON.stringify({}),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Response không phải JSON (HTTP ${res.status})`);
      }
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setAiResult(data?.resultMarkdown || "ℹ️ Không có nội dung trả về từ Orders API.");
    } catch (e) {
      setAiResult("❌ Lỗi Orders: " + (e?.message || String(e)));
    } finally {
      setOrdersLoading(false);
    }
  };

  return (
    <div className="app">
      <div
        className="header-actions"
        style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}
      >
        <button className="btn" onClick={() => setShowKeyModal(true)} title="Set INTERNAL_API_KEY">
          {keyExists ? "Update Key" : "Set API Key"}
        </button>
        <button className="btn" onClick={runAI}>AI Recommend</button>
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
            marginLeft: 8,
          }}
          title={keyExists ? "API key loaded" : "Missing API key"}
        />
        <button className="btn" onClick={refreshUIDs} disabled={uidLoading}>
          {uidLoading ? "Fetching UIDs…" : "Refresh UIDs"}
        </button>
        <button
          className="btn"
          style={{
            background: showNegativePNL ? "#374151" : "#15803d",
            color: "#fff",
          }}
          onClick={() => setShowNegativePNL(!showNegativePNL)}
        >
          {showNegativePNL ? "Hide -PNL" : "Show -PNL"}
        </button>
        <span style={{ opacity: 0.8, fontSize: 12 }}>UIDs: {uidList.length}</span>
      </div>

      {aiResult && (
        <div className="card" style={{ maxWidth: 1300, marginBottom: 12, paddingLeft: 12, position: "relative" }}>
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
          <div
            className="ai-md"
            dangerouslySetInnerHTML={{ __html: marked.parse(aiResult) }}
            style={{ whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word", margin: 0 }}
          />
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{ padding: 12, borderColor: "#7a2d2d", background: "#26161a", color: "#ffb4b4", marginBottom: 12 }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>{columns.map((c) => <th key={c.header}>{c.header}</th>)}</tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.header}>{c.get(r)}</td>
                  ))}
                </tr>
              ))}
              {!sorted.length && (
                <tr>
                  <td colSpan={columns.length} style={{ opacity: 0.75, padding: 20 }}>
                    {uidLoading ? "Đang tải UIDs…" : "Chưa có dữ liệu. Hãy bấm “Refresh UIDs” hoặc chờ vòng lặp tự cập nhật."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
{success: false,…}
error
: 
"OpenAI error: {\"error\":{\"code\":\"unsupported_country_region_territory\",\"message\":\"Country, region, or territory not supported\",\"param\":null,\"type\":\"request_forbidden\"}}"
success
: 
false