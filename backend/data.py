from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from datetime import date, datetime
from typing import Optional

import yfinance as yf

# ---------------------------------------------------------------------------
# Black-Scholes helpers
# ---------------------------------------------------------------------------

def _norm_cdf(x: float) -> float:
    """Cumulative standard normal distribution via math.erfc (no scipy needed)."""
    return 0.5 * math.erfc(-x / math.sqrt(2))


def bs_put_delta(S: float, K: float, T: float, r: float, sigma: float) -> Optional[float]:
    """
    Black-Scholes delta for a European put option.

    Parameters
    ----------
    S     : current underlying price
    K     : strike price
    T     : time to expiration in years  (dte / 365)
    r     : risk-free rate (annualised, e.g. 0.05 for 5%)
    sigma : implied volatility (annualised, e.g. 0.40 for 40%)

    Returns
    -------
    Put delta in (-1, 0), or None if inputs are invalid.
    """
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return None
    try:
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        # put delta = N(d1) - 1
        return round(_norm_cdf(d1) - 1.0, 4)
    except (ValueError, ZeroDivisionError):
        return None

SYMBOL_TIMEOUT = 10  # seconds per symbol


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_int(val, default: int = 0) -> int:
    """Convert val to int, treating None/NaN/inf as default."""
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else int(f)
    except (TypeError, ValueError):
        return default


def _safe_float(val, default: float = 0.0) -> float:
    """Convert val to float, treating None/NaN/inf as default."""
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default

def _inv_norm(p: float) -> float:
    """
    Rational approximation of the inverse normal CDF (Abramowitz & Stegun 26.2.17).
    Accurate to ~3e-4 over (0, 1) — plenty for strike estimation.
    """
    if p <= 0 or p >= 1:
        return 0.0
    q = min(p, 1 - p)
    c = math.sqrt(-2.0 * math.log(q))
    num = 2.515517 + 0.802853 * c + 0.010328 * c ** 2
    den = 1.0 + 1.432788 * c + 0.189269 * c ** 2 + 0.001308 * c ** 3
    x = c - num / den
    return x if p >= 0.5 else -x


def _delta_proxy_range(
    price: float,
    iv: float,           # decimal, e.g. 1.20 for 120% IV
    dte: int,
    target_delta: float = 0.20,
    r: float = 0.045,
    band: float = 0.08,  # ±8% around the theoretical center strike
) -> tuple[float, float]:
    """
    Return (low_strike, high_strike) centred on the strike that should have
    approximately `target_delta` for a put, derived analytically from B-S d1.

    For a put: delta = N(d1) - 1
    Setting N(d1) - 1 = -target_delta  →  d1 = N⁻¹(1 - target_delta)
    Then solving d1 = [ln(S/K) + (r + σ²/2)T] / (σ√T) for K:
        K = S · exp(σ√T · d1_target - (r + σ²/2) · T)   [note sign flip]

    This naturally widens on high-IV names (ASTS 120% IV → strike ~40% OTM)
    and narrows on low-IV names (PLTR 50% IV → strike ~10% OTM).
    """
    T = dte / 365.0
    if T <= 0 or iv <= 0 or price <= 0:
        # hard fallback: 15-25% OTM band
        return price * 0.75, price * 0.85

    d1_target = _inv_norm(1.0 - target_delta)   # e.g. 0.842 for 20-delta put
    center = price * math.exp(
        -(d1_target * iv * math.sqrt(T) - (r + 0.5 * iv ** 2) * T)
    )
    return center * (1.0 - band), center * (1.0 + band)


