import React, { useEffect, useRef, useState, useCallback } from 'react';

// ─── API base URL ────────────────────────────────────────────────────────────
// In production (npm run build) set REACT_APP_API_URL in .env.production.
// In development the CRA proxy (package.json "proxy") forwards /api calls,
// so we use an empty string and rely on relative paths.
const API = process.env.REACT_APP_API_URL || 'http://127.0.0.1:8000';

// ─── helpers ────────────────────────────────────────────────────────────────

const fmt = {
  dollar: v => v != null ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—',
  collat: v => v != null ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—',
  pct2:   v => v != null ? `${Number(v).toFixed(2)}%` : '—',
  pct1:   v => v != null ? `${Number(v).toFixed(1)}%` : '—',
  num:    v => v != null ? String(v) : '—',
};

function chevron(dir) { return dir === 'asc' ? ' ▲' : ' ▼'; }

function formatExp(exp) {
  // "2025-07-17" → "Jul 17"
  if (!exp) return '—';
  const d = new Date(exp + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// hue 0=red → 60=yellow → 120=green, dark-theme saturation/lightness
function heatColor(normalized, exceedsCap) {
  if (exceedsCap) return 'hsl(0,0%,11%)';
  const hue = Math.round(normalized * 120);
  return `hsl(${hue},60%,21%)`;
}

// ─── shared sub-components ───────────────────────────────────────────────────

function Spinner({ label = 'Scanning…' }) {
  return (
    <div className="flex items-center gap-2 text-indigo-400 text-sm">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
      {label}
    </div>
  );
}

function SortableTh({ col, label, sortKey, sortDir, onSort }) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap
        ${active ? 'text-indigo-300' : 'text-gray-400'} hover:text-indigo-200`}
    >
      {label}{active ? chevron(sortDir) : ''}
    </th>
  );
}

// ─── contract card (Watchlist tab) ──────────────────────────────────────────

function ContractCard({ result, onClose }) {
  if (!result) return null;
  const { symbol, price, iv30, earningsDate, contract: c, error, errorMessage, dataSource, schwabError } = result;
  return (
    <div className="mt-4 bg-gray-800 border border-gray-700 rounded-xl p-4 relative">
      <button onClick={onClose}
        className="absolute top-3 right-3 text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
      {error ? (
        <p className="text-red-400 text-sm">{symbol}: {errorMessage || 'Error fetching data'}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-3 mb-3">
            <span className="font-mono font-bold text-white text-lg">{symbol}</span>
            <span className="font-mono text-gray-400 text-sm">{fmt.dollar(price)}</span>
            {iv30 != null && <span className="text-xs text-gray-500">IV30 {fmt.pct1(iv30)}</span>}
            {earningsDate && <span className="text-xs text-gray-500">Earnings {earningsDate}</span>}
            <SourceBadge source={dataSource} error={schwabError} />
          </div>
          {c ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Strike', fmt.dollar(c.strike)], ['Expiration', c.expiration ?? '—'],
                ['DTE', fmt.num(c.dte)],          ['Premium', fmt.dollar(c.mid)],
                ['Collateral', fmt.collat(c.collateralRequired)],
                ['ROC', fmt.pct2(c.roc)],          ['Ann ROC', fmt.pct1(c.rocAnnualized)],
                ['IV', fmt.pct1(c.impliedVolatility)],
              ].map(([label, val]) => (
                <div key={label} className="bg-gray-900 rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
                  <div className="font-mono text-indigo-300 text-sm mt-0.5">{val}</div>
                </div>
              ))}
              {c.exceedsCollateralCap && <div className="col-span-full text-xs text-yellow-400 mt-1">⚠️ Exceeds collateral cap</div>}
              {c.earningsInWindow    && <div className="col-span-full text-xs text-orange-400 mt-1">⚠ Earnings fall within expiration window</div>}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No qualifying contract found.</p>
          )}
        </>
      )}
    </div>
  );
}

function SourceBadge({ source, error }) {
  if (!source) return null;
  const live = source === 'schwab';
  return (
    <span title={live ? 'Option chain from Schwab' : `Schwab unavailable — using yfinance${error ? `: ${error}` : ''}`}
      className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${live ? 'bg-green-900/60 text-green-300' : 'bg-amber-900/60 text-amber-300'}`}>
      {live ? 'Schwab' : 'yfinance'}
    </span>
  );
}

