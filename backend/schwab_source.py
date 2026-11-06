"""
Optional Schwab data source, via schwab-oauth-service.

Primary source for live price and option-chain data (real broker-quoted
bid/ask and Greeks) when SCHWAB_OAUTH_SERVICE_URL and
SCHWAB_OAUTH_SERVICE_SECRET are configured. data.py falls back to yfinance
on SchwabUnavailable. Deliberately does NOT touch HV30/SMA20/sector/
marketCap/earnings — those stay yfinance-only regardless of Schwab's
availability, since schwab-oauth-service doesn't expose them.

get_put_chain/get_call_chain return {expiration_str: DataFrame} with the
same columns yfinance's t.option_chain(exp).puts/.calls has (strike, bid,
ask, openInterest, impliedVolatility, delta) — this is what lets the
existing per-row processing loops in data.py work unchanged regardless of
which source they're fed from.
"""
import os
from typing import Optional

import httpx
import pandas as pd

BASE_URL = os.environ.get("SCHWAB_OAUTH_SERVICE_URL", "").rstrip("/")
SHARED_SECRET = os.environ.get("SCHWAB_OAUTH_SERVICE_SECRET")
TIMEOUT = 8


class SchwabUnavailable(Exception):
    """Schwab data can't be used right now — caller should fall back to yfinance."""


def _get(path: str, params: Optional[dict] = None) -> dict:
    if not BASE_URL or not SHARED_SECRET:
        raise SchwabUnavailable("SCHWAB_OAUTH_SERVICE_URL/SECRET not configured")
    try:
        resp = httpx.get(
            f"{BASE_URL}{path}",
            params=params,
            headers={"X-Internal-Secret": SHARED_SECRET},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as exc:
        raise SchwabUnavailable(str(exc)) from exc


def get_price(symbol: str) -> float:
    data = _get(f"/quote/{symbol}")
    quote = (data.get(symbol) or {}).get("quote", {})
    price = quote.get("lastPrice") or quote.get("mark") or quote.get("closePrice")
    if not price:
        raise SchwabUnavailable(f"no usable price in Schwab quote for {symbol}")
    return float(price)


def _chain_by_expiration(symbol: str, exp_map_key: str) -> dict[str, pd.DataFrame]:
    data = _get(f"/chains/{symbol}", params={"strikeCount": 40})
    exp_map = data.get(exp_map_key) or {}

    rows_by_exp: dict[str, list[dict]] = {}
    for exp_key, strikes in exp_map.items():
        # Schwab keys expirations as "YYYY-MM-DD:daysToExpiration"
        exp_str = exp_key.split(":")[0]
        rows = rows_by_exp.setdefault(exp_str, [])
        for strike_str, contracts in strikes.items():
            for c in contracts:
                iv_raw = c.get("volatility")  # Schwab reports as a percentage, e.g. 42.5
                rows.append({
                    "strike": float(strike_str),
                    # Chain contracts use "bid"/"ask"/"last"/"mark" — "bidPrice"/
                    # "askPrice" only exist on the equity /quotes payload.
                    "bid": c.get("bid") or c.get("bidPrice") or 0.0,
                    "ask": c.get("ask") or c.get("askPrice") or 0.0,
                    "lastPrice": c.get("mark") or c.get("last") or c.get("closePrice") or 0.0,
                    "openInterest": c.get("openInterest") or 0,
                    "impliedVolatility": (iv_raw / 100.0) if iv_raw and iv_raw > 0 else None,
                    "delta": c.get("delta"),
                })

    if not rows_by_exp:
        raise SchwabUnavailable(f"empty option chain from Schwab for {symbol}")
    return {exp: pd.DataFrame(rows) for exp, rows in rows_by_exp.items()}


def get_put_chain(symbol: str) -> dict[str, pd.DataFrame]:
    return _chain_by_expiration(symbol, "putExpDateMap")


def get_call_chain(symbol: str) -> dict[str, pd.DataFrame]:
    return _chain_by_expiration(symbol, "callExpDateMap")


def get_fundamentals(symbols: list[str]) -> dict[str, dict]:
    """{symbol: {assetType, netProfitMarginTTM, revChangeTTM, marketCap, ...}}
    via the proxy's /fundamentals (Schwab instruments, FUNDAMENTAL projection).
    No daily cap, unlike Alpha Vantage's free tier."""
    out: dict[str, dict] = {}
    for i in range(0, len(symbols), 50):
        out.update(_get("/fundamentals", params={"symbols": ",".join(symbols[i:i + 50])}) or {})
    return out


def _parse_occ(sym: str) -> Optional[dict]:
    """'HOOD  261120P00075000' -> {expiration: '2026-11-20', putCall: 'PUT', strike: 75.0}"""
    s = (sym or "").replace(" ", "")
    tail = s[-15:]
    if len(s) < 16 or tail[6] not in "CP" or not tail[:6].isdigit() or not tail[7:].isdigit():
        return None
    return {
        "expiration": f"20{tail[0:2]}-{tail[2:4]}-{tail[4:6]}",
        "putCall": "PUT" if tail[6] == "P" else "CALL",
        "strike": int(tail[7:]) / 1000.0,
    }


def get_option_positions() -> list[dict]:
    """Open SHORT option positions in the linked Schwab account, via the proxy's
    /positions. [{symbol, putCall, strike, expiration, qty, openPremium, broker}]"""
    data = _get("/positions")
    acct = data.get("securitiesAccount", data) if isinstance(data, dict) else {}
    out = []
    for p in acct.get("positions", []) or []:
        inst = p.get("instrument") or {}
        if inst.get("assetType") != "OPTION":
            continue
        short = _num(p.get("shortQuantity"))
        if short <= 0:
            continue
        occ = _parse_occ(inst.get("symbol", ""))
        if not occ:
            continue
        out.append({
            "symbol": (inst.get("underlyingSymbol") or inst.get("symbol", "").split()[0]).upper(),
            **occ,
            "putCall": inst.get("putCall") or occ["putCall"],
            "qty": int(short),
            "openPremium": round(_num(p.get("averagePrice")), 2) or None,
            "broker": "Schwab",
        })
    return out


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
