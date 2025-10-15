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
const PER_REQ_DELAY_MS = Number(import.meta.env.VITE_PER_REQ_DELAY_MS || 90); // delay giữa các request
const BATCH_SIZE = Number(import.meta.env.VITE_BATCH_SIZE || 3);              // mỗi request gồm 3 UID

// ==== Tham số chọn trader từ MEXC (có thể override bằng .env) ====
const TRADERS_INTERVAL = import.meta.env.VITE_TRADERS_INTERVAL || "ALL";
const TRADERS_LIMIT = Number(import.meta.env.VITE_TRADERS_LIMIT || 150);
const TRADERS_ORDER_BY = import.meta.env.VITE_TRADERS_ORDER_BY || "ROI";
const TRADERS_PAGE = Number(import.meta.env.VITE_TRADERS_PAGE || 1);

// Xây URL gốc của MEXC theo rule bạn đã dùng trong cURL
function buildMexcTradersUrlWith(orderBy) {
  const base = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2";
  const params = new URLSearchParams({
    intervalType: TRADERS_INTERVAL,
    limit: String(TRADERS_LIMIT),
    orderBy: orderBy || TRADERS_ORDER_BY,
    page: String(TRADERS_PAGE),
  });
  return `${base}?${params.toString()}`;
}
// Endpoint proxy call qua CF Pages Functions (tránh CORS/DDoS)
function buildProxyCallUrl(callUrl) {
  const u = new URL(`${proxyBase}/api/call`);
  u.searchParams.set("callUrl", callUrl);
  return u.toString();
}

const tsVNT = (t) =>
  t ? new Date(t).toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false }).replace(",", "") : "";

const num = (x) => (typeof x === "number" ? x : Number(x || 0));
const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** ===================== API KEY (localStorage) ===================== */
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
  } catch { }
}

