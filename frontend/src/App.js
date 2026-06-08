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
  const { symbol, price, iv30, earningsDate, contract: c, error, errorMessage } = result;
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

// ─── HEATMAP PANEL ───────────────────────────────────────────────────────────

const HEATMAP_METRICS = [
  { key: 'roc',              label: 'ROC %',     fmt: v => `${v.toFixed(2)}%` },
  { key: 'rocAnnualized',    label: 'Ann ROC %', fmt: v => `${v.toFixed(1)}%` },
  { key: 'mid',              label: 'Premium',   fmt: v => `$${v.toFixed(2)}`  },
  { key: 'impliedVolatility',label: 'IV',        fmt: v => `${v.toFixed(0)}%` },
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

// for the comparison summary: higher = better for all four
const CMP_FIELDS = ['roc','rocAnnualized','mid','impliedVolatility'];
const CMP_LABELS = { roc:'ROC %', rocAnnualized:'Ann ROC', mid:'Premium', impliedVolatility:'IV' };

function ContractDetailCard({ symbol, contract: c, accentColor, onClear, onPin, isPinned, showPinButton }) {
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
        {DETAIL_FIELDS.map(({ key, label, render }) => (
          <div key={key} className="flex justify-between items-baseline px-1 py-0.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
            <span className="font-mono text-xs text-gray-200">{render(c)}</span>
          </div>
        ))}
      </div>

      {/* warnings */}
      {(c.exceedsCollateralCap || c.earningsInWindow) && (
        <div className="px-3 pb-2 flex flex-col gap-0.5">
          {c.exceedsCollateralCap && <span className="text-[10px] text-yellow-400">⚠️ Exceeds collateral cap</span>}
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

function HeatmapPanel({ symbol, recommendedContract }) {
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
    fetch(`${API}/heatmap/${symbol}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d  => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setFetchErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

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

  const metricDef = HEATMAP_METRICS.find(m => m.key === metric);
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
        <span className="text-gray-600 text-xs">Options Heatmap · DTE 7–60</span>
        <div className="ml-auto flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
          {HEATMAP_METRICS.map(m => (
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
                      const bg         = heatColor(norm, c.exceedsCollateralCap);
                      const rec        = isRec(c);
                      const cellActive = isCellActive(c);
                      const pinned_c   = isPinned(c);
                      const textColor  = c.exceedsCollateralCap ? '#4b5563' : '#f3f4f6';
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
            <span className="ml-1">exceeds cap</span>
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

// ─── SCREENER TAB ────────────────────────────────────────────────────────────

function ScreenerTab({ minROC }) {
  const [rows,           setRows]           = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [lastScan,       setLastScan]       = useState(null);
  const [scanErr,        setScanErr]        = useState(null);
  const [sortKey,        setSortKey]        = useState('roc');
  const [sortDir,        setSortDir]        = useState('desc');
  const [expandedSymbol, setExpandedSymbol] = useState(null);
  const abortRef = useRef(null);

  const runScan = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanErr(null);
    setLoading(true);
    setExpandedSymbol(null);
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
                  const exceedsCap  = c?.exceedsCollateralCap;
                  const earningsWarn = c?.earningsInWindow;
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
                        <td className={`px-3 py-2 font-mono text-xs ${earningsWarn ? 'text-orange-400 font-semibold' : 'text-gray-500'}`}>
                          {row.earningsDate ?? '—'}{earningsWarn && <span className="ml-1">⚠</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {exceedsCap
                            ? <span title="Exceeds collateral cap">⚠️</span>
                            : <span title="Within collateral cap">✅</span>}
                        </td>
                      </tr>

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
  if (typeof item === 'string') return { symbol: item, entryCondition: 'Any', notes: '' };
  return { entryCondition: 'Any', notes: '', ...item };
}

function WatchlistTab() {
  const [watchlist,   setWatchlist]   = useState([]);  // [{symbol, entryCondition, notes}]
  const [input,       setInput]       = useState('');
  const [inputErr,    setInputErr]    = useState('');
  const [expandedSym, setExpandedSym] = useState(null);
  const [scanResults, setScanResults] = useState({});
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
    const next = [...watchlist, { symbol: sym, entryCondition: 'Any', notes: '' }];
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

  return (
    <div className="flex-1 overflow-auto px-6 py-6 max-w-2xl">
      <h2 className="text-sm font-semibold text-gray-300 mb-1">Watchlist</h2>
      <p className="text-xs text-gray-600 mb-5">Changes save immediately. The Screener uses this list on next scan.</p>

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
        <p className="text-gray-600 text-sm mt-4">No symbols in watchlist.</p>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          {watchlist.map(item => {
            const { symbol: sym, entryCondition, notes } = item;
            const isExpanded = expandedSym === sym;
            const hasInfo    = (entryCondition && entryCondition !== 'Any') || notes;

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

                  <button
                    onClick={e => { e.stopPropagation(); handleScanOne(sym); }}
                    disabled={scanResults[sym] === 'loading'}
                    title={`Scan ${sym}`}
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
                  <div className="px-3 pb-3 pt-1 border-t border-gray-700 flex gap-3 items-end">
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
                    <div className="flex flex-col gap-1 flex-1">
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
              key={w.symbol}
              result={scanResults[w.symbol]}
              onClose={() => setScanResults(prev => { const c = { ...prev }; delete c[w.symbol]; return c; })}
            />
          ))}
      </div>
    </div>
  );
}

// ─── POSITIONS TAB ───────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

function dtesRemaining(expiration) {
  const diff = Math.round((new Date(expiration + 'T12:00:00') - new Date()) / 86400000);
  return diff;
}

function pnl(pos) {
  if (pos.closePremium == null) return null;
  return (pos.premium - pos.closePremium) * 100;
}

const INPUT_CLS = "bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-full";
const LABEL_CLS = "text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 block";

function TypeBadge({ type }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide
      ${type === 'CSP' ? 'bg-indigo-900 text-indigo-300' : 'bg-emerald-900 text-emerald-300'}`}>
      {type}
    </span>
  );
}

function StatusBadge({ status }) {
  const styles = {
    open:     'bg-blue-900/50 text-blue-300',
    closed:   'bg-gray-700 text-gray-400',
    assigned: 'bg-yellow-900/50 text-yellow-300',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize ${styles[status] ?? styles.closed}`}>
      {status}
    </span>
  );
}

// ── Add Position Form ──────────────────────────────────────────────────────

function AddPositionForm({ onAdded }) {
  const empty = {
    symbol: '', type: 'CSP', strike: '', expiration: '',
    premium: '', openDate: TODAY, collateral: '', costBasis: '', notes: '',
  };
  const [f, setF]   = useState(empty);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  function field(name, val) { setF(prev => ({ ...prev, [name]: val })); }

  async function submit(e) {
    e.preventDefault();
    if (!f.symbol || !f.strike || !f.expiration || !f.premium || !f.collateral) {
      setErr('Symbol, strike, expiration, premium, and collateral are required.'); return;
    }
    setSaving(true); setErr('');
    try {
      const body = {
        symbol:     f.symbol.trim().toUpperCase(),
        type:       f.type,
        strike:     parseFloat(f.strike),
        expiration: f.expiration,
        premium:    parseFloat(f.premium),
        openDate:   f.openDate || TODAY,
        collateral: parseFloat(f.collateral),
        costBasis:  f.type === 'CC' && f.costBasis ? parseFloat(f.costBasis) : null,
        notes:      f.notes,
      };
      const res = await fetch(`${API}/positions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setF(empty);
      onAdded();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Add Position</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">

        <div className="col-span-1">
          <label className={LABEL_CLS}>Symbol</label>
          <input className={INPUT_CLS} value={f.symbol}
            onChange={e => field('symbol', e.target.value.toUpperCase())} placeholder="ASTS" maxLength={6} />
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Type</label>
          <select className={INPUT_CLS} value={f.type} onChange={e => field('type', e.target.value)}>
            <option value="CSP">CSP</option>
            <option value="CC">CC</option>
          </select>
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Strike</label>
          <input className={INPUT_CLS} type="number" step="0.5" value={f.strike}
            onChange={e => field('strike', e.target.value)} placeholder="75.00" />
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Expiration</label>
          <input className={INPUT_CLS} type="date" value={f.expiration}
            onChange={e => field('expiration', e.target.value)} />
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Premium</label>
          <input className={INPUT_CLS} type="number" step="0.01" value={f.premium}
            onChange={e => field('premium', e.target.value)} placeholder="4.68" />
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Open Date</label>
          <input className={INPUT_CLS} type="date" value={f.openDate}
            onChange={e => field('openDate', e.target.value)} />
        </div>

        <div className="col-span-1">
          <label className={LABEL_CLS}>Collateral</label>
          <input className={INPUT_CLS} type="number" step="100" value={f.collateral}
            onChange={e => field('collateral', e.target.value)} placeholder="7500" />
        </div>

        {f.type === 'CC' ? (
          <div className="col-span-1">
            <label className={LABEL_CLS}>Cost Basis/sh</label>
            <input className={INPUT_CLS} type="number" step="0.01" value={f.costBasis}
              onChange={e => field('costBasis', e.target.value)} placeholder="72.00" />
          </div>
        ) : (
          <div className="col-span-1">
            <label className={LABEL_CLS}>Notes</label>
            <input className={INPUT_CLS} value={f.notes}
              onChange={e => field('notes', e.target.value)} placeholder="optional" />
          </div>
        )}
      </div>

      {f.type === 'CC' && (
        <div className="mt-3 max-w-xs">
          <label className={LABEL_CLS}>Notes</label>
          <input className={INPUT_CLS} value={f.notes}
            onChange={e => field('notes', e.target.value)} placeholder="optional" />
        </div>
      )}

      <div className="flex items-center gap-4 mt-4">
        <button type="submit" disabled={saving}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
          {saving ? 'Saving…' : '+ Add Position'}
        </button>
        {err && <span className="text-red-400 text-xs">{err}</span>}
      </div>
    </form>
  );
}

// ── Close inline form ──────────────────────────────────────────────────────

function CloseForm({ position, onClose, onCancel }) {
  const [closeP, setCloseP] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch(`${API}/positions/${position.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'closed',
          closePremium: parseFloat(closeP) || 0,
          closeDate: TODAY,
        }),
      });
      onClose();
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 mt-1">
      <input type="number" step="0.01" min="0" placeholder="Close premium"
        value={closeP} onChange={e => setCloseP(e.target.value)}
        className="w-32 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs font-mono text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
      <button type="submit" disabled={saving}
        className="px-2 py-1 bg-green-700 hover:bg-green-600 text-white text-xs rounded transition-colors">
        {saving ? '…' : 'Confirm'}
      </button>
      <button type="button" onClick={onCancel}
        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors">
        Cancel
      </button>
    </form>
  );
}

// ── Summary bar ────────────────────────────────────────────────────────────

function SummaryBar({ positions }) {
  const open   = positions.filter(p => p.status === 'open');
  const closed = positions.filter(p => p.status === 'closed' || p.status === 'assigned');
  const totalCollateral = open.reduce((s, p) => s + (p.collateral ?? 0), 0);
  const totalPremium    = open.reduce((s, p) => s + (p.premium ?? 0) * 100, 0);
  const wins = closed.filter(p => p.closePremium != null && p.closePremium < p.premium).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : null;

  const stat = (label, val) => (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
      <span className="font-mono text-sm text-gray-100 mt-0.5">{val}</span>
    </div>
  );

  return (
    <div className="flex flex-wrap gap-6 bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 mb-5">
      {stat('Open Positions',      open.length)}
      {stat('Collateral Deployed', `$${totalCollateral.toLocaleString()}`)}
      {stat('Premium Collected',   `$${totalPremium.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`)}
      {stat('Win Rate',            winRate != null ? `${winRate}% (${wins}/${closed.length})` : '—')}
    </div>
  );
}

// ── Main PositionsTab ──────────────────────────────────────────────────────

function PositionsTab() {
  const [positions,    setPositions]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [closingId,    setClosingId]    = useState(null);   // which row has close form open
  const [showClosed,   setShowClosed]   = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await fetch(`${API}/positions`).then(r => r.json());
      setPositions(data);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function deletePos(id) {
    if (!window.confirm('Delete this position?')) return;
    await fetch(`${API}/positions/${id}`, { method: 'DELETE' });
    load();
  }

  async function markAssigned(id) {
    await fetch(`${API}/positions/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'assigned', closeDate: TODAY }),
    });
    load();
  }

  const open   = positions.filter(p => p.status === 'open');
  const closed = positions.filter(p => p.status !== 'open');

  const thCls = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap";
  const tdCls = "px-3 py-2 font-mono text-sm text-gray-300 whitespace-nowrap";

  // ── Open positions table ──
  function OpenTable() {
    if (open.length === 0)
      return <p className="text-gray-600 text-sm py-6 text-center">No open positions. Add one above.</p>;

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {['Symbol','Type','Strike','Expiration','DTE','Premium','Collateral','ROC %','Close At','Notes','Actions']
                .map(h => <th key={h} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {open.map((pos, i) => {
              const dte      = dtesRemaining(pos.expiration);
              const roc      = pos.collateral ? ((pos.premium * 100 / pos.collateral) * 100).toFixed(2) : '—';
              const target   = (pos.premium * 0.30).toFixed(2);  // buy back at 30% of original premium = 70% profit captured
              const rowBg    = i % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900/40';
              const dteCls   = dte <= 7 ? 'text-red-400 font-bold' : dte <= 14 ? 'text-yellow-400' : 'text-gray-300';

              return (
                <React.Fragment key={pos.id}>
                  <tr className={`border-b border-gray-900 hover:bg-gray-800/50 transition-colors ${rowBg}`}>
                    <td className={`${tdCls} font-bold text-white`}>{pos.symbol}</td>
                    <td className="px-3 py-2"><TypeBadge type={pos.type} /></td>
                    <td className={tdCls}>${pos.strike}</td>
                    <td className={`${tdCls} text-gray-400 text-xs`}>{pos.expiration}</td>
                    <td className={`px-3 py-2 font-mono text-sm ${dteCls}`}>{dte}d</td>
                    <td className={`${tdCls} text-green-400`}>${pos.premium.toFixed(2)}</td>
                    <td className={tdCls}>${pos.collateral.toLocaleString()}</td>
                    <td className={`${tdCls} text-indigo-300 font-semibold`}>{roc}%</td>
                    <td className={`${tdCls} text-yellow-400`}>≤ ${target}</td>
                    <td className={`${tdCls} text-gray-500 text-xs max-w-[120px] truncate`}>{pos.notes || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => setClosingId(closingId === pos.id ? null : pos.id)}
                          className="px-2 py-1 bg-blue-800 hover:bg-blue-700 text-blue-200 text-xs rounded transition-colors">
                          Close
                        </button>
                        <button onClick={() => markAssigned(pos.id)}
                          className="px-2 py-1 bg-yellow-800/60 hover:bg-yellow-700/60 text-yellow-300 text-xs rounded transition-colors">
                          Assigned
                        </button>
                        <button onClick={() => deletePos(pos.id)}
                          className="px-2 py-1 bg-gray-700 hover:bg-red-900/60 text-gray-400 hover:text-red-400 text-xs rounded transition-colors">
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                  {closingId === pos.id && (
                    <tr className="border-b border-gray-800 bg-gray-900">
                      <td colSpan={11} className="px-4 py-2">
                        <CloseForm
                          position={pos}
                          onClose={() => { setClosingId(null); load(); }}
                          onCancel={() => setClosingId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Closed positions table ──
  function ClosedTable() {
    if (closed.length === 0)
      return <p className="text-gray-600 text-sm py-4 text-center">No closed positions yet.</p>;

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {['Symbol','Type','Status','Strike','Expiration','Open Date','Close Date','Premium','Close Premium','P&L','ROC %','Notes']
                .map(h => <th key={h} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {closed.map((pos, i) => {
              const pl     = pnl(pos);
              const roc    = pos.collateral ? ((pos.premium * 100 / pos.collateral) * 100).toFixed(2) : '—';
              const rowBg  = i % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900/40';
              const plCls  = pl == null ? 'text-gray-500' : pl >= 0 ? 'text-green-400' : 'text-red-400';
              return (
                <tr key={pos.id} className={`border-b border-gray-900 ${rowBg}`}>
                  <td className={`${tdCls} font-bold text-white`}>{pos.symbol}</td>
                  <td className="px-3 py-2"><TypeBadge type={pos.type} /></td>
                  <td className="px-3 py-2"><StatusBadge status={pos.status} /></td>
                  <td className={tdCls}>${pos.strike}</td>
                  <td className={`${tdCls} text-gray-400 text-xs`}>{pos.expiration}</td>
                  <td className={`${tdCls} text-gray-500 text-xs`}>{pos.openDate ?? '—'}</td>
                  <td className={`${tdCls} text-gray-500 text-xs`}>{pos.closeDate ?? '—'}</td>
                  <td className={`${tdCls} text-green-400`}>${pos.premium.toFixed(2)}</td>
                  <td className={tdCls}>{pos.closePremium != null ? `$${pos.closePremium.toFixed(2)}` : '—'}</td>
                  <td className={`px-3 py-2 font-mono text-sm font-semibold ${plCls}`}>
                    {pl != null ? `${pl >= 0 ? '+' : ''}$${pl.toFixed(0)}` : '—'}
                  </td>
                  <td className={`${tdCls} text-indigo-300`}>{roc}%</td>
                  <td className={`${tdCls} text-gray-500 text-xs max-w-[120px] truncate`}>{pos.notes || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-5">

      <AddPositionForm onAdded={load} />
      <SummaryBar positions={positions} />

      {/* ── Open Positions ── */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3 flex items-center gap-2">
          Open Positions
          <span className="bg-blue-900/50 text-blue-300 text-[10px] px-1.5 py-0.5 rounded font-bold">{open.length}</span>
        </h3>
        {loading ? <Spinner label="Loading positions…" /> : <OpenTable />}
      </div>

      {/* ── Closed Positions (collapsible) ── */}
      <div>
        <button onClick={() => setShowClosed(s => !s)}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300 transition-colors mb-3">
          <span className={`transition-transform ${showClosed ? 'rotate-90' : ''}`}>▶</span>
          Closed / Assigned
          <span className="bg-gray-800 text-gray-400 text-[10px] px-1.5 py-0.5 rounded font-bold">{closed.length}</span>
        </button>
        {showClosed && <ClosedTable />}
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

          {/* tab switcher */}
          <div className="ml-auto flex items-center gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {['screener', 'watchlist', 'positions'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize
                  ${tab === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── TAB CONTENT ── */}
      {tab === 'screener'   && <ScreenerTab minROC={minROC} />}
      {tab === 'watchlist'  && <WatchlistTab />}
      {tab === 'positions'  && <PositionsTab />}
    </div>
  );
}
