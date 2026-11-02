"""
Next-earnings dates from Alpha Vantage EARNINGS_CALENDAR.

One call returns every US company reporting in the next 3 months, so the
whole watchlist costs 1 request a day against the free key's 25 (the quality
grades use the rest). The CSV is cached on the Railway volume and refreshed
once per calendar day, on first use.

lookup() returns None when Alpha Vantage has no date for a symbol (ETFs,
funds, or nothing scheduled inside 3 months), and data._parse_earnings then
falls back to yfinance, so this can only add information, never remove it.
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
from datetime import date
from pathlib import Path
from typing import Optional

import httpx

API_KEY = os.environ.get("ALPHA_VANTAGE_API_KEY", "")
DATA_DIR = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", Path(__file__).parent))
CACHE_PATH = DATA_DIR / "earnings_calendar.json"

_lock = threading.Lock()
_cache: Optional[dict] = None   # {"fetched": iso, "attempted": iso, "dates": {SYM: iso}}


def _load() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else {}
    except Exception:
        return {}


def _save(data: dict) -> None:
    try:
        CACHE_PATH.write_text(json.dumps(data))
    except Exception:
        pass


def _fetch() -> Optional[dict]:
    """One EARNINGS_CALENDAR call -> {SYM: 'YYYY-MM-DD'}, or None on cap/error."""
    r = httpx.get(
        "https://www.alphavantage.co/query",
        params={"function": "EARNINGS_CALENDAR", "horizon": "3month", "apikey": API_KEY},
        timeout=30,
    )
    text = r.text.lstrip()
    if r.status_code != 200 or text.startswith("{"):   # JSON body = rate-limit/daily-cap note
        return None
    today = date.today().isoformat()
    dates: dict[str, str] = {}
    for row in csv.DictReader(io.StringIO(text)):
        sym, d = (row.get("symbol") or "").strip().upper(), (row.get("reportDate") or "").strip()
        if not sym or len(d) != 10 or d < today:
            continue
        if sym not in dates or d < dates[sym]:          # keep the nearest upcoming report
            dates[sym] = d
    return dates or None


def _ensure_fresh() -> dict:
    """Return the cache, refreshing it at most once per day (one API call)."""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load()
        today = date.today().isoformat()
        if API_KEY and _cache.get("attempted") != today:
            _cache["attempted"] = today              # one try a day, even if it fails
            try:
                dates = _fetch()
            except Exception:
                dates = None
            if dates:
                _cache["dates"], _cache["fetched"] = dates, today
            _save(_cache)
        return _cache


def lookup(symbol: str) -> Optional[date]:
    """Next earnings date for symbol, or None if Alpha Vantage doesn't have one."""
    if not symbol:
        return None
    d = (_ensure_fresh().get("dates") or {}).get(symbol.upper())
    if not d:
        return None
    try:
        out = date.fromisoformat(d)
    except ValueError:
        return None
    return out if out >= date.today() else None   # stale cache: drop dates already past
