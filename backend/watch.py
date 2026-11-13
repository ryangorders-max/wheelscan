"""
Quick watchlist: live quotes for a short list of symbols, built for a phone.

Separate from the screener's scan list on purpose: watching a name never
makes the screener spend option-chain calls on it. Quotes come from Schwab in
one batched call; if Schwab is down (token lapsed), yfinance fills in so the
list still shows something, flagged as delayed. A 10-second cache means two
open screens don't double the Schwab traffic.
"""
from __future__ import annotations

import threading
import time
from datetime import date

import yfinance as yf

import earnings_av
import schwab_source

CACHE_S = 10
_lock = threading.Lock()
_cache: dict = {"key": None, "at": 0.0, "data": None}


def _yf_quotes(symbols: list[str]) -> dict[str, dict]:
    out = {}
    for s in symbols:
        try:
            fi = yf.Ticker(s).fast_info
            last, prev = fi.get("lastPrice"), fi.get("previousClose")
            if not last:
                continue
            out[s] = {
                "last": round(float(last), 2),
                "change": round(last - prev, 2) if prev else None,
                "changePct": round((last - prev) / prev * 100, 2) if prev else None,
                "high": fi.get("dayHigh"), "low": fi.get("dayLow"), "prevClose": prev,
                "volume": fi.get("lastVolume"), "high52": fi.get("yearHigh"), "low52": fi.get("yearLow"),
            }
        except Exception:
            continue
    return out


def _held(cfg: dict) -> dict[str, list[str]]:
    """What you have on in each name, for the row badge."""
    held: dict[str, list[str]] = {}
    for w in cfg.get("watchlist", []):
        if (w.get("shares") or 0) > 0:
            held.setdefault(w["symbol"].upper(), []).append(f"{w['shares']} sh")
    today = date.today().isoformat()
    for o in cfg.get("openOptions", []):
        if (o.get("expiration") or "") < today:
            continue
        exp = o["expiration"]
        k = f"{float(o['strike']):g}{'P' if str(o.get('putCall', '')).upper().startswith('P') else 'C'}"
        held.setdefault(o["symbol"].upper(), []).append(f"−{o.get('qty', 1)} {k} {exp[5:7]}/{exp[8:10]}")
    return held


def default_symbols(cfg: dict) -> list[str]:
    """First run: start the list with whatever you hold."""
    return sorted(_held(cfg).keys())


def get_watch(cfg: dict) -> dict:
    symbols = cfg.get("quickWatch")
    if symbols is None:
        symbols = default_symbols(cfg)
    symbols = [s.upper() for s in symbols if s]
    key = ",".join(symbols)

    with _lock:
        if _cache["key"] == key and time.time() - _cache["at"] < CACHE_S:
            quotes, source, err = _cache["data"]
        else:
            try:
                quotes, source, err = schwab_source.get_quotes(symbols), "schwab", None
            except schwab_source.SchwabUnavailable as exc:
                quotes, source, err = _yf_quotes(symbols), "yfinance", str(exc)
            _cache.update(key=key, at=time.time(), data=(quotes, source, err))

    earnings = {}
    for s in symbols:
        try:
            d = earnings_av.lookup(s)
            if d:
                earnings[s] = d.isoformat()
        except Exception:
            pass

    return {
        "symbols": symbols, "quotes": quotes, "earnings": earnings, "held": _held(cfg),
        "source": source, "schwabError": err, "asOf": int(time.time()),
    }
