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
                    "bid": c.get("bidPrice") or 0.0,
                    "ask": c.get("askPrice") or 0.0,
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
