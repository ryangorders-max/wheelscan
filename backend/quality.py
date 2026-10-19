"""
Fundamental-quality grades. Primary source: Schwab instruments (FUNDAMENTAL
projection) via the oauth proxy — one batched call, no daily cap. Fallback:
Alpha Vantage OVERVIEW on the free tier, for anything Schwab didn't return.

Fundamentals only change when a company reports, so each symbol is fetched
at most once every CACHE_DAYS and the whole app spends at most DAILY_BUDGET
calls a day (WheelScan has its own free key, 25/day). Scans never wait on Alpha Vantage: they
read the cache, and missing/stale symbols are refreshed in a background
thread, so new grades appear on a later scan.

Grade (one point each, A=4 ... D<=1):
  profitable      ProfitMargin > 0
  cash-generative EBITDA > 0
  growing         QuarterlyRevenueGrowthYOY > 10%
  established     MarketCapitalization > $2B
Funds/ETFs (no OVERVIEW data) get grade None and are never filtered out.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx

API_KEY = os.environ.get("ALPHA_VANTAGE_API_KEY", "")
CACHE_DAYS = 7
DAILY_BUDGET = 22       # own free key (25/day), 3 spare for retries
SPACING_S = 1.5          # stay well under the free tier's burst limit

_lock = threading.Lock()
_running = False


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except Exception:
        return {}


def _save(path: Path, data: dict) -> None:
    try:
        path.write_text(json.dumps(data))
    except Exception:
        pass


def _num(v):
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def _grade(ov: dict) -> dict:
    pm = _num(ov.get("ProfitMargin"))
    ebitda = _num(ov.get("EBITDA"))
    growth = _num(ov.get("QuarterlyRevenueGrowthYOY"))
    mcap = _num(ov.get("MarketCapitalization"))
    checks = {
        "profitable": pm is not None and pm > 0,
        "cashGenerative": ebitda is not None and ebitda > 0,
        "growing": growth is not None and growth > 0.10,
        "established": mcap is not None and mcap > 2e9,
    }
    pts = sum(checks.values())
    return {
        "grade": "A" if pts == 4 else "B" if pts == 3 else "C" if pts == 2 else "D",
        "checks": checks,
        "profitMargin": pm,
        "revenueGrowthYoY": growth,
        "marketCap": mcap,
        "ebitda": ebitda,
    }


def _pct(v):
    """Schwab reports margins/growth as percents (25.3 = 25.3%); normalise to fractions."""
    f = _num(v)
    return None if f is None else f / 100.0


def _grade_schwab(f: dict) -> dict:
    if (f.get("assetType") or "EQUITY") != "EQUITY":
        return {"grade": None, "source": "schwab"}           # fund/ETF/etc.
    mcap = _num(f.get("marketCap"))
    if mcap is not None and 0 < mcap < 1e7:                   # reported in $M
        mcap *= 1e6
    g = _grade({
        "ProfitMargin": _pct(f.get("netProfitMarginTTM", f.get("netMarginTTM"))),
        # Schwab has no EBITDA; operating margin is the closest "cash-generative" proxy
        "EBITDA": _num(f.get("operatingMarginTTM")),
        "QuarterlyRevenueGrowthYOY": _pct(f.get("revChangeTTM", f.get("revChangeYear"))),
        "MarketCapitalization": mcap,
    })
    g["source"] = "schwab"
    return g


def _fetch(symbol: str) -> dict | None:
    """One OVERVIEW call. Returns {} for funds/unknown, None on a rate-limit/error."""
    r = httpx.get(
        "https://www.alphavantage.co/query",
        params={"function": "OVERVIEW", "symbol": symbol, "apikey": API_KEY},
        timeout=15,
    )
    data = r.json()
    if "Note" in data or "Information" in data:   # rate limit / daily cap
        return None
    return data if data.get("Symbol") else {}


def _stale(entry: dict | None) -> bool:
    if not entry:
        return True
    try:
        return datetime.fromisoformat(entry["fetched"]) < datetime.now() - timedelta(days=CACHE_DAYS)
    except Exception:
        return True


def _refresh(symbols: list[str], path: Path) -> None:
    global _running
    try:
        cache = _load(path)
        # 1) Schwab: one batched call, no cap
        try:
            import schwab_source
            fund = schwab_source.get_fundamentals(symbols)
        except Exception:
            fund = {}
        for sym, f in fund.items():
            # a non-equity (fund/ETF) is final even with no fundamentals attached
            if f and ((f.get("assetType") or "EQUITY") != "EQUITY" or any(k != "assetType" for k in f)):
                cache[sym] = {"fetched": datetime.now().isoformat(), **_grade_schwab(f)}
        _save(path, cache)
        symbols = [s for s in symbols if _stale(cache.get(s))]
        # 2) Alpha Vantage for whatever Schwab didn't cover
        if not API_KEY:
            return
        meta = cache.setdefault("_meta", {})
        today = date.today().isoformat()
        if meta.get("day") != today:
            meta["day"], meta["calls"] = today, 0
        for sym in symbols:
            if meta["calls"] >= DAILY_BUDGET:
                break
            if not _stale(cache.get(sym)):
                continue
            meta["calls"] += 1
            try:
                ov = _fetch(sym)
            except Exception:
                ov = None
            if ov is None:          # capped or failed: stop for today, try tomorrow
                meta["calls"] = DAILY_BUDGET
                break
            cache[sym] = {"fetched": datetime.now().isoformat(),
                          **(_grade(ov) if ov else {"grade": None})}
            _save(path, cache)
            time.sleep(SPACING_S)
        _save(path, cache)
    finally:
        with _lock:
            _running = False


def attach_quality(results: list[dict], path) -> list[dict]:
    """Attach cached grades to scan rows; refresh missing/stale ones in the background."""
    global _running
    path = Path(path)
    cache = _load(path)
    for r in results:
        e = cache.get(r.get("symbol"))
        r["quality"] = {k: v for k, v in e.items() if k != "fetched"} if e else None
    # re-check anything stale, plus anything not yet graded from Schwab (one
    # cheap batched call); Alpha Vantage is only spent on stale leftovers
    todo = [r["symbol"] for r in results if r.get("symbol")
            and (_stale(cache.get(r["symbol"])) or (cache.get(r["symbol"]) or {}).get("source") != "schwab")]
    with _lock:
        if todo and not _running:
            _running = True
            threading.Thread(target=_refresh, args=(todo, path), daemon=True).start()
    return results
