"""
Roll compare for short options you already have on (covered calls and CSPs).

For one open short option it returns:
  - the position as it stands: price, ITM/OTM, extrinsic left, cost to close,
    and % of max profit captured (the close-early rule lives on that number)
  - every roll candidate: same type, a later expiry, strike at or "better"
    than today's (puts: same or lower, calls: same or higher), with the net
    credit/debit for buy-to-close + sell-to-open, credit per added day, the
    new breakeven (puts) or if-called P/L vs basis (calls), delta, earnings
    in the new window, open interest
  - two picks among liquid credit rolls: most credit per added day, and the
    biggest strike improvement that still rolls for a credit

Net is shown at mid (what you usually work toward) and at natural (sell at
bid, buy at ask: the worst fill), because the gap between the two is often
the whole credit on thin weekly strikes.

`credit_so_far` = all premium already collected on this chain per share,
including the open contract's own sale. Adding the roll's net to it gives the
chain's total, which is what moves a put's effective basis or a call's
if-called result.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from datetime import date
from typing import Optional

import yfinance as yf

import schwab_source
from data import (
    SYMBOL_TIMEOUT,
    _parse_earnings,
    _row_mid,
    _safe_float,
    _safe_int,
    _to_date,
    bs_call_delta,
    bs_put_delta,
)

MAX_ADDED_DAYS = 63      # look up to ~9 weeks past the current expiry
STRIKE_BAND = 0.20       # candidate strikes within 20% of the current strike
LOW_OI = 100             # below this the mid is rarely a real fill


def _price(symbol: str, t: yf.Ticker) -> Optional[float]:
    try:
        return schwab_source.get_price(symbol)
    except schwab_source.SchwabUnavailable:
        fi = t.fast_info
        p = fi.get("lastPrice") or fi.get("previousClose") or (t.info or {}).get("currentPrice")
        return float(p) if p else None


def _chain(symbol: str, t: yf.Ticker, is_put: bool) -> tuple[dict, str]:
    """{exp_str: DataFrame} for the side we need, Schwab first."""
    try:
        ch = schwab_source.get_put_chain(symbol) if is_put else schwab_source.get_call_chain(symbol)
        return ch, "schwab"
    except schwab_source.SchwabUnavailable:
        out = {}
        for exp in (t.options or []):
            try:
                oc = t.option_chain(exp)
                out[exp] = oc.puts if is_put else oc.calls
            except Exception:
                continue
        return out, "yfinance"


def _delta(row, price, strike, dte, is_put) -> Optional[float]:
    d = row.get("delta")
    try:
        d = float(d)
        if d == d:                       # not NaN
            return round(abs(d), 3)
    except (TypeError, ValueError):
        pass
    iv = _safe_float(row.get("impliedVolatility"))
    if iv > 0 and price and dte > 0:
        f = bs_put_delta if is_put else bs_call_delta
        v = f(S=price, K=strike, T=dte / 365.0, r=0.045, sigma=iv)
        return round(abs(v), 3) if v is not None else None
    return None


def _quote(row) -> dict:
    bid, ask = _safe_float(row.get("bid")), _safe_float(row.get("ask"))
    mid, stale = _row_mid(row, bid, ask)
    return {"bid": bid, "ask": ask, "mid": mid, "stale": stale,
            "openInterest": _safe_int(row.get("openInterest"))}


def _fetch_rolls(
    symbol: str,
    put_call: str,
    strike: float,
    expiration: str,
    qty: int = 1,
    open_premium: Optional[float] = None,
    credit_so_far: Optional[float] = None,
    cost_basis: Optional[float] = None,
) -> dict:
    symbol = symbol.upper()
    is_put = put_call.upper().startswith("P")
    cur_exp = _to_date(expiration)
    if cur_exp is None:
        return {"symbol": symbol, "error": f"bad expiration {expiration!r}"}
    today = date.today()
    cur_dte = (cur_exp - today).days

    t = yf.Ticker(symbol)
    price = _price(symbol, t)
    earnings = _parse_earnings(t)
    chain, source = _chain(symbol, t, is_put)
    if not chain:
        return {"symbol": symbol, "error": "no option chain available"}

    # ── the position as it stands ─────────────────────────────────────────
    cur_rows = chain.get(cur_exp.isoformat())
    cur = None
    if cur_rows is not None and not cur_rows.empty:
        m = cur_rows[(cur_rows["strike"] - strike).abs() < 1e-6]
        if not m.empty:
            cur = _quote(m.iloc[0])
            cur["delta"] = _delta(m.iloc[0], price, strike, max(cur_dte, 1), is_put)
    if cur is None:
        return {"symbol": symbol, "error": f"{expiration} ${strike:g} {'put' if is_put else 'call'} not found in the chain"}

    intrinsic = max(0.0, (strike - price) if is_put else (price - strike)) if price else 0.0
    open_prem = open_premium if open_premium is not None else None
    chain_credit = credit_so_far if credit_so_far is not None else (open_prem or 0.0)
    position = {
        "price": round(price, 2) if price else None,
        "dte": cur_dte,
        "bid": cur["bid"], "ask": cur["ask"], "mid": cur["mid"], "stale": cur["stale"],
        "delta": cur["delta"],
        "itm": intrinsic > 0,
        "moneynessPct": round(((price - strike) / price * 100) if price else 0, 1),
        "intrinsic": round(intrinsic, 2),
        "extrinsic": round(max(0.0, cur["mid"] - intrinsic), 2),
        "closePnl": round((open_prem - cur["mid"]) * 100 * qty, 2) if open_prem is not None else None,
        "pctOfMaxProfit": round((open_prem - cur["mid"]) / open_prem * 100, 1) if open_prem else None,
        "earningsBeforeExpiry": bool(earnings and today <= earnings <= cur_exp),
    }

    # ── roll candidates ───────────────────────────────────────────────────
    lo = strike * (1 - STRIKE_BAND) if is_put else strike
    hi = strike if is_put else strike * (1 + STRIKE_BAND)
    cands = []
    for exp_str, rows in chain.items():
        exp = _to_date(exp_str)
        if exp is None or rows is None or rows.empty:
            continue
        added = (exp - cur_exp).days
        if added <= 0 or added > MAX_ADDED_DAYS:
            continue
        dte = (exp - today).days
        for _, row in rows.iterrows():
            k = _safe_float(row.get("strike"))
            if not (lo - 1e-6 <= k <= hi + 1e-6):
                continue
            q = _quote(row)
            if q["mid"] <= 0:
                continue
            net_mid = round(q["mid"] - cur["mid"], 2)
            net_nat = round(q["bid"] - cur["ask"], 2) if (q["bid"] > 0 and cur["ask"] > 0) else None
            total = chain_credit + net_mid
            c = {
                "expiration": exp.isoformat(), "dte": dte, "addedDays": added,
                "strike": k, "strikeChange": round(k - strike, 2),
                "bid": q["bid"], "ask": q["ask"], "mid": q["mid"], "stale": q["stale"] or cur["stale"],
                "delta": _delta(row, price, k, dte, is_put),
                "openInterest": q["openInterest"], "lowOI": q["openInterest"] < LOW_OI,
                "netMid": net_mid, "netNatural": net_nat,
                "netTotal": round(net_mid * 100 * qty, 2),
                "creditPerDay": round(net_mid / added * 100 * qty, 2),
                "chainCredit": round(total, 2),
                "earningsInWindow": bool(earnings and today <= earnings <= exp),
            }
            if is_put:
                c["breakeven"] = round(k - total, 2)       # effective cost if assigned
                c["annualizedPct"] = round(net_mid / k * 365 / added * 100, 1) if net_mid > 0 else None
            elif cost_basis:
                c["ifCalledPnl"] = round((k - cost_basis + total) * 100 * qty, 2)
                c["annualizedPct"] = round(net_mid / cost_basis * 365 / added * 100, 1) if net_mid > 0 else None
            cands.append(c)

    cands.sort(key=lambda c: (c["expiration"], c["strike"] if not is_put else -c["strike"]))

    # ── picks: liquid credit rolls only ───────────────────────────────────
    ok = [c for c in cands if c["netMid"] > 0 and not c["lowOI"]]
    picks = {}
    if ok:
        picks["bestCreditPerDay"] = max(ok, key=lambda c: c["creditPerDay"])
        better = [c for c in ok if c["strikeChange"] != 0]
        if better:
            picks["bestStrikeForCredit"] = max(better, key=lambda c: (abs(c["strikeChange"]), c["netMid"]))

    return {
        "symbol": symbol, "putCall": "PUT" if is_put else "CALL",
        "strike": strike, "expiration": cur_exp.isoformat(), "qty": qty,
        "openPremium": open_prem, "creditSoFar": chain_credit, "costBasis": cost_basis,
        "earningsDate": earnings.isoformat() if earnings else None,
        "position": position, "candidates": cands, "picks": picks,
        "dataSource": source, "error": False,
    }


def get_rolls(symbol: str, put_call: str, strike: float, expiration: str, **kw) -> dict:
    with ThreadPoolExecutor(max_workers=1) as ex:
        f = ex.submit(_fetch_rolls, symbol, put_call, strike, expiration, **kw)
        try:
            return f.result(timeout=SYMBOL_TIMEOUT * 2)
        except FuturesTimeout:
            return {"symbol": symbol, "error": "timeout"}
        except Exception as e:
            return {"symbol": symbol, "error": str(e)}