def _to_date(val) -> Optional[date]:
    if val is None:
        return None
    if isinstance(val, date) and not isinstance(val, datetime):
        return val
    if isinstance(val, datetime):
        return val.date()
    try:
        return datetime.strptime(str(val)[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _parse_earnings(t: yf.Ticker) -> Optional[date]:
    """Return the next future earnings date, or None if unknown / already passed."""
    try:
        cal = t.calendar
        if cal is None:
            return None
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if ed:
                d = _to_date(ed[0] if isinstance(ed, list) else ed)
                # yfinance often returns the most-recent past date; discard it
                return d if d and d > date.today() else None
        elif hasattr(cal, "columns") and "Earnings Date" in cal.columns:
            d = _to_date(cal["Earnings Date"].iloc[0])
            return d if d and d > date.today() else None
    except Exception:
        pass
    return None


def _hv30(t: yf.Ticker) -> Optional[float]:
    """
    30-day realised (historical) volatility, annualised.
    Uses the last 30 daily log-returns from ~60 days of price history.
    Returns a decimal (e.g. 0.85 for 85% HV).
    """
    try:
        import numpy as np
        hist = t.history(period="60d")
        if hist.empty or len(hist) < 20:
            return None
        closes = hist["Close"].dropna()
        log_ret = np.log(closes / closes.shift(1)).dropna()
        sample = log_ret.tail(30)
        if len(sample) < 10:
            return None
        return float(sample.std() * np.sqrt(252))
    except Exception:
        return None


def _iv30_approx(t: yf.Ticker, price: float) -> Optional[float]:
    """Average ATM put IV from nearest expiration >= 20 DTE."""
    try:
        today = date.today()
        candidates = [
            e for e in (t.options or [])
            if (_to_date(e) - today).days >= 20
        ]
        if not candidates:
            return None
        puts = t.option_chain(candidates[0]).puts
        if puts.empty:
            return None
        puts = puts[puts["impliedVolatility"] > 0].copy()
        puts["_dist"] = (puts["strike"] - price).abs()
        atm = puts.nsmallest(2, "_dist")
        return float(atm["impliedVolatility"].mean())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Core per-symbol work (runs inside a thread with an external timeout)
# ---------------------------------------------------------------------------

def _fetch_symbol(symbol: str, config: dict) -> dict:
    """
    Fetches stock info + best contract for one symbol.
    All yfinance I/O happens here so a single future.cancel/timeout covers it.
    """
    t = yf.Ticker(symbol)

    # --- stock info ---
    fi = t.fast_info
    info = t.info or {}
    price = (
        fi.get("lastPrice")
        or fi.get("previousClose")
        or info.get("currentPrice")
    )
    price = float(price) if price else None

    earnings_date = _parse_earnings(t)
    iv30 = _iv30_approx(t, price) if price else None
    hv30 = _hv30(t)

    stock = {
        "symbol": symbol,
        "price": round(price, 2) if price else None,
        "marketCap": info.get("marketCap"),
        "sector": info.get("sector"),
        "iv30": round(iv30 * 100, 2) if iv30 else None,
        "hv30": round(hv30 * 100, 2) if hv30 else None,
        "earningsDate": earnings_date.isoformat() if earnings_date else None,
        "week52High": info.get("fiftyTwoWeekHigh"),
        "week52Low": info.get("fiftyTwoWeekLow"),
    }

    # --- options chain ---
    dte_low = config["dteLow"]
    dte_high = config["dteHigh"]
    target_dte = config.get("targetDTE", (dte_low + dte_high) // 2)
    collateral_cap = config["collateralCap"]
    min_oi = config["minOpenInterest"]
    earnings_buffer = config["earningsBufferDays"]
    target_delta = config["targetDelta"]

    today = date.today()
    contracts = []

    for exp_str in (t.options or []):
        exp_date = _to_date(exp_str)
        if exp_date is None:
            continue
        dte = (exp_date - today).days
        if not (dte_low <= dte <= dte_high):
            continue

        # earnings window logic
        earnings_in_window = False
        if earnings_date:
            days_before_exp = (exp_date - earnings_date).days
            if 0 <= days_before_exp <= earnings_buffer:
                continue  # expiry lands within buffer after earnings — skip
            if earnings_date <= exp_date:
                earnings_in_window = True

        try:
            puts = t.option_chain(exp_str).puts
        except Exception:
            continue

        if puts.empty:
            continue

        for _, row in puts.iterrows():
            strike = _safe_float(row.get("strike"))
            collateral = strike * 100

            # collateralCap is a soft flag, not a hard filter.
            # We evaluate all strikes so OTM/delta selection works correctly,
            # then mark contracts that exceed the cap so the UI can warn.
            exceeds_cap = collateral > collateral_cap

            oi = _safe_int(row.get("openInterest"))
            # OI is a soft flag — don't hard-filter here so that correct-delta
            # strikes (which may be lightly traded on high-IV names) stay in
            # the candidate pool.  The flag is surfaced to the UI and used as a
            # tiebreaker in best-contract selection.
            below_min_oi = oi < min_oi

            bid = _safe_float(row.get("bid"))
            ask = _safe_float(row.get("ask"))
            mid = round((bid + ask) / 2, 4)
            if mid <= 0:
                continue

            _iv_raw = _safe_float(row.get("impliedVolatility"))
            iv = _iv_raw if _iv_raw > 0 else None

            delta = None
            raw_delta = row.get("delta")
            if raw_delta is not None and not (
                isinstance(raw_delta, float) and math.isnan(raw_delta)
            ):
                delta = round(float(raw_delta), 4)

            # Black-Scholes fallback when yfinance doesn't supply delta
            if delta is None and iv and price and strike and dte:
                delta = bs_put_delta(
                    S=price,
                    K=strike,
                    T=dte / 365.0,
                    r=0.045,   # approximate risk-free rate; good enough for delta
                    sigma=iv,
                )
                if delta is not None:
                    delta = round(delta, 4)

            roc = round((mid / strike) * 100, 4)
            roc_ann = round(roc * (365 / dte), 4) if dte else None

            contracts.append({
                "strike": strike,
                "expiration": exp_str,
                "dte": dte,
                "bid": bid,
                "ask": ask,
                "mid": mid,
                "delta": delta,
                "collateralRequired": collateral,
                "exceedsCollateralCap": exceeds_cap,
                "lowOpenInterest": below_min_oi,
                "roc": roc,
                "rocAnnualized": roc_ann,
                "earningsInWindow": earnings_in_window,
                "openInterest": oi,
                "impliedVolatility": round(iv * 100, 2) if iv else None,
            })

    # --- pick best contract ---
    # Selection priority:
    #   1. Find the strike closest to targetDelta (or OTM proxy when delta is null)
    #   2. Among ties in delta distance, prefer the expiration closest to targetDTE
    #   3. Final tiebreak: highest ROC
    def dte_dist(c):
        return abs(c["dte"] - target_dte)

    # Sort key helpers
    # oi_pen: 0 if OI passes threshold, 1 if below — prefer liquid contracts but
    #         don't exclude them so high-IV names still find the right delta strike.
    def oi_pen(c):  return 1 if c.get("lowOpenInterest") else 0
    def dte_dist(c): return abs(c["dte"] - target_dte)

    best = None
    if contracts:
        with_delta = [c for c in contracts if c["delta"] is not None]
        if with_delta:
            # Key: (delta distance, OI penalty, DTE distance, -ROC)
            # OI penalty is a soft second-place tiebreaker: prefer liquid strikes
            # at the same delta distance before falling back to illiquid ones.
            best = min(
                with_delta,
                key=lambda c: (
                    abs(abs(c["delta"]) - target_delta),
                    oi_pen(c),
                    dte_dist(c),
                    -(c["roc"] or 0),
                ),
            )
        elif price:
            # No delta at all — use IV-aware strike range as proxy.
            rep_iv = iv30
            if rep_iv is None:
                ivs = [c["impliedVolatility"] / 100 for c in contracts
                       if c["impliedVolatility"]]
                rep_iv = sorted(ivs)[len(ivs) // 2] if ivs else None

            if rep_iv and rep_iv > 0:
                low_k, high_k = _delta_proxy_range(
                    price, rep_iv, target_dte, target_delta=target_delta
                )
                proxy = [c for c in contracts if low_k <= c["strike"] <= high_k]
            else:
                proxy = [c for c in contracts
                         if 0.10 <= (price - c["strike"]) / price <= 0.25]

            pool = proxy if proxy else contracts
            best = min(pool, key=lambda c: (oi_pen(c), dte_dist(c), -(c["roc"] or 0)))

    return {**stock, "contract": best, "error": False}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_stock_info(symbol: str) -> dict:
    """Fetch stock-level data only (no options). Used standalone if needed."""
    with ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(_fetch_symbol, symbol, {
            # minimal config — options chain won't return anything useful
            "dteLow": 0, "dteHigh": 0, "collateralCap": 0,
            "minOpenInterest": 999999, "earningsBufferDays": 0,
            "targetDelta": 0.20,
        })
        result = future.result(timeout=SYMBOL_TIMEOUT)
    stock_keys = ["symbol", "price", "marketCap", "sector", "iv30",
                  "earningsDate", "week52High", "week52Low"]
    return {k: result[k] for k in stock_keys}


def _fetch_heatmap(symbol: str, config: dict) -> dict:
    """
    Wide-range options fetch for the heatmap view.
    DTE 7-60, no collateral hard filter (soft flag only), all strikes with OI > 0.
    """
    t = yf.Ticker(symbol)

    fi = t.fast_info
    info = t.info or {}
    price = fi.get("lastPrice") or fi.get("previousClose") or info.get("currentPrice")
    price = float(price) if price else None

    earnings_date = _parse_earnings(t)
    collateral_cap = config["collateralCap"]
    # relaxed OI floor for heatmap — we want to see the full surface
    min_oi = max(50, config.get("minOpenInterest", 50) // 5)
    earnings_buffer = config["earningsBufferDays"]

    today = date.today()
    contracts = []

    for exp_str in (t.options or []):
        exp_date = _to_date(exp_str)
        if exp_date is None:
            continue
        dte = (exp_date - today).days
        if not (7 <= dte <= 60):
            continue

        earnings_in_window = False
        if earnings_date and earnings_date <= exp_date:
            days_before_exp = (exp_date - earnings_date).days
            if 0 <= days_before_exp <= earnings_buffer:
                earnings_in_window = True  # flag but don't skip — heatmap shows all
            else:
                earnings_in_window = True

        try:
            puts = t.option_chain(exp_str).puts
        except Exception:
            continue

        if puts.empty:
            continue

        for _, row in puts.iterrows():
            strike = _safe_float(row.get("strike"))
            collateral = strike * 100
            exceeds_cap = collateral > collateral_cap

            oi = _safe_int(row.get("openInterest"))
            below_min_oi = oi < min_oi  # soft flag; heatmap shows all liquidity levels

            bid = _safe_float(row.get("bid"))
            ask = _safe_float(row.get("ask"))
            mid = round((bid + ask) / 2, 4)
            if mid <= 0:
                continue

            _iv_raw = _safe_float(row.get("impliedVolatility"))
            iv = _iv_raw if _iv_raw > 0 else None

            delta = None
            raw_delta = row.get("delta")
            if raw_delta is not None and not (
                isinstance(raw_delta, float) and math.isnan(raw_delta)
            ):
                delta = round(float(raw_delta), 4)

            # Black-Scholes fallback when yfinance doesn't supply delta
            if delta is None and iv and price and strike and dte:
                delta = bs_put_delta(
                    S=price,
                    K=strike,
                    T=dte / 365.0,
                    r=0.045,
                    sigma=iv,
                )
                if delta is not None:
                    delta = round(delta, 4)

            roc = round((mid / strike) * 100, 4) if strike else None
            roc_ann = round(roc * (365 / dte), 4) if (roc and dte) else None

            contracts.append({
                "strike": strike,
                "expiration": exp_str,
                "dte": dte,
                "bid": bid,
                "ask": ask,
                "mid": mid,
                "delta": delta,
                "collateralRequired": collateral,
                "exceedsCollateralCap": exceeds_cap,
                "lowOpenInterest": below_min_oi,
                "roc": roc,
                "rocAnnualized": roc_ann,
                "earningsInWindow": earnings_in_window,
                "openInterest": oi,
                "impliedVolatility": round(iv * 100, 2) if iv else None,
            })

    return {
        "symbol": symbol,
        "price": round(price, 2) if price else None,
        "contracts": contracts,
    }


def get_heatmap(symbol: str, config: dict) -> dict:
    with ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(_fetch_heatmap, symbol, config)
        try:
            return future.result(timeout=15)
        except FuturesTimeout:
            return {"symbol": symbol, "price": None, "contracts": [], "error": "timeout"}
        except Exception as e:
            return {"symbol": symbol, "price": None, "contracts": [], "error": str(e)}


def scan_watchlist(watchlist: list[str], config: dict, max_workers: int = 6) -> list[dict]:
    """
    Fetch all symbols concurrently. Each symbol gets SYMBOL_TIMEOUT seconds.
    Timed-out or errored symbols come back with error: true.
    """
    results: list[dict] = [None] * len(watchlist)  # type: ignore

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        future_to_idx = {
            ex.submit(_fetch_symbol, sym, config): (i, sym)
            for i, sym in enumerate(watchlist)
        }

        for future in future_to_idx:
            i, sym = future_to_idx[future]
            try:
                results[i] = future.result(timeout=SYMBOL_TIMEOUT)
            except FuturesTimeout:
                results[i] = {"symbol": sym, "error": True, "errorMessage": "timeout"}
            except Exception as e:
                results[i] = {"symbol": sym, "error": True, "errorMessage": str(e)}

    return results


def score_results(results: list[dict]) -> list[dict]:
    """
    Compute wheelScore (0-100) for each result using cross-watchlist normalisation.
    Must be called AFTER scan_watchlist so all symbols' data is available.

    Components
    ----------
    IV Score        30 pts  – iv30 normalised across watchlist
    Seller's Edge   20 pts  – (iv30 - hv30) > 0 signals rich premium
    ROC Score       25 pts  – contract ROC normalised across watchlist
    Liquidity       15 pts  – contract openInterest normalised across watchlist
    Earnings Safety 10 pts  – how far earnings are from expiration
    """
    valid = [r for r in results if not r.get("error") and r.get("contract")]

    if not valid:
        for r in results:
            r["wheelScore"] = None
        return results

    # Collect finite values for per-metric normalisation
    iv30s = [r["iv30"] for r in valid if r.get("iv30")]
    rocs  = [r["contract"]["roc"] for r in valid if r["contract"].get("roc")]
    ois   = [r["contract"]["openInterest"] for r in valid
             if r["contract"].get("openInterest")]

    def norm(val, pool: list) -> float:
        """Linear normalise val into [0, 1] given the observed pool."""
        if not pool or len(pool) < 2:
            return 0.5
        lo, hi = min(pool), max(pool)
        if hi == lo:
            return 0.5
        return max(0.0, min(1.0, (val - lo) / (hi - lo)))

    for r in results:
        if r.get("error") or not r.get("contract"):
            r["wheelScore"] = None
            continue

        c = r["contract"]

        # 1. IV score (30 pts) — higher IV favours premium sellers
        iv = r.get("iv30") or 0.0
        iv_score = norm(iv, iv30s) * 30

        # 2. Seller's Edge (20 pts) — IV premium over realised vol
        hv = r.get("hv30") or 0.0
        edge = iv - hv                         # both in percent-units (e.g. 85.0)
        if edge > 0:
            # scale: full 20 pts at a 20-point IV-HV spread; cap at 1.0
            edge_score = min(1.0, edge / 20.0) * 20
        else:
            edge_score = 0.0

        # 3. ROC score (25 pts)
        roc = c.get("roc") or 0.0
        roc_score = norm(roc, rocs) * 25

        # 4. Liquidity score (15 pts)
        oi = c.get("openInterest") or 0
        oi_score = norm(oi, ois) * 15

        # 5. Earnings Safety (10 pts)
        earnings_date_str = r.get("earningsDate")
        earnings_in_window = c.get("earningsInWindow", False)
        if earnings_in_window:
            earn_score = 0.0
        elif not earnings_date_str:
            earn_score = 10.0                  # no known earnings — safest
        else:
            days_away = (date.fromisoformat(earnings_date_str) - date.today()).days
            if days_away > 45:
                earn_score = 10.0
            elif days_away >= 30:
                earn_score = 5.0
            else:
                earn_score = 0.0

        total = iv_score + edge_score + roc_score + oi_score + earn_score
        r["wheelScore"] = round(total, 1)

    return results