function CoveredCallCard({ result, onClose }) {
  if (!result) return null;
  const { symbol, price, costBasis, shares, unrealizedPnlPct, iv30, earningsDate, contract: c, error, errorMessage, dataSource, schwabError } = result;
  return (
    <div className="mt-4 bg-gray-800 border border-gray-700 rounded-xl p-4 relative">
      <button onClick={onClose}
        className="absolute top-3 right-3 text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
      {error ? (
        <p className="text-red-400 text-sm">{symbol}: {errorMessage || 'Error fetching data'}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-3 mb-1">
            <span className="font-mono font-bold text-white text-lg">{symbol}</span>
            <span className="font-mono text-gray-400 text-sm">{fmt.dollar(price)}</span>
            {iv30 != null && <span className="text-xs text-gray-500">IV30 {fmt.pct1(iv30)}</span>}
            {earningsDate && <span className="text-xs text-gray-500">Earnings {earningsDate}</span>}
            <SourceBadge source={dataSource} error={schwabError} />
          </div>
          <div className="flex items-baseline gap-3 mb-3 text-xs text-gray-500">
            <span>Basis {fmt.dollar(costBasis)}</span>
            <span>{shares} sh</span>
            {unrealizedPnlPct != null && (
              <span className={unrealizedPnlPct >= 0 ? 'text-green-400' : 'text-red-400'}>
                {unrealizedPnlPct >= 0 ? '+' : ''}{unrealizedPnlPct.toFixed(1)}% unrealized
              </span>
            )}
          </div>
          {c ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Strike', fmt.dollar(c.strike)], ['Expiration', c.expiration ?? '—'],
                ['DTE', fmt.num(c.dte)],          ['Premium', fmt.dollar(c.mid)],
                ['Premium Total', fmt.dollar(c.premiumTotal)],
                ['ROC (on basis)', fmt.pct2(c.roc)], ['Ann ROC', fmt.pct1(c.rocAnnualized)],
                ['If Called', fmt.pct2(c.totalReturnIfCalledPct)],
              ].map(([label, val]) => (
                <div key={label} className="bg-gray-900 rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
                  <div className="font-mono text-indigo-300 text-sm mt-0.5">{val}</div>
                </div>
              ))}
              {c.belowCostBasis   && <div className="col-span-full text-xs text-red-400 mt-1">⚠️ Strike is below your cost basis — assignment would realize a loss on shares</div>}
              {c.lowOpenInterest  && <div className="col-span-full text-xs text-yellow-400 mt-1">⚠️ Low open interest</div>}
              {c.earningsInWindow && <div className="col-span-full text-xs text-orange-400 mt-1">⚠ Earnings fall within expiration window</div>}
              {c.staleQuote       && <div className="col-span-full text-xs text-gray-400 mt-1">Premium is last/closing price — no live bid/ask (market closed)</div>}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No qualifying contract found{costBasis ? ' at or above cost basis' : ''}.</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── HEATMAP PANEL ───────────────────────────────────────────────────────────

const HEATMAP_METRICS = [
  { key: 'roc',              label: 'ROC %',     fmt: v => `${v.toFixed(2)}%` },
  { key: 'rocAnnualized',    label: 'Ann ROC %', fmt: v => `${v.toFixed(1)}%` },
  { key: 'mid',              label: 'Premium',   fmt: v => `$${v.toFixed(2)}`  },
  { key: 'impliedVolatility',label: 'IV',        fmt: v => `${v.toFixed(0)}%` },
];

const CC_HEATMAP_METRICS = [
  { key: 'roc',                    label: 'ROC %',     fmt: v => `${v.toFixed(2)}%` },
  { key: 'rocAnnualized',          label: 'Ann ROC %', fmt: v => `${v.toFixed(1)}%` },
  { key: 'mid',                    label: 'Premium',   fmt: v => `$${v.toFixed(2)}`  },
  { key: 'totalReturnIfCalledPct', label: 'If Called', fmt: v => `${v.toFixed(1)}%` },
];

// left-border accent colors for pinned cards (index 0-3)
const PIN_COLORS = [
  { border: '#6366f1', label: 'indigo' },
  { border: '#22c55e', label: 'green'  },
  { border: '#eab308', label: 'yellow' },
  { border: '#ef4444', label: 'red'    },
];

// fields shown in a contract detail card
const DETAIL_FIELDS = [
  { key: 'dte',              label: 'DTE',        render: c => fmt.num(c.dte)                  },
  { key: 'mid',              label: 'Premium',    render: c => fmt.dollar(c.mid)               },
  { key: 'roc',              label: 'ROC %',      render: c => fmt.pct2(c.roc)                 },
  { key: 'rocAnnualized',    label: 'Ann ROC %',  render: c => fmt.pct1(c.rocAnnualized)       },
  { key: 'impliedVolatility',label: 'IV',         render: c => fmt.pct1(c.impliedVolatility)   },
  { key: 'collateralRequired',label:'Collateral', render: c => fmt.collat(c.collateralRequired)},
  { key: 'delta',            label: 'Delta',      render: c => c.delta != null ? c.delta.toFixed(3) : '—' },
];

const CC_DETAIL_FIELDS = [
  { key: 'dte',                    label: 'DTE',         render: c => fmt.num(c.dte)               },
  { key: 'mid',                    label: 'Premium',     render: c => fmt.dollar(c.mid)            },
  { key: 'roc',                    label: 'ROC (basis)', render: c => fmt.pct2(c.roc)              },
  { key: 'rocAnnualized',          label: 'Ann ROC %',   render: c => fmt.pct1(c.rocAnnualized)    },
  { key: 'totalReturnIfCalledPct', label: 'If Called',   render: c => fmt.pct2(c.totalReturnIfCalledPct) },
  { key: 'impliedVolatility',      label: 'IV',          render: c => fmt.pct1(c.impliedVolatility)},
  { key: 'delta',                  label: 'Delta',       render: c => c.delta != null ? c.delta.toFixed(3) : '—' },
];

// for the comparison summary: higher = better for all four
const CMP_FIELDS = ['roc','rocAnnualized','mid','impliedVolatility'];
const CMP_LABELS = { roc:'ROC %', rocAnnualized:'Ann ROC', mid:'Premium', impliedVolatility:'IV' };

function ContractDetailCard({ symbol, contract: c, accentColor, onClear, onPin, isPinned, showPinButton, fields = DETAIL_FIELDS }) {
  if (!c) return null;
  return (
    <div className="rounded-lg overflow-hidden border border-gray-700" style={{ borderLeftColor: accentColor, borderLeftWidth: 3 }}>
      {/* card header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold text-white text-sm">{symbol}</span>
          <span className="font-mono text-gray-300 text-xs">${c.strike % 1 === 0 ? c.strike.toFixed(0) : c.strike.toFixed(1)}</span>
          <span className="font-mono text-gray-500 text-xs">{formatExp(c.expiration)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {showPinButton && !isPinned && (
            <button onClick={onPin}
              className="text-[10px] px-2 py-0.5 rounded bg-gray-700 hover:bg-indigo-700 text-gray-300 hover:text-white transition-colors">
              Pin
            </button>
          )}
          {onClear && (
            <button onClick={onClear}
              className="text-gray-600 hover:text-gray-300 text-sm leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-gray-700 transition-colors">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* fields grid */}
      <div className="grid grid-cols-2 gap-px bg-gray-800 p-2.5 pt-2">
        {fields.map(({ key, label, render }) => (
          <div key={key} className="flex justify-between items-baseline px-1 py-0.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
            <span className="font-mono text-xs text-gray-200">{render(c)}</span>
          </div>
        ))}
      </div>

      {/* warnings */}
      {(c.exceedsCollateralCap || c.belowCostBasis || c.earningsInWindow) && (
        <div className="px-3 pb-2 flex flex-col gap-0.5">
          {c.exceedsCollateralCap && <span className="text-[10px] text-yellow-400">⚠️ Exceeds collateral cap</span>}
          {c.belowCostBasis       && <span className="text-[10px] text-red-400">⚠️ Below cost basis</span>}
          {c.earningsInWindow     && <span className="text-[10px] text-orange-400">⚠ Earnings in window</span>}
        </div>
      )}
    </div>
  );
}

function ComparisonSummary({ pinnedContracts }) {
  if (pinnedContracts.length < 2) return null;
  return (
    <div className="mt-2 rounded-lg border border-gray-700 overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-800 text-[10px] uppercase tracking-wide text-gray-500">Best values</div>
      <div className="p-2 bg-gray-850 grid grid-cols-2 gap-px">
        {CMP_FIELDS.map(key => {
          const vals = pinnedContracts.map(c => c[key]).filter(v => v != null);
          if (!vals.length) return null;
          const best = Math.max(...vals);
          return (
            <div key={key} className="flex justify-between items-baseline px-1 py-0.5">
              <span className="text-[10px] text-gray-500">{CMP_LABELS[key]}</span>
              <div className="flex gap-1">
                {pinnedContracts.map((c, i) => {
                  const v = c[key];
                  const isBest = v != null && Math.abs(v - best) < 0.0001;
                  const color = PIN_COLORS[i % PIN_COLORS.length].border;
                  return (
                    <span key={i}
                      style={{ color: isBest ? '#4ade80' : '#6b7280', borderBottom: `1.5px solid ${color}` }}
                      className="font-mono text-[10px] pb-px">
                      {v != null ? (key === 'mid' ? `$${v.toFixed(2)}` : key === 'impliedVolatility' ? `${v.toFixed(0)}%` : `${v.toFixed(1)}%`) : '—'}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HeatmapPanel({
  symbol,
  recommendedContract,
  fetchUrl = null,
  metrics = HEATMAP_METRICS,
  detailFields = DETAIL_FIELDS,
  capFlagKey = 'exceedsCollateralCap',
  capLabel = 'exceeds cap',
  title = 'Options Heatmap',
}) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [fetchErr,   setFetchErr]   = useState(null);
  const [metric,     setMetric]     = useState('roc');
  const [activeCell, setActiveCell] = useState(null);   // currently selected cell
  const [pinned,     setPinned]     = useState([]);     // array of contract objects, max 4
  const panelRef    = useRef(null);
  const rightRef    = useRef(null);

  // scroll panel into view when it mounts
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchErr(null);
    setData(null);
    setActiveCell(null);
    setPinned([]);
    fetch(fetchUrl || `${API}/heatmap/${symbol}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d  => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setFetchErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, fetchUrl]);

  // scroll right panel back to top when active cell changes
  useEffect(() => {
    if (rightRef.current) rightRef.current.scrollTop = 0;
  }, [activeCell]);

  function pinContract(c) {
    if (pinned.length >= 4) return;
    const already = pinned.some(p => p.strike === c.strike && p.expiration === c.expiration);
    if (!already) setPinned(prev => [...prev, c]);
  }

  function unpinContract(c) {
    setPinned(prev => prev.filter(p => !(p.strike === c.strike && p.expiration === c.expiration)));
  }

  if (loading) return (
    <div className="bg-gray-900 border-t border-gray-800 p-5"><Spinner label="Loading heatmap…" /></div>
  );
  if (fetchErr) return (
    <div className="bg-gray-900 border-t border-gray-800 p-5 text-red-400 text-sm">Error: {fetchErr}</div>
  );
  if (!data || !data.contracts.length) return (
    <div className="bg-gray-900 border-t border-gray-800 p-5 text-gray-500 text-sm">No options data in 7–60 DTE range.</div>
  );

  const contracts  = data.contracts;
  const strikes    = [...new Set(contracts.map(c => c.strike))].sort((a, b) => b - a);
  const expirations = [...new Set(contracts.map(c => c.expiration))].sort();

  const lookup = {};
  for (const c of contracts) lookup[`${c.strike}|${c.expiration}`] = c;

  // find the strike closest to current price for the ATM marker
  const atmStrike = data.price != null
    ? strikes.reduce((best, s) => Math.abs(s - data.price) < Math.abs(best - data.price) ? s : best, strikes[0])
    : null;

  const metricDef = metrics.find(m => m.key === metric) || metrics[0];
  const allVals   = contracts.map(c => c[metric]).filter(v => v != null && isFinite(v));
  const minVal    = Math.min(...allVals);
  const maxVal    = Math.max(...allVals);
  const valRange  = maxVal - minVal || 1;

  function normalize(v) { return (v - minVal) / valRange; }

  function isRec(c) {
    return recommendedContract &&
      c.strike === recommendedContract.strike &&
      c.expiration === recommendedContract.expiration;
  }

  function isCellActive(c) {
    return activeCell && c.strike === activeCell.strike && c.expiration === activeCell.expiration;
  }

  function isPinned(c) {
    return pinned.some(p => p.strike === c.strike && p.expiration === c.expiration);
  }

  function toggleCell(c) {
    setActiveCell(prev =>
      prev && prev.strike === c.strike && prev.expiration === c.expiration ? null : c
    );
  }

  return (
    <div ref={panelRef} className="bg-gray-900 border-t-2 border-indigo-800">

      {/* ── header bar ── */}
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3 pb-2 border-b border-gray-800">
        <span className="font-mono font-bold text-white">{symbol}</span>
        {data.price != null && <span className="font-mono text-gray-400 text-sm">${data.price.toFixed(2)}</span>}
        <span className="text-gray-600 text-xs">{title} · DTE 7–60</span>
        <SourceBadge source={data.dataSource} error={data.schwabError} />
        <div className="ml-auto flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
          {metrics.map(m => (
            <button key={m.key} onClick={() => { setMetric(m.key); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors
                ${metric === m.key ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── body: grid (65%) + right panel (35%) ── */}
      <div className="flex" style={{ minHeight: 200 }}>

        {/* ── LEFT: grid ── */}
        <div className="flex flex-col" style={{ flex: '0 0 65%', minWidth: 0 }}>
          <div className="overflow-auto flex-1 p-3">
            <table className="border-collapse text-xs select-none" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-gray-900 w-16 px-2 py-1.5 text-right text-gray-600 font-normal">Strike</th>
                  {expirations.map(exp => {
                    const sample = contracts.find(c => c.expiration === exp);
                    return (
                      <th key={exp} className="w-16 px-1 py-1.5 text-center text-gray-500 font-normal whitespace-nowrap">
                        {formatExp(exp)}
                        <div className="text-[9px] text-gray-700">{sample ? `${sample.dte}d` : ''}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {strikes.map(strike => {
                  const isAtm = atmStrike != null && strike === atmStrike;
                  return (
                  <tr key={strike} style={isAtm ? { borderLeft: '2px solid #6366f1' } : { borderLeft: '2px solid transparent' }}>
                    <td className="sticky left-0 z-10 bg-gray-900 px-2 py-px text-right font-mono text-gray-400">
                      <span className={isAtm ? 'text-indigo-300' : ''}>
                        ${strike % 1 === 0 ? strike.toFixed(0) : strike.toFixed(1)}
                      </span>
                      {isAtm && <span className="ml-1 text-[9px] text-gray-600 font-sans">ATM</span>}
                    </td>
                    {expirations.map(exp => {
                      const c = lookup[`${strike}|${exp}`];
                      if (!c) return (
                        <td key={exp} className="px-1 py-px">
                          <div className="w-full h-7 rounded-sm" style={{ backgroundColor: 'hsl(0,0%,9%)' }} />
                        </td>
                      );
                      const v          = c[metric];
                      const norm       = v != null ? normalize(v) : 0;
                      const capFlag    = c[capFlagKey];
                      const bg         = heatColor(norm, capFlag);
                      const rec        = isRec(c);
                      const cellActive = isCellActive(c);
                      const pinned_c   = isPinned(c);
                      const textColor  = capFlag ? '#4b5563' : '#f3f4f6';
                      const outlineCol = rec ? 'rgba(255,255,255,0.85)'
                                       : cellActive ? 'rgba(99,102,241,0.95)'
                                       : pinned_c   ? 'rgba(34,197,94,0.7)'
                                       : 'none';
                      return (
                        <td key={exp} className="px-1 py-px">
                          <div
                            onClick={() => toggleCell(c)}
                            style={{
                              backgroundColor: bg, color: textColor,
                              outline: outlineCol !== 'none' ? `1.5px solid ${outlineCol}` : 'none',
                              outlineOffset: '-1px',
                              filter: cellActive ? 'brightness(1.3)' : undefined,
                            }}
                            className="w-full h-7 rounded-sm flex items-center justify-center cursor-pointer hover:brightness-125 transition-all relative"
                            title={`${symbol} $${strike} ${formatExp(exp)} · ${v != null ? metricDef.fmt(v) : '—'}`}
                          >
                            <span className="font-mono text-[10px] leading-none">
                              {v != null ? metricDef.fmt(v) : ''}
                            </span>
                            {c.earningsInWindow && (
                              <span className="absolute top-0 right-0.5 text-orange-400 text-[8px] leading-none">⚠</span>
                            )}
                            {pinned_c && (
                              <span className="absolute bottom-0 left-0.5 text-green-400 text-[8px] leading-none">●</span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* legend */}
          <div className="flex items-center gap-2 px-4 pb-3 pt-1 text-[10px] text-gray-600 border-t border-gray-800/60">
            <span>Low</span>
            <div className="flex h-2 w-20 rounded overflow-hidden">
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} style={{ flex: 1, backgroundColor: `hsl(${Math.round(i / 19 * 120)},60%,21%)` }} />
              ))}
            </div>
            <span>High</span>
            <span className="mx-2 text-gray-800">│</span>
            <span style={{ outline: '1.5px solid rgba(255,255,255,0.8)', display: 'inline-block', width: 10, height: 10, borderRadius: 1 }} />
            <span className="ml-1">recommended</span>
            <span className="mx-2 text-gray-800">│</span>
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: 'hsl(0,0%,11%)' }} />
            <span className="ml-1">{capLabel}</span>
            <span className="mx-2 text-gray-800">│</span>
            <span className="text-orange-400 text-xs">⚠</span>
            <span className="ml-0.5">earnings</span>
            <span className="mx-2 text-gray-800">│</span>
            <span className="text-green-400 text-xs">●</span>
            <span className="ml-0.5">pinned</span>
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div
          ref={rightRef}
          className="border-l border-gray-800 overflow-y-auto"
          style={{ flex: '0 0 35%', maxHeight: 520 }}
        >
          <div className="p-3 flex flex-col gap-3">

            {/* ── Screener Pick (always present, cannot be removed) ── */}
            {recommendedContract ? (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-0.5 flex items-center gap-1.5">
                  <span>📌 Screener Pick</span>
                </div>
                <ContractDetailCard
                  symbol={symbol}
                  contract={recommendedContract}
                  accentColor="#ffffff"
                  showPinButton={false}
                  isPinned={false}
                  onClear={null}
                  fields={detailFields}
                />
              </div>
            ) : (
              <div className="px-0.5">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">📌 Screener Pick</div>
                <p className="text-xs text-gray-600">No contract recommended under current config.</p>
              </div>
            )}

            {/* ── divider ── */}
            <div className="border-t border-gray-800" />

            {/* ── Selected cell ── */}
            {activeCell ? (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-0.5">Selected</div>
                <ContractDetailCard
                  symbol={symbol}
                  contract={activeCell}
                  accentColor="#6366f1"
                  showPinButton={pinned.length < 4}
                  isPinned={isPinned(activeCell)}
                  onPin={() => pinContract(activeCell)}
                  onClear={() => setActiveCell(null)}
                  fields={detailFields}
                />
              </div>
            ) : (
              <p className="text-xs text-gray-600 px-0.5">Click a cell to see contract details</p>
            )}

            {/* ── Pinned comparison cards ── */}
            {pinned.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-0.5 flex items-center justify-between">
                  <span>Pinned ({pinned.length}/4)</span>
                  {pinned.length > 1 && (
                    <button onClick={() => setPinned([])}
                      className="text-gray-600 hover:text-gray-400 text-[10px] transition-colors">
                      Clear all
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {pinned.map((c, i) => (
                    <ContractDetailCard
                      key={`${c.strike}|${c.expiration}`}
                      symbol={symbol}
                      contract={c}
                      accentColor={PIN_COLORS[i % PIN_COLORS.length].border}
                      showPinButton={false}
                      isPinned={true}
                      onClear={() => unpinContract(c)}
                      fields={detailFields}
                    />
                  ))}
                </div>
                <ComparisonSummary pinnedContracts={pinned} />
              </div>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}

// ─── AI COUNCIL ──────────────────────────────────────────────────────────────
// Streams POST /council/{symbol} (Server-Sent Events): context → 3 opinions as
// each model finishes → synthesis (disagreement map) → done (cost).

const COUNCIL_MODELS = [
  { key: 'claude', label: 'Claude', color: 'text-orange-300', border: 'border-orange-800/60' },
  { key: 'openai', label: 'GPT',    color: 'text-emerald-300', border: 'border-emerald-800/60' },
  { key: 'gemini', label: 'Gemini', color: 'text-sky-300',     border: 'border-sky-800/60' },
];
const COUNCIL_LABEL = Object.fromEntries(COUNCIL_MODELS.map(m => [m.key, m.label]));
const VERDICT_STYLE = {
  sell_put: 'bg-green-900/60 text-green-300',
  wait:     'bg-yellow-900/60 text-yellow-300',
  pass:     'bg-red-900/60 text-red-300',
};

async function streamCouncil(symbol, body, onEvent, signal) {
  const res = await fetch(`${API}/council/${symbol}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

function Score({ label, value }) {
  const cls = value == null ? 'text-gray-500' : value >= 7 ? 'text-green-400' : value >= 5 ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className="bg-gray-900 rounded px-2 py-1">
      <div className="text-[9px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`font-mono text-sm ${cls}`}>{value ?? '—'}{value != null && <span className="text-gray-600">/10</span>}</div>
    </div>
  );
}

function OpinionCard({ meta, op }) {
  const r = op?.result;
  return (
    <div className={`bg-gray-800/70 border ${meta.border} rounded-xl p-3 flex flex-col gap-2 min-w-0`}>
      <div className="flex items-center gap-2">
        <span className={`font-semibold ${meta.color}`}>{meta.label}</span>
        {op?.model && <span className="text-[10px] text-gray-500 font-mono truncate">{op.model}</span>}
        {r?.verdict && (
          <span className={`ml-auto text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${VERDICT_STYLE[r.verdict] || 'bg-gray-700 text-gray-300'}`}>
            {String(r.verdict).replace('_', ' ')}
          </span>
        )}
      </div>

      {!op && <Spinner label="Thinking…" />}
      {op?.error && <p className={`text-xs ${op.skipped ? 'text-gray-500' : 'text-red-400'}`}>{op.error}</p>}

      {r && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <Score label="Conviction" value={r.conviction} />
            <Score label="Own it?" value={r.assignment_comfort} />
            <div className="bg-gray-900 rounded px-2 py-1">
              <div className="text-[9px] uppercase tracking-wide text-gray-500">Floor</div>
              <div className="font-mono text-sm text-indigo-300">{fmt.dollar(r.fair_value_floor)}</div>
            </div>
          </div>
          {r.floor_reasoning && <p className="text-xs text-gray-400">{r.floor_reasoning}</p>}
          <div className="text-xs">
            <div className="text-green-400/80 font-semibold mb-0.5">Bull</div>
            <ul className="list-disc pl-4 text-gray-300 space-y-0.5">{(r.bull_case || []).map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
          <div className="text-xs">
            <div className="text-red-400/80 font-semibold mb-0.5">Bear</div>
            <ul className="list-disc pl-4 text-gray-300 space-y-0.5">{(r.bear_case || []).map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
          {r.key_risk && <p className="text-xs text-orange-300"><span className="font-semibold">Key risk:</span> {r.key_risk}</p>}
          {r.better_strike != null && <p className="text-xs text-gray-400">Would prefer strike <span className="font-mono text-indigo-300">{fmt.dollar(r.better_strike)}</span></p>}
          {r.stale_knowledge_flags?.length > 0 && (
            <p className="text-[11px] text-amber-400/80">⚠ From memory, may be stale: {r.stale_knowledge_flags.join('; ')}</p>
          )}
          <div className="text-[10px] text-gray-600 font-mono mt-auto">
            {op.seconds}s · {op.tokensIn}→{op.tokensOut} tok · {op.costUSD != null ? `$${op.costUSD.toFixed(4)}` : 'cost ?'}
          </div>
        </>
      )}
    </div>
  );
}

function SynthesisBlock({ syn }) {
  if (!syn) return null;
  const s = syn.spread || {};
  const m = syn.map;
  const range = (x, money) => x ? `${money ? fmt.dollar(x.min) : x.min} – ${money ? fmt.dollar(x.max) : x.max}` : '—';
  return (
    <div className="bg-indigo-950/30 border border-indigo-800/50 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-indigo-300">Where they disagree</span>
        {s.unanimous && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-gray-700 text-gray-300" title="Models trained on similar data often share blind spots">unanimous — weak evidence</span>}
        {syn.model && <span className="ml-auto text-[10px] text-gray-500 font-mono">referee: {syn.model}</span>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="bg-gray-900 rounded px-2 py-1.5"><div className="text-[9px] uppercase text-gray-500">Conviction range</div><div className="font-mono text-gray-200">{range(s.conviction)}</div></div>
        <div className="bg-gray-900 rounded px-2 py-1.5"><div className="text-[9px] uppercase text-gray-500">Own-it range</div><div className="font-mono text-gray-200">{range(s.assignmentComfort)}</div></div>
        <div className="bg-gray-900 rounded px-2 py-1.5"><div className="text-[9px] uppercase text-gray-500">Floor range</div><div className="font-mono text-gray-200">{range(s.floor, true)}</div></div>
        <div className="bg-gray-900 rounded px-2 py-1.5" title="Negative = model's floor is below your breakeven">
          <div className="text-[9px] uppercase text-gray-500">Floor vs breakeven</div>
          <div className="font-mono">
            {Object.entries(s.floorVsBreakevenPct || {}).map(([k, v]) => (
              <span key={k} className={`mr-2 ${v < 0 ? 'text-red-400' : 'text-green-400'}`}>{COUNCIL_LABEL[k] || k} {v > 0 ? '+' : ''}{v}%</span>
            ))}
          </div>
        </div>
      </div>

      {syn.error && <p className="text-xs text-red-400">{syn.error}</p>}

      {m && (
        <>
          {m.question_to_resolve && (
            <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2 text-sm text-amber-200">
              <span className="font-semibold">Check before trading:</span> {m.question_to_resolve}
            </div>
          )}
          {(m.disagreements || []).map((d, i) => (
            <div key={i} className="text-xs">
              <div className="font-semibold text-gray-200">{d.topic}</div>
              <div className="flex flex-col gap-0.5 mt-0.5">
                {Object.entries(d.positions || {}).map(([k, v]) => (
                  <div key={k}><span className="text-gray-500 font-semibold">{COUNCIL_LABEL[k] || k}:</span> <span className="text-gray-300">{v}</span></div>
                ))}
              </div>
              {d.why_it_matters && <div className="text-gray-500 italic mt-0.5">{d.why_it_matters}</div>}
            </div>
          ))}
          {m.consensus?.length > 0 && (
            <div className="text-xs"><span className="font-semibold text-gray-400">Agree on:</span> <span className="text-gray-400">{m.consensus.join(' · ')}</span></div>
          )}
          {m.unverified_claims?.length > 0 && (
            <div className="text-xs">
              <div className="font-semibold text-amber-400/90 mb-0.5">Verify these</div>
              <ul className="list-disc pl-4 text-gray-400 space-y-0.5">
                {m.unverified_claims.map((u, i) => (
                  <li key={i}>{u.claim} <span className="text-gray-600">({(u.from || []).map(k => COUNCIL_LABEL[k] || k).join(', ')})</span>{u.check && <span className="text-gray-500"> — {u.check}</span>}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CouncilPanel({ symbol, contract, onClose }) {
  const [ctx,       setCtx]       = useState(null);
  const [opinions,  setOpinions]  = useState({});
  const [synthesis, setSynthesis] = useState(null);
  const [done,      setDone]      = useState(null);
  const [err,       setErr]       = useState(null);
  const [running,   setRunning]   = useState(false);
  const ctrlRef = useRef(null);

  const run = useCallback(async (force = false) => {
    if (ctrlRef.current) ctrlRef.current.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setCtx(null); setOpinions({}); setSynthesis(null); setDone(null); setErr(null); setRunning(true);
    try {
      await streamCouncil(symbol, { contract, force }, (event, data) => {
        if (event === 'context')   setCtx(data);
        if (event === 'opinion')   setOpinions(prev => ({ ...prev, [data.provider]: data }));
        if (event === 'synthesis') setSynthesis(data);
        if (event === 'done')      { setDone(data); window.dispatchEvent(new Event('council-done')); }
        if (event === 'error')     setErr(data.message);
      }, ctrl.signal);
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setRunning(false);
    }
  }, [symbol, contract]);

  useEffect(() => { run(false); return () => ctrlRef.current?.abort(); }, [run]);

  const c = ctx?.contract || contract;
  const d = ctx?.derived || {};
  return (
    <div className="bg-gray-900/80 px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-white">AI Council</span>
        <span className="font-mono text-sm text-gray-300">
          {symbol} {c ? `${fmt.dollar(c.strike)}P ${formatExp(c.expiration)}` : ''}
        </span>
        {d.breakeven != null && (
          <span className="text-xs text-gray-500">breakeven <span className="font-mono text-gray-300">{fmt.dollar(d.breakeven)}</span> ({d.breakevenDiscountPct}% below spot)</span>
        )}
        {ctx?.existingPosition && (
          <span className="text-xs text-amber-400">already own {ctx.existingPosition.shares} @ {fmt.dollar(ctx.existingPosition.costBasis)}</span>
        )}
        {ctx && <SourceBadge source={ctx.dataSource} />}
        <div className="ml-auto flex items-center gap-2">
          {done && (
            <span className="text-[11px] text-gray-500 font-mono">
              {done.cached ? 'cached today · $0' : `run $${done.runCostUSD.toFixed(3)}`} · month ${done.monthSpendUSD?.toFixed(2)} / ${done.capUSD}
            </span>
          )}
          <button disabled={running} onClick={() => run(true)}
            className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200"
            title="Ignore today's cache and pay for a fresh run">↻ Re-run</button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}
      {!ctx && !err && running && <Spinner label="Pulling live data…" />}

      {ctx && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {COUNCIL_MODELS.map(m => <OpinionCard key={m.key} meta={m} op={opinions[m.key]} />)}
          </div>
          {synthesis
            ? <SynthesisBlock syn={synthesis} />
            : running && Object.keys(opinions).length === COUNCIL_MODELS.length && <Spinner label="Mapping disagreements…" />}
        </>
      )}
      <p className="text-[10px] text-gray-600">Model opinions, not advice. Agreement between models is weak evidence — they share training data and blind spots.</p>
    </div>
  );
}

// Month-to-date AI spend badge (top bar). Refreshes on load and after each council run.
function CouncilSpend() {
  const [u,    setU]    = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    fetch(`${API}/council/usage`).then(r => r.ok ? r.json() : null).then(setU).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('council-done', load);
    return () => window.removeEventListener('council-done', load);
  }, [load]);

  if (!u) return null;
  const pct = u.capUSD ? u.spendUSD / u.capUSD : 0;
  const tone = pct >= 0.8 ? 'text-red-400' : pct >= 0.5 ? 'text-yellow-400' : 'text-green-400';
  const money = v => v == null ? '—' : `$${Number(v).toFixed(2)}`;
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex flex-col items-start px-3 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700"
        title="AI Council spend this month">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Tooling cost · {u.month}</span>
        <span className="font-mono text-sm text-gray-200">
          {money(u.toolingTotalUSD ?? u.spendUSD)}
          <span className={`ml-1.5 text-[11px] ${tone}`} title="AI spend vs monthly cap">AI {money(u.spendUSD)}/{money(u.capUSD)}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-3 text-xs z-30 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Tooling so far', money(u.toolingTotalUSD)], ['Tooling projected', money(u.toolingProjectedUSD)],
              ['AI spent', money(u.spendUSD)], ['AI projected', money(u.projectedMonthUSD)],
              ['Runs', u.runs], ['Avg per run', u.avgPerRunUSD != null ? `$${u.avgPerRunUSD.toFixed(3)}` : '—'],
            ].map(([l, v]) => (
              <div key={l} className="bg-gray-800 rounded px-2 py-1.5">
                <div className="text-[9px] uppercase text-gray-500">{l}</div>
                <div className="font-mono text-gray-200">{v}</div>
              </div>
            ))}
          </div>
          {Object.keys(u.fixedCosts || {}).length > 0 && (
            <div>
              <div className="text-[9px] uppercase text-gray-500 mb-1">Fixed monthly</div>
              {Object.entries(u.fixedCosts).map(([n, c]) => (
                <div key={n} className="flex justify-between font-mono text-gray-300"><span>{n}</span><span>${c.toFixed(2)}</span></div>
              ))}
            </div>
          )}
          {Object.keys(u.byModel || {}).length > 0 && (
            <div>
              <div className="text-[9px] uppercase text-gray-500 mb-1">By model</div>
              {Object.entries(u.byModel).map(([m, c]) => (
                <div key={m} className="flex justify-between font-mono text-gray-300">
                  <span className="truncate mr-2">{m}{u.freeProviders?.some(p => m.startsWith(p === 'openai' ? 'gpt' : p)) ? ' (free)' : ''}</span><span>${c.toFixed(3)}</span>
                </div>
              ))}
            </div>
          )}
          {u.freeTierSavingsUSD > 0 && <div className="text-gray-500">Free tier saved ${u.freeTierSavingsUSD.toFixed(3)} this month</div>}
          {u.history?.length > 0 && (
            <div>
              <div className="text-[9px] uppercase text-gray-500 mb-1">History</div>
              {u.history.map(h => (
                <div key={h.month} className="flex justify-between font-mono text-gray-400">
                  <span>{h.month}</span><span title={`AI $${h.spendUSD.toFixed(2)} + fixed`}>{h.runs} run{h.runs === 1 ? '' : 's'} · ${(h.totalUSD ?? h.spendUSD).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-gray-600">AI is estimated from token counts × list prices; fixed costs are what you set in TOOLING_FIXED_COSTS. Your invoices are the source of truth.</div>
        </div>
      )}
    </div>
  );
}

// ─── SCREENER TABLE COLUMNS ──────────────────────────────────────────────────

const COLUMNS = [
  { col: 'symbol',        label: 'Symbol' },
  { col: 'price',         label: 'Price' },
  { col: 'iv30',          label: 'IV30' },
  { col: 'strike',        label: 'Strike' },
  { col: 'expiration',    label: 'Expiration' },
  { col: 'dte',           label: 'DTE' },
  { col: 'collateral',    label: 'Collateral' },
  { col: 'mid',           label: 'Premium' },
  { col: 'roc',           label: 'ROC %' },
  { col: 'rocAnnualized', label: 'Ann ROC %' },
  { col: 'wheelScore',    label: 'Score' },
  { col: 'earnings',      label: 'Earnings' },
  { col: 'cap',           label: 'Cap' },
];

function getValue(row, col) {
  if (row.error) return null;
  const c = row.contract;
  switch (col) {
    case 'symbol':        return row.symbol;
    case 'price':         return row.price;
    case 'iv30':          return row.iv30;
    case 'strike':        return c?.strike;
    case 'expiration':    return c?.expiration;
    case 'dte':           return c?.dte;
    case 'collateral':    return c?.collateralRequired;
    case 'mid':           return c?.mid;
    case 'roc':           return c?.roc;
    case 'rocAnnualized': return c?.rocAnnualized;
    case 'wheelScore':    return row.wheelScore;
    case 'earnings':      return row.earningsDate;
    case 'cap':           return c?.exceedsCollateralCap ? 1 : 0;
    default:              return null;
  }
}

// ─── Earnings proximity helper ───────────────────────────────────────────────
// Returns { icon, colorCls, title } describing how close earnings are to expiry.
function earningsProximity(earningsDateStr, expirationStr, earningsInWindow) {
  if (!earningsDateStr) return { icon: null, colorCls: 'text-gray-500', title: '' };

  if (earningsInWindow) {
    return { icon: '⚠', colorCls: 'text-orange-400 font-semibold', title: 'Earnings inside expiration window' };
  }

  if (!expirationStr) return { icon: null, colorCls: 'text-gray-500', title: '' };

  const msPerDay = 86400000;
  const ed  = new Date(earningsDateStr + 'T12:00:00').getTime();
  const exp = new Date(expirationStr   + 'T12:00:00').getTime();
  const diff = Math.round((ed - exp) / msPerDay); // negative = earnings before expiry

  if (diff >= 0 && diff <= 7) {
    // earnings right after expiry — assignment risk if called away into earnings
    return { icon: '🔔', colorCls: 'text-yellow-400 font-semibold', title: `Earnings ${diff}d after expiry — assignment risk` };
  }
  if (diff < 0 && diff >= -14) {
    // earnings within 14 days before expiry
    return { icon: '⚠', colorCls: 'text-orange-400 font-semibold', title: `Earnings ${Math.abs(diff)}d before expiry` };
  }
  return { icon: null, colorCls: 'text-gray-500', title: '' };
}

// ─── SCREENER TAB ────────────────────────────────────────────────────────────

function ScreenerTab({ minROC }) {
  const [rows,           setRows]           = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [lastScan,       setLastScan]       = useState(null);
  const [scanErr,        setScanErr]        = useState(null);
  const [sortKey,        setSortKey]        = useState('roc');
  const [sortDir,        setSortDir]        = useState('desc');
  const [expandedSymbol, setExpandedSymbol] = useState(null);
  const [councilSymbol,  setCouncilSymbol]  = useState(null);
  const [earnWarnings,   setEarnWarnings]   = useState([]);
  const abortRef = useRef(null);

  // fetch earnings warnings from open positions on mount (no scan needed)
  useEffect(() => {
    fetch(`${API}/earnings-warnings`)
      .then(r => r.ok ? r.json() : [])
      .then(setEarnWarnings)
      .catch(() => {});
  }, []);

  const runScan = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanErr(null);
    setLoading(true);
    setExpandedSymbol(null);
    setCouncilSymbol(null);
    try {
      const res = await fetch(`${API}/scan`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(await res.json());
      setLastScan(new Date());
    } catch (e) {
      if (e.name !== 'AbortError') setScanErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const didRun = useRef(false);
  useEffect(() => {
    if (!didRun.current) { didRun.current = true; runScan(); }
  }, [runScan]);

  function handleSort(col) {
    if (sortKey === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(col); setSortDir('desc'); }
  }

  function handleRowClick(symbol) {
    setExpandedSymbol(prev => prev === symbol ? null : symbol);
  }

  const sorted = [...rows]
    .filter(r => r.error || (r.contract?.roc ?? 0) >= minROC)
    .sort((a, b) => {
      if (a.error && b.error) return 0;
      if (a.error) return 1;
      if (b.error) return -1;
      const av = getValue(a, sortKey), bv = getValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* scan controls */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-gray-800 bg-gray-900/60">
        <button
          onClick={runScan}
          disabled={loading}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-indigo-600 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {loading ? 'Scanning…' : '↻ Scan'}
        </button>
        {loading  && <Spinner />}
        {scanErr  && <span className="text-red-400 text-xs">Error: {scanErr}</span>}
        {lastScan && !loading && (
          <span className="text-gray-500 text-xs ml-auto">
            Last scan: {lastScan.toLocaleTimeString()} · Click any row to open heatmap
          </span>
        )}
      </div>

      {/* earnings risk banner */}
      {earnWarnings.length > 0 && (
        <div className="mx-4 mt-3 flex flex-col gap-1.5">
          {earnWarnings.map((w, i) => (
            <div key={i} className="flex items-center gap-2 bg-orange-950/40 border border-orange-800/50 rounded-lg px-4 py-2 text-xs text-orange-300">
              <span className="text-base leading-none">⚠️</span>
              <span>
                <span className="font-semibold font-mono">{w.symbol}</span>
                {' '}— expires <span className="font-mono">{w.expiration}</span>,
                earnings <span className="font-mono">{w.earningsDate}</span>
                {w.warningType === 'after'
                  ? <span className="text-yellow-400 ml-1">(earnings {w.diffDays}d after expiry — assignment risk)</span>
                  : <span className="text-orange-400 ml-1">(earnings {Math.abs(w.diffDays)}d before expiry)</span>
                }
              </span>
            </div>
          ))}
        </div>
      )}

      {/* table */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {!loading && rows.length === 0 && !scanErr && (
          <p className="text-gray-600 text-sm mt-10 text-center">No results. Press Scan.</p>
        )}

        {rows.length > 0 && (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  {COLUMNS.map(({ col, label }) => (
                    <SortableTh key={col} col={col} label={label}
                      sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const isExpanded = expandedSymbol === row.symbol;

                  if (row.error) return (
                    <React.Fragment key={row.symbol}>
                      <tr className="border-b border-gray-900 bg-red-950/30 cursor-pointer"
                          onClick={() => handleRowClick(row.symbol)}>
                        <td className="px-3 py-2 font-mono font-bold text-red-400">{row.symbol}</td>
                        <td colSpan={12} className="px-3 py-2 text-red-500 text-xs">{row.errorMessage || 'Error'}</td>
                      </tr>
                    </React.Fragment>
                  );

                  const c           = row.contract;
                  const exceedsCap   = c?.exceedsCollateralCap;
                  const earningsWarn = c?.earningsInWindow;
                  const ep = earningsProximity(row.earningsDate, c?.expiration, earningsWarn);
                  const rowBg = isExpanded
                    ? 'bg-indigo-950/40'
                    : exceedsCap
                      ? 'bg-yellow-950/20'
                      : i % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900/40';

                  return (
                    <React.Fragment key={row.symbol}>
                      <tr
                        onClick={() => handleRowClick(row.symbol)}
                        className={`border-b border-gray-900 cursor-pointer hover:bg-indigo-950/30 transition-colors ${rowBg}`}
                      >
                        {/* Symbol — chevron indicates open */}
                        <td className="px-3 py-2 font-mono font-bold text-white whitespace-nowrap">
                          <span className={`mr-1.5 text-xs transition-transform inline-block ${isExpanded ? 'text-indigo-400 rotate-90' : 'text-gray-600'}`}>▶</span>
                          {row.symbol}
                          {c && (
                            <button
                              onClick={e => { e.stopPropagation(); setCouncilSymbol(prev => prev === row.symbol ? null : row.symbol); }}
                              title="Ask Claude, GPT and Gemini about this put"
                              className={`ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded transition-colors
                                ${councilSymbol === row.symbol ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-indigo-800 hover:text-white'}`}>
                              Council
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-300">{fmt.dollar(row.price)}</td>
                        <td className="px-3 py-2 font-mono text-gray-300">{fmt.pct1(row.iv30)}</td>
                        <td className="px-3 py-2 font-mono text-gray-200">{c ? fmt.dollar(c.strike) : '—'}</td>
                        <td className="px-3 py-2 font-mono text-gray-400 text-xs">{c?.expiration ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-gray-400">{fmt.num(c?.dte)}</td>
                        <td className="px-3 py-2 font-mono text-gray-300">{c ? fmt.collat(c.collateralRequired) : '—'}</td>
                        <td className="px-3 py-2 font-mono text-green-400">{c ? fmt.dollar(c.mid) : '—'}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-indigo-300">{c ? fmt.pct2(c.roc) : '—'}</td>
                        <td className="px-3 py-2 font-mono text-indigo-200">{c ? fmt.pct1(c.rocAnnualized) : '—'}</td>
                        <td className="px-3 py-2 font-mono font-bold text-center">
                          {row.wheelScore != null ? (
                            <span className={
                              row.wheelScore >= 70 ? 'text-green-400' :
                              row.wheelScore >= 50 ? 'text-yellow-400' :
                              'text-red-400'
                            }>
                              {row.wheelScore}
                            </span>
                          ) : '—'}
                        </td>
                        <td className={`px-3 py-2 font-mono text-xs ${ep.colorCls}`} title={ep.title || undefined}>
                          {row.earningsDate ?? '—'}{ep.icon && <span className="ml-1">{ep.icon}</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {exceedsCap
                            ? <span title="Exceeds collateral cap">⚠️</span>
                            : <span title="Within collateral cap">✅</span>}
                        </td>
                      </tr>

                      {/* AI council row */}
                      {councilSymbol === row.symbol && c && (
                        <tr className="border-b-2 border-indigo-900">
                          <td colSpan={COLUMNS.length} className="p-0">
                            <CouncilPanel symbol={row.symbol} contract={c} onClose={() => setCouncilSymbol(null)} />
                          </td>
                        </tr>
                      )}

                      {/* accordion heatmap row */}
                      {isExpanded && (
                        <tr className="border-b-2 border-indigo-900">
                          <td colSpan={COLUMNS.length} className="p-0">
                            <HeatmapPanel
                              symbol={row.symbol}
                              recommendedContract={c}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            <div className="mt-3 text-xs text-gray-600">
              {sorted.filter(r => !r.error).length} symbols ·{' '}
              {sorted.filter(r => !r.error && r.contract).length} with contracts ·{' '}
              {sorted.filter(r => !r.error && r.contract && !r.contract.exceedsCollateralCap).length} within cap
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── WATCHLIST TAB ───────────────────────────────────────────────────────────

const ENTRY_CONDITIONS = ['Any', 'Red day', 'IV spike', 'Post-earnings', 'Support level'];

function normaliseItem(item) {
  if (typeof item === 'string') return { symbol: item, entryCondition: 'Any', notes: '', costBasis: null, shares: null };
  return { entryCondition: 'Any', notes: '', costBasis: null, shares: null, ...item };
}

function PositionsTab() {
  const [watchlist,       setWatchlist]       = useState([]);  // [{symbol, entryCondition, notes, costBasis, shares}]
  const [input,           setInput]           = useState('');
  const [inputErr,        setInputErr]        = useState('');
  const [expandedSym,     setExpandedSym]     = useState(null);
  const [scanResults,     setScanResults]     = useState({});
  const [ccResults,       setCcResults]       = useState({});   // covered-call results, keyed by symbol
  const [ccLoading,       setCcLoading]       = useState({});
  const [allowBelowBasis, setAllowBelowBasis] = useState({});   // per-symbol toggle
  const [ccHeatmapSym,    setCcHeatmapSym]    = useState(null); // symbol currently showing the CC heatmap
  const inputRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/config`)
      .then(r => r.json())
      .then(cfg => setWatchlist((cfg.watchlist ?? []).map(normaliseItem)))
      .catch(() => {});
  }, []);

  async function persistWatchlist(next) {
    const current = await fetch(`${API}/config`).then(r => r.json());
    await fetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, watchlist: next }),
    });
  }

  function validate(raw) {
    const sym = raw.trim().toUpperCase();
    if (!sym)                               return [null, 'Enter a symbol.'];
    if (sym.length > 6)                     return [null, 'Max 6 characters.'];
    if (!/^[A-Z.]+$/.test(sym))            return [null, 'Letters only.'];
    if (watchlist.some(w => w.symbol === sym)) return [null, `${sym} already in list.`];
    return [sym, ''];
  }

  function handleAdd() {
    const [sym, err] = validate(input);
    if (err) { setInputErr(err); return; }
    const next = [...watchlist, { symbol: sym, entryCondition: 'Any', notes: '', costBasis: null, shares: null }];
    setWatchlist(next);
    setInput('');
    setInputErr('');
    persistWatchlist(next).catch(() => {});
    inputRef.current?.focus();
  }

  function handleRemove(sym) {
    const next = watchlist.filter(w => w.symbol !== sym);
    setWatchlist(next);
    if (expandedSym === sym) setExpandedSym(null);
    setScanResults(prev => { const c = { ...prev }; delete c[sym]; return c; });
    setCcResults(prev => { const c = { ...prev }; delete c[sym]; return c; });
    persistWatchlist(next).catch(() => {});
  }

  function handleChipUpdate(sym, patch) {
    const next = watchlist.map(w => w.symbol === sym ? { ...w, ...patch } : w);
    setWatchlist(next);
    persistWatchlist(next).catch(() => {});
  }

  async function handleScanOne(sym) {
    setScanResults(prev => ({ ...prev, [sym]: 'loading' }));
    try {
      const data = await fetch(`${API}/scan/${sym}`).then(r => r.json());
      setScanResults(prev => ({ ...prev, [sym]: data }));
    } catch (e) {
      setScanResults(prev => ({ ...prev, [sym]: { symbol: sym, error: true, errorMessage: e.message } }));
    }
  }

  async function handleGetCoveredCall(item) {
    const sym = item.symbol;
    setCcLoading(prev => ({ ...prev, [sym]: true }));
    try {
      const data = await fetch(`${API}/covered-call/${sym}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costBasis: Number(item.costBasis),
          shares: Number(item.shares),
          allowBelowBasis: !!allowBelowBasis[sym],
        }),
      }).then(r => r.json());
      setCcResults(prev => ({ ...prev, [sym]: data }));
    } catch (e) {
      setCcResults(prev => ({ ...prev, [sym]: { symbol: sym, error: true, errorMessage: e.message } }));
    } finally {
      setCcLoading(prev => ({ ...prev, [sym]: false }));
    }
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-6 max-w-2xl">
      <h2 className="text-sm font-semibold text-gray-300 mb-1">Positions</h2>
      <p className="text-xs text-gray-600 mb-1">Changes save immediately. The Screener uses this list on next scan. Add a cost basis and share count to run a covered-call scan.</p>
      <p className="text-xs text-gray-700 mb-5">Positions persist across redeploys as long as a Railway volume is attached to this service. Without one, edits still live in the running container and reset to <code className="text-gray-600">config.default.json</code> on the next deploy.</p>

      {/* ── add input ── */}
      <div className="flex gap-2 mb-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value.toUpperCase()); setInputErr(''); }}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          maxLength={6}
          placeholder="TICKER"
          className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 font-mono text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button onClick={handleAdd}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-colors">
          + Add
        </button>
      </div>
      {inputErr && <p className="text-red-400 text-xs mb-3">{inputErr}</p>}

      {/* ── chips ── */}
      {watchlist.length === 0 ? (
        <p className="text-gray-600 text-sm mt-4">No symbols yet.</p>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          {watchlist.map(item => {
            const { symbol: sym, entryCondition, notes, costBasis, shares } = item;
            const isExpanded  = expandedSym === sym;
            const hasInfo     = (entryCondition && entryCondition !== 'Any') || notes || costBasis;
            const hasPosition = costBasis && shares;

            return (
              <div key={sym}
                className={`bg-gray-800 border rounded-xl transition-colors
                  ${isExpanded ? 'border-indigo-700' : 'border-gray-700'}`}>

                {/* collapsed header row */}
                <div className="flex items-center gap-1 px-3 py-1.5">
                  <button
                    onClick={() => setExpandedSym(isExpanded ? null : sym)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    <span className="font-mono font-semibold text-white text-sm">{sym}</span>
                    {hasPosition && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300">
                        {shares}sh @ {fmt.dollar(costBasis)}
                      </span>
                    )}
                    {!isExpanded && hasInfo && (
                      <span className="text-[10px] text-gray-500 truncate flex items-center gap-1">
                        {entryCondition !== 'Any' && (
                          <span className="text-indigo-400">{entryCondition}</span>
                        )}
                        {entryCondition !== 'Any' && notes && <span className="text-gray-700">·</span>}
                        {notes && <span>{notes}</span>}
                      </span>
                    )}
                    <span className={`ml-auto text-[10px] text-gray-600 transition-transform inline-block ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                  </button>

                  {hasPosition && (
                    <button
                      onClick={e => { e.stopPropagation(); handleGetCoveredCall(item); }}
                      disabled={ccLoading[sym]}
                      title={`Covered call scan for ${sym}`}
                      className="ml-2 px-2 py-0.5 text-xs rounded-full bg-emerald-800 hover:bg-emerald-600 text-emerald-200 disabled:opacity-40 transition-colors">
                      {ccLoading[sym] ? '…' : 'CC'}
                    </button>
                  )}
                  {hasPosition && (
                    <button
                      onClick={e => { e.stopPropagation(); setCcHeatmapSym(prev => prev === sym ? null : sym); }}
                      title={`Covered call heatmap for ${sym}`}
                      className={`ml-1.5 px-2 py-0.5 text-xs rounded-full transition-colors
                        ${ccHeatmapSym === sym ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-emerald-700 text-gray-300'}`}>
                      ≡
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); handleScanOne(sym); }}
                    disabled={scanResults[sym] === 'loading'}
                    title={`CSP scan ${sym}`}
                    className="ml-2 px-2 py-0.5 text-xs rounded-full bg-indigo-800 hover:bg-indigo-600 text-indigo-200 disabled:opacity-40 transition-colors">
                    {scanResults[sym] === 'loading' ? '…' : '▶'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleRemove(sym); }}
                    title={`Remove ${sym}`}
                    className="w-5 h-5 flex items-center justify-center rounded-full text-gray-500 hover:bg-red-900/60 hover:text-red-400 transition-colors text-xs">
                    ×
                  </button>
                </div>

                {/* expanded fields */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-gray-700 flex flex-wrap gap-3 items-end">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500">Entry Condition</label>
                      <select
                        value={entryCondition}
                        onChange={e => handleChipUpdate(sym, { entryCondition: e.target.value })}
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        {ENTRY_CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500">Cost Basis ($/sh)</label>
                      <input
                        type="number" step="0.01" min="0"
                        value={costBasis ?? ''}
                        onChange={e => handleChipUpdate(sym, { costBasis: e.target.value === '' ? null : Number(e.target.value) })}
                        placeholder="e.g. 81.15"
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-24"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500">Shares</label>
                      <input
                        type="number" step="1" min="0"
                        value={shares ?? ''}
                        onChange={e => handleChipUpdate(sym, { shares: e.target.value === '' ? null : Number(e.target.value) })}
                        placeholder="100"
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-20"
                      />
                    </div>
                    {hasPosition && (
                      <label className="flex items-center gap-1.5 text-[10px] text-gray-500 pb-1.5">
                        <input
                          type="checkbox"
                          checked={!!allowBelowBasis[sym]}
                          onChange={e => setAllowBelowBasis(prev => ({ ...prev, [sym]: e.target.checked }))}
                        />
                        Allow strikes below basis
                      </label>
                    )}
                    <div className="flex flex-col gap-1 flex-1 min-w-[8rem]">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500">Notes</label>
                      <input
                        type="text"
                        value={notes}
                        onChange={e => handleChipUpdate(sym, { notes: e.target.value })}
                        placeholder="e.g. Wait for IV > 100"
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-full"
                      />
                    </div>
                  </div>
                )}

                {/* covered-call heatmap */}
                {ccHeatmapSym === sym && hasPosition && (
                  <HeatmapPanel
                    symbol={sym}
                    recommendedContract={ccResults[sym]?.contract}
                    fetchUrl={`${API}/heatmap/covered-call/${sym}?costBasis=${costBasis}&shares=${shares}&allowBelowBasis=${!!allowBelowBasis[sym]}`}
                    metrics={CC_HEATMAP_METRICS}
                    detailFields={CC_DETAIL_FIELDS}
                    capFlagKey="belowCostBasis"
                    capLabel="below basis"
                    title="Covered Call Heatmap"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* scan result cards */}
      <div className="mt-3">
        {watchlist
          .filter(w => scanResults[w.symbol] && scanResults[w.symbol] !== 'loading')
          .map(w => (
            <ContractCard
              key={`csp-${w.symbol}`}
              result={scanResults[w.symbol]}
              onClose={() => setScanResults(prev => { const c = { ...prev }; delete c[w.symbol]; return c; })}
            />
          ))}
        {watchlist
          .filter(w => ccResults[w.symbol])
          .map(w => (
            <CoveredCallCard
              key={`cc-${w.symbol}`}
              result={ccResults[w.symbol]}
              onClose={() => setCcResults(prev => { const c = { ...prev }; delete c[w.symbol]; return c; })}
            />
          ))}
      </div>
    </div>
  );
}

// ─── ROOT APP ────────────────────────────────────────────────────────────────

export default function App() {
  const [tab,          setTab]          = useState('screener');
  const [collateralCap,setCollateralCap]= useState(12000);
  const [minROC,       setMinROC]       = useState(1.5);
  const [dteLow,       setDteLow]       = useState(21);
  const [dteHigh,      setDteHigh]      = useState(35);
  const [targetDTE,    setTargetDTE]    = useState(30);

  useEffect(() => {
    fetch(`${API}/config`).then(r => r.json()).then(cfg => {
      setCollateralCap(cfg.collateralCap ?? 12000);
      setMinROC(cfg.minROC ?? 1.5);
      setDteLow(cfg.dteLow ?? 21);
      setDteHigh(cfg.dteHigh ?? 35);
      setTargetDTE(cfg.targetDTE ?? 30);
    }).catch(() => {});
  }, []);

  async function saveConfig(patch) {
    const current = await fetch(`${API}/config`).then(r => r.json());
    await fetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, ...patch }),
    });
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

      {/* ── TOP BAR ── */}
      <div className="sticky top-0 z-20 bg-gray-900 border-b border-gray-800 px-6 py-3">
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex items-baseline gap-2 mr-1">
            <span className="text-lg font-bold text-white tracking-tight">WheelScan</span>
            <span className="text-xs text-gray-500">CSP Screener</span>
          </div>

          {/* collateral cap */}
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label className="text-xs text-gray-400">
              Collateral Cap <span className="ml-1 font-mono text-indigo-300">${collateralCap.toLocaleString()}</span>
            </label>
            <input type="range" min={5000} max={25000} step={500} value={collateralCap}
              onChange={e => { const v = Number(e.target.value); setCollateralCap(v); saveConfig({ collateralCap: v }).catch(() => {}); }}
              className="w-full accent-indigo-500 h-1.5" />
            <div className="flex justify-between text-[10px] text-gray-600"><span>$5k</span><span>$25k</span></div>
          </div>

          {/* min ROC */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Min ROC %</label>
            <input type="number" min={0} max={20} step={0.1} value={minROC}
              onChange={e => { const v = parseFloat(e.target.value) || 0; setMinROC(v); saveConfig({ minROC: v }).catch(() => {}); }}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-right" />
          </div>

          {/* DTE range */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">DTE Range</label>
            <div className="flex items-center gap-1">
              <input type="number" min={1} max={90} step={1} value={dteLow}
                onChange={e => { const v = parseInt(e.target.value) || 1; setDteLow(v); saveConfig({ dteLow: v }).catch(() => {}); }}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-right" />
              <span className="text-gray-600 text-xs">–</span>
              <input type="number" min={1} max={90} step={1} value={dteHigh}
                onChange={e => { const v = parseInt(e.target.value) || 1; setDteHigh(v); saveConfig({ dteHigh: v }).catch(() => {}); }}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-right" />
            </div>
          </div>

          {/* target DTE */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Target DTE</label>
            <input type="number" min={1} max={90} step={1} value={targetDTE}
              onChange={e => { const v = parseInt(e.target.value) || 1; setTargetDTE(v); saveConfig({ targetDTE: v }).catch(() => {}); }}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-right" />
          </div>

          {/* AI spend + tab switcher */}
          <div className="ml-auto flex items-center gap-3">
          <CouncilSpend />
          <div className="flex items-center gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {['screener', 'positions'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize
                  ${tab === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          </div>
        </div>
      </div>

      {/* ── TAB CONTENT ── */}
      {tab === 'screener'   && <ScreenerTab minROC={minROC} />}
      {tab === 'positions'  && <PositionsTab />}
    </div>
  );
}