/** fetch JSON helper với header x-api-key tự động */
async function fetchJSON(url, params = {}, init = {}) {
  const qs = new URLSearchParams(params).toString();
  const key = getInternalApiKey();
  const headers = new Headers(init.headers || {});
  if (key) headers.set("x-api-key", key);
  // các header khác có thể để server proxy set (CORS, referer…)
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
  const lines = rows.map((r) => columns.map((c) => escapeCsv(c.get?.(r))).join(","));
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

        <label className="modal-label" htmlFor="apiKey">
          INTERNAL_API_KEY
        </label>
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
          <button className="btn btn-ghost" onClick={handleClear} title="Xóa key khỏi localStorage">
            Clear
          </button>
          <div className="modal-actions-right">
            <button className="btn btn-ghost" onClick={() => onClose?.(getInternalApiKey())}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              Save Key
            </button>
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
  const [loading, setLoading] = useState(false); // Refresh thủ công (1 pass)
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [error, setError] = useState("");
  const [aiResult, setAiResult] = useState("");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyExists, setKeyExists] = useState(false);

  // NEW: uid list động lấy từ API
  const [uidList, setUidList] = useState([]);
  const [uidLoading, setUidLoading] = useState(false);

  // id -> row
  const rowsMapRef = useRef(new Map());
  // symbol -> price
  const priceMapRef = useRef({});

  // ========== Helpers ==========
  function getRowUid(r) {
    return r?.raw?.traderUid != null ? String(r.raw.traderUid) : r?.uid != null ? String(r.uid) : "";
  }

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

  // Upsert theo id + prune theo các UID trong batch
  const upsertAndPruneBatch = (arr, batchUids) => {
    const m = rowsMapRef.current;
    const batchSet = new Set(batchUids.map(String));

    // Build mapping uid -> Set(ids) từ response
    const uidToIds = new Map();
    for (const r of Array.isArray(arr) ? arr : []) {
      const uid = getRowUid(r);
      if (!uid) continue;
      if (!uidToIds.has(uid)) uidToIds.set(uid, new Set());
      uidToIds.get(uid).add(r.id);
    }

    // PRUNE: với mọi row có UID thuộc batch nhưng id không nằm trong response uid->ids thì delete
    for (const [id, row] of m.entries()) {
      const uid = getRowUid(row);
      if (!uid || !batchSet.has(uid)) continue;
      const keepIds = uidToIds.get(uid);
      if (!keepIds || !keepIds.has(id)) {
        m.delete(id);
      }
    }

    // UPSERT: merge theo id
    for (const r of Array.isArray(arr) ? arr : []) {
      const existing = m.get(r.id);
      const merged = { ...(existing || {}), ...r };
      const enriched = enrichWithLive(merged, priceMapRef.current);
      m.set(r.id, enriched);
    }

    // Rebuild list
    setRows(Array.from(m.values()));
  };

  // Giá thị trường định kỳ
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
    } catch { }
  };

  // NEW: Lấy danh sách UIDs động qua proxy /api/call
 const refreshUIDs = async () => {
  setUidLoading(true);
  setError("");
  try {
    // Call theo orderBy đang cấu hình (VD: ROI)
    const urlPrimary = buildMexcTradersUrlWith(TRADERS_ORDER_BY);
    const proxyPrimary = buildProxyCallUrl(urlPrimary);
    const respPrimary = await fetchJSON(proxyPrimary, {});
    const listPrimary =
      (respPrimary?.data?.content || respPrimary?.content || [])
        .map((it) => String(it?.uid))
        .filter(Boolean);

    // Call thêm orderBy=PNL
    const urlPnl = buildMexcTradersUrlWith("PNL");
    const proxyPnl = buildProxyCallUrl(urlPnl);
    const respPnl = await fetchJSON(proxyPnl, {});
    const listPnl =
      (respPnl?.data?.content || respPnl?.content || [])
        .map((it) => String(it?.uid))
        .filter(Boolean);

    // Gộp & loại trùng
    const merged = Array.from(new Set([...(listPrimary || []), ...(listPnl || [])]));

    if (!merged.length) {
      throw new Error("Không lấy được UID từ traders API (primary + PNL).");
    }

    setUidList(merged);
  } catch (e) {
    setError(`Get UIDs error: ${e?.message || String(e)}`);
  } finally {
    setUidLoading(false);
  }
};



  // Vòng lặp vô tận: duyệt các batch (mỗi batch 3 UID) dựa trên uidList động
  useEffect(() => {
    let cancelled = false;

    const startLoop = async () => {
      const has = !!getInternalApiKey();
      setKeyExists(has);
      if (!has) setShowKeyModal(true);

      // Lấy UIDs lúc khởi động (nếu chưa có)
      if (!uidList.length) {
        await refreshUIDs();
      }

      while (!cancelled) {
        const list = uidList.length ? uidList : [];
        if (list.length === 0) {
          // Nếu chưa có UIDs, đợi một chút rồi thử lại
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
        // hết vòng batches -> lặp lại; không auto đổi UIDs ở đây để tránh nhiễu
      }
    };

    startLoop();
    return () => {
      cancelled = true;
    };
    // chỉ re-run khi uidList thay đổi (để vòng lặp đọc danh sách mới)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidList]);

  // Refresh giá theo chu kỳ
  useEffect(() => {
    const id = setInterval(refreshPrices, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Refresh 1 pass toàn bộ bằng batch hiện tại
  const loadOnceAll = async () => {
    setLoading(true);
    setError("");
    try {
      const list = uidList.length ? uidList : [];
      if (!list.length) {
        await refreshUIDs();
      }
      const list2 = uidList.length ? uidList : [];
      const batches = chunk(list2, BATCH_SIZE);
      for (const batch of batches) {
        const uidsParam = batch.join(",");
        const data = await fetchJSON(ORDERS_API, { uids: uidsParam });
        if (data?.success) {
          upsertAndPruneBatch(Array.isArray(data.data) ? data.data : [], batch);
        }
        await sleep(PER_REQ_DELAY_MS);
      }
      await refreshPrices();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

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

  // Sort mới -> cũ theo openAt
  const sorted = useMemo(() => [...rows].sort((a, b) => (Number(b.openAt) || 0) - (Number(a.openAt) || 0)), [rows]);

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

        <button className="btn" onClick={loadOnceAll} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>

        {/* NEW: nút refresh UIDs động */}
        <button className="btn" onClick={refreshUIDs} disabled={uidLoading}>
          {uidLoading ? "Fetching UIDs…" : "Refresh UIDs"}
        </button>

        {/* hiển thị số lượng UID hiện có */}
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
              {!sorted.length && (
                <tr>
                  <td colSpan={columns.length} style={{ opacity: 0.75, padding: 20 }}>
                    {uidLoading ? "Đang tải UIDs…" : "Chưa có dữ liệu. Hãy bấm “Refresh UIDs” hoặc “Refresh”."}
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
