"""
AI Council — sends one cash-secured-put setup to Claude, GPT and Gemini in
parallel, then runs a synthesis pass that maps where they DISAGREE rather than
blending them into one answer.

Design choices (why it looks the way it does):
  * Every model gets the same live snapshot from WheelScan's own data feed
    (Schwab -> yfinance fallback), plus recent headlines. Models are told the
    snapshot beats their memory, because none of them know today's price/IV.
  * The question is assignment-centric: "would owning this at breakeven for
    3-6 months be acceptable?" — that's where the wheel actually hurts.
  * Numeric spread (conviction, floor) is computed in code, not by an LLM.
    The synthesis model only does the qualitative disagreement map and is
    told not to add its own opinion.
  * Results are cached per symbol/strike/expiration/day, every paid call is
    logged to council_usage.jsonl, and a monthly $ cap + hourly run limit
    stop a bug (or a stranger hitting the public Railway URL) from burning money.

Env vars:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY   (any missing provider is skipped)
  COUNCIL_CLAUDE_MODEL   default claude-sonnet-5
  COUNCIL_OPENAI_MODEL   default gpt-6-sol
  COUNCIL_GEMINI_MODEL   default gemini-3.8-flash
  COUNCIL_SYNTH_PROVIDER default claude   (claude | openai | gemini)
  COUNCIL_SYNTH_MODEL    default = that provider's council model
  COUNCIL_OPENAI_REASONING_EFFORT  default low  (set to "none" to omit the param)
  COUNCIL_MONTHLY_CAP_USD          default 10
  COUNCIL_MAX_RUNS_PER_HOUR        default 20   (fresh runs; cache hits are free)
  COUNCIL_FREE_PROVIDERS           e.g. "gemini" — logged at $0 while you're on its free tier
  TOOLING_FIXED_COSTS              e.g. "Railway=5" — monthly bills that exist only because of trading
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import httpx

try:
    from zoneinfo import ZoneInfo
    _NY = ZoneInfo("America/New_York")
except Exception:  # container without tzdata
    _NY = timezone(timedelta(hours=-4))

# ---------------------------------------------------------------------------
# Provider config
# ---------------------------------------------------------------------------

PROVIDERS: dict[str, dict] = {
    "claude": {
        "label": "Claude",
        "key_env": "ANTHROPIC_API_KEY",
        "model": os.environ.get("COUNCIL_CLAUDE_MODEL", "claude-sonnet-5"),
    },
    "openai": {
        "label": "GPT",
        "key_env": "OPENAI_API_KEY",
        "model": os.environ.get("COUNCIL_OPENAI_MODEL", "gpt-6-sol"),
    },
    "gemini": {
        "label": "Gemini",
        "key_env": "GEMINI_API_KEY",
        "model": os.environ.get("COUNCIL_GEMINI_MODEL", "gemini-3.8-flash"),
    },
}

SYNTH_PROVIDER = os.environ.get("COUNCIL_SYNTH_PROVIDER", "claude")
SYNTH_MODEL = os.environ.get("COUNCIL_SYNTH_MODEL") or PROVIDERS.get(SYNTH_PROVIDER, PROVIDERS["claude"])["model"]
OPENAI_EFFORT = os.environ.get("COUNCIL_OPENAI_REASONING_EFFORT", "low")
MONTHLY_CAP = float(os.environ.get("COUNCIL_MONTHLY_CAP_USD", "10"))
MAX_RUNS_PER_HOUR = int(os.environ.get("COUNCIL_MAX_RUNS_PER_HOUR", "20"))
# Providers you use on a free tier (e.g. "gemini"). Their calls are logged at $0
# actual cost, with the paid-price equivalent kept as listCost for reference.
FREE_PROVIDERS = {p.strip() for p in os.environ.get("COUNCIL_FREE_PROVIDERS", "").split(",") if p.strip()}


def _parse_fixed_costs(raw: str) -> dict[str, float]:
    """TOOLING_FIXED_COSTS="Railway=5,Market data=0" -> {"Railway": 5.0, ...}.
    Monthly costs that exist only because of trading. Bad entries are ignored."""
    out: dict[str, float] = {}
    for part in raw.split(","):
        if "=" not in part:
            continue
        name, _, val = part.partition("=")
        try:
            out[name.strip()] = float(val.strip().lstrip("$"))
        except ValueError:
            pass
    return {k: v for k, v in out.items() if k}


FIXED_COSTS = _parse_fixed_costs(os.environ.get("TOOLING_FIXED_COSTS", ""))
CALL_TIMEOUT = 120  # seconds per model call

# USD per 1M tokens (input, output). Checked Sep 2026 against each provider's
# pricing page — update here if prices change. Unknown model -> cost shown as null.
PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "gpt-6-astra": (10.00, 50.00),
    "gpt-6-sol": (2.00, 10.00),
    "gpt-6-luna": (0.10, 0.50),
    "gemini-3.8-flash": (0.75, 3.75),   # promo price through 2026-12-31, then 1.50 / 7.50
    "gemini-3.7-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-pro-preview": (2.00, 12.00),
}


def _cost(model: str, tokens_in: int, tokens_out: int) -> Optional[float]:
    p = PRICES.get(model)
    if not p:
        return None
    return round(tokens_in / 1e6 * p[0] + tokens_out / 1e6 * p[1], 5)


def configured_providers() -> list[str]:
    return [k for k, p in PROVIDERS.items() if os.environ.get(p["key_env"])]


# ---------------------------------------------------------------------------
# Storage: cache + usage log (lives on the Railway volume via DATA_DIR)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
DATA_DIR: Path = Path(".")


def init_storage(data_dir: Path) -> None:
    global DATA_DIR
    DATA_DIR = data_dir


def _cache_path() -> Path:
    return DATA_DIR / "council_cache.json"


def _usage_path() -> Path:
    return DATA_DIR / "council_usage.jsonl"


def _today_ny() -> str:
    return datetime.now(_NY).date().isoformat()


def cache_key(symbol: str, strike: Optional[float], expiration: Optional[str]) -> str:
    s = f"{float(strike):g}" if strike is not None else None  # 62 and 62.0 hit the same entry
    return f"{symbol}|{s}|{expiration}|{_today_ny()}"


def cache_get(key: str) -> Optional[dict]:
    with _lock:
        try:
            return json.loads(_cache_path().read_text()).get(key)
        except Exception:
            return None


def cache_put(key: str, value: dict) -> None:
    with _lock:
        try:
            data = json.loads(_cache_path().read_text())
        except Exception:
            data = {}
        # keep only the last 14 days so the file doesn't grow forever
        cutoff = (datetime.now(_NY).date() - timedelta(days=14)).isoformat()
        data = {k: v for k, v in data.items() if k.rsplit("|", 1)[-1] >= cutoff}
        data[key] = value
        _cache_path().write_text(json.dumps(data))


def log_usage(entry: dict) -> None:
    with _lock:
        with _usage_path().open("a") as f:
            f.write(json.dumps(entry) + "\n")


def _read_usage() -> list[dict]:
    try:
        return [json.loads(l) for l in _usage_path().read_text().splitlines() if l.strip()]
    except Exception:
        return []


def usage_summary() -> dict:
    import calendar
    now = datetime.now(_NY)
    month = now.strftime("%Y-%m")
    rows = _read_usage()
    month_rows = [r for r in rows if r.get("ts", "").startswith(month)]
    runs = {r["run_id"] for r in month_rows if r.get("run_id")}
    spend = sum(r.get("cost") or 0 for r in month_rows)
    list_spend = sum(r.get("listCost", r.get("cost")) or 0 for r in month_rows)
    by_model: dict[str, float] = {}
    for r in month_rows:
        by_model[r.get("model", "?")] = round(by_model.get(r.get("model", "?"), 0) + (r.get("cost") or 0), 4)

    # straight-line projection to month end from days elapsed
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    projected = spend / now.day * days_in_month if spend else 0.0

    # every month on record, newest first — this is your running cost ledger
    history: dict[str, dict] = {}
    for r in rows:
        m = r.get("ts", "")[:7]
        if not m:
            continue
        h = history.setdefault(m, {"month": m, "spendUSD": 0.0, "_runs": set()})
        h["spendUSD"] += r.get("cost") or 0
        if r.get("run_id"):
            h["_runs"].add(r["run_id"])
    history_list = [
        {"month": m, "spendUSD": round(h["spendUSD"], 4), "runs": len(h["_runs"]),
         "totalUSD": round(h["spendUSD"] + sum(FIXED_COSTS.values()), 2)}
        for m, h in sorted(history.items(), reverse=True)
    ]
    fixed_total = round(sum(FIXED_COSTS.values()), 2)

    return {
        "month": month,
        "spendUSD": round(spend, 4),
        "projectedMonthUSD": round(projected, 2),
        "fixedCosts": FIXED_COSTS,
        "fixedTotalUSD": fixed_total,
        # what trading tooling costs you this month: fixed bills + AI usage so far
        "toolingTotalUSD": round(fixed_total + spend, 2),
        "toolingProjectedUSD": round(fixed_total + projected, 2),
        "freeTierSavingsUSD": round(list_spend - spend, 4),
        "capUSD": MONTHLY_CAP,
        "runs": len(runs),
        "avgPerRunUSD": round(spend / len(runs), 4) if runs else None,
        "byModel": by_model,
        "history": history_list,
        "freeProviders": sorted(FREE_PROVIDERS),
        "configuredProviders": configured_providers(),
        "models": {k: PROVIDERS[k]["model"] for k in PROVIDERS},
        "synthesis": {"provider": SYNTH_PROVIDER, "model": SYNTH_MODEL},
    }


def _budget_block() -> Optional[str]:
    s = usage_summary()
    if s["spendUSD"] >= MONTHLY_CAP:
        return f"Monthly council cap reached (${s['spendUSD']:.2f} of ${MONTHLY_CAP:.2f}). Raise COUNCIL_MONTHLY_CAP_USD to continue."
    hour_ago = (datetime.now(_NY) - timedelta(hours=1)).isoformat()
    recent = {r["run_id"] for r in _read_usage() if r.get("ts", "") >= hour_ago and r.get("run_id")}
    if len(recent) >= MAX_RUNS_PER_HOUR:
        return f"Hourly limit of {MAX_RUNS_PER_HOUR} fresh council runs reached. Cached results still work."
    return None


# ---------------------------------------------------------------------------
# Context: the live snapshot every model receives
# ---------------------------------------------------------------------------

def _headlines(symbol: str, limit: int = 8) -> list[dict]:
    """Recent headlines via yfinance (already a dependency). Handles both the
    old flat format and the 2025+ nested 'content' format; never raises."""
    try:
        import yfinance as yf
        items = yf.Ticker(symbol).news or []
    except Exception:
        return []
    out = []
    for it in items[:limit]:
        c = it.get("content") if isinstance(it.get("content"), dict) else it
        title = c.get("title")
        if not title:
            continue
        pub = c.get("pubDate") or c.get("displayTime")
        if not pub and it.get("providerPublishTime"):
            pub = datetime.fromtimestamp(it["providerPublishTime"], timezone.utc).isoformat()
        prov = c.get("provider")
        publisher = prov.get("displayName") if isinstance(prov, dict) else (c.get("publisher") or prov)
        out.append({"title": title, "published": (pub or "")[:10], "source": publisher})
    return out


def build_context(symbol: str, cfg: dict, contract_override: Optional[dict]) -> dict:
    """Blocking — call via asyncio.to_thread. Uses WheelScan's own scan path so
    the council sees exactly the data the screener shows."""
    from data import _fetch_symbol  # local import keeps council importable in tests

    snap = _fetch_symbol(symbol, cfg)
    contract = contract_override or snap.get("contract")
    position = next(
        (w for w in cfg.get("watchlist", [])
         if isinstance(w, dict) and w.get("symbol") == symbol and w.get("shares")),
        None,
    )

    price = snap.get("price")
    derived: dict[str, Any] = {}
    if contract and price:
        strike, mid, dte = contract.get("strike"), contract.get("mid"), contract.get("dte")
        if strike and mid is not None:
            be = strike - mid
            derived["breakeven"] = round(be, 2)
            derived["breakevenDiscountPct"] = round((price - be) / price * 100, 2)
            derived["strikeOTMPct"] = round((price - strike) / price * 100, 2)
        iv = (contract.get("impliedVolatility") or snap.get("iv30") or 0) / 100
        if iv and dte:
            derived["oneSigmaMoveToExpiry"] = round(price * iv * math.sqrt(dte / 365), 2)
    if price and snap.get("week52Low"):
        derived["pctAbove52wLow"] = round((price - snap["week52Low"]) / snap["week52Low"] * 100, 1)
    if snap.get("iv30") and snap.get("hv30"):
        derived["ivMinusHv30"] = round(snap["iv30"] - snap["hv30"], 1)

    return {
        "asOf": datetime.now(_NY).strftime("%Y-%m-%d %H:%M %Z"),
        "symbol": symbol,
        "dataSource": snap.get("dataSource"),
        "stock": {k: snap.get(k) for k in (
            "price", "marketCap", "sector", "iv30", "hv30", "sma20",
            "earningsDate", "week52High", "week52Low")},
        "contract": contract,
        "derived": derived,
        "existingPosition": (
            {"shares": position.get("shares"), "costBasis": position.get("costBasis"),
             "notes": position.get("notes")} if position else None
        ),
        "traderRules": {
            "collateralCapUSD": cfg.get("collateralCap"),
            "targetDelta": cfg.get("targetDelta"),
            "earningsBufferDays": cfg.get("earningsBufferDays"),
        },
        "recentHeadlines": _headlines(symbol),
    }


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

OPINION_SYSTEM = """You are a skeptical risk analyst advising a retail trader who runs the wheel strategy (sell cash-secured puts; if assigned, own 100 shares and sell covered calls).

The single question that matters: if this put is assigned, would owning 100 shares at the breakeven price for 3-6 months be acceptable? Premium is small; assignment into a falling stock is where the wheel loses money.

Rules:
- The JSON snapshot you receive is live data and OVERRIDES anything you remember. Do not contradict its price, IV, dates or position data.
- Your knowledge of the company may be outdated. Any claim that depends on your memory (recent earnings, guidance, management, deals, lawsuits) must also be listed in stale_knowledge_flags.
- Do not invent figures. If you do not know something, say so.
- If existingPosition is present, the trader ALREADY owns shares; assignment would add to that position, so weigh concentration and their cost basis.
- Be concrete and brief. No disclaimers.

Respond with ONLY a JSON object, no prose, in exactly this shape:
{
  "verdict": "sell_put" | "wait" | "pass",
  "conviction": <integer 1-10, confidence in your verdict>,
  "assignment_comfort": <integer 1-10, how acceptable owning at breakeven for 3-6 months is>,
  "fair_value_floor": <number, price level where you think downside likely stops over 3-6 months>,
  "floor_reasoning": "<one or two sentences>",
  "bull_case": ["<max 3 short points>"],
  "bear_case": ["<max 3 short points>"],
  "key_risk": "<the single biggest risk to this trade>",
  "better_strike": <number or null — a strike you would prefer, if any>,
  "stale_knowledge_flags": ["<claims above that rely on possibly-outdated memory>"]
}"""


def opinion_prompt(ctx: dict) -> str:
    return (
        "Evaluate selling this cash-secured put. Live snapshot (JSON):\n\n"
        + json.dumps(ctx, indent=2, default=str)
        + "\n\nReturn the JSON object only."
    )


# ---------------------------------------------------------------------------
# Covered-call mode: for positions you already hold UNDERWATER
# ---------------------------------------------------------------------------

def build_cc_context(symbol: str, cfg: dict, cost_basis: float, shares: int) -> dict:
    """Blocking. Pulls the best call ABOVE basis and the best call at your target
    delta allowing BELOW basis, so the models weigh the real trade-off."""
    import yfinance as yf
    from data import _fetch_covered_call, _price_stats

    above = _fetch_covered_call(symbol, cost_basis, shares, cfg, allow_below_basis=False)
    below = _fetch_covered_call(symbol, cost_basis, shares, cfg, allow_below_basis=True)
    price = above.get("price") or below.get("price")

    stats: dict[str, Any] = {}
    try:
        t = yf.Ticker(symbol)
        ps = _price_stats(t)
        info = t.info or {}
        stats = {"hv30": round(ps["hv30"] * 100, 2) if ps.get("hv30") else None,
                 "sma20": round(ps["sma20"], 2) if ps.get("sma20") else None,
                 "week52High": info.get("fiftyTwoWeekHigh"), "week52Low": info.get("fiftyTwoWeekLow"),
                 "sector": info.get("sector"), "marketCap": info.get("marketCap")}
    except Exception:
        pass

    below_c = below.get("contract")
    if below_c and not below_c.get("belowCostBasis"):
        below_c = None  # target-delta strike is already above basis; no real trade-off

    lots = max(shares // 100, 1)
    derived: dict[str, Any] = {}
    if price and cost_basis:
        derived["unrealizedPnlUSD"] = round((price - cost_basis) * shares, 2)
        derived["unrealizedPnlPct"] = round((price - cost_basis) / cost_basis * 100, 2)
        derived["recoveryNeededPct"] = round((cost_basis - price) / price * 100, 2)
        derived["capitalTiedUpUSD"] = round(price * shares, 2)
    for name, c in (("aboveBasis", above.get("contract")), ("belowBasis", below_c)):
        if c and price:
            derived[name] = {
                "premiumUSD": round(c["mid"] * 100 * lots, 2),
                "effectiveBasisAfterPremium": round(cost_basis - c["mid"], 2),
                "strikeOTMPct": round((c["strike"] - price) / price * 100, 2),
                "lockedInPnlIfCalledUSD": round((c["strike"] - cost_basis + c["mid"]) * 100 * lots, 2),
            }
    # compute_spread compares model floors to this
    derived["breakeven"] = cost_basis

    return {
        "asOf": datetime.now(_NY).strftime("%Y-%m-%d %H:%M %Z"),
        "mode": "cc",
        "symbol": symbol,
        "dataSource": above.get("dataSource") or below.get("dataSource"),
        "stock": {"price": price, "iv30": above.get("iv30") or below.get("iv30"),
                  "earningsDate": above.get("earningsDate") or below.get("earningsDate"), **stats},
        "contract": above.get("contract"),          # best call at/above basis
        "belowBasisContract": below_c,              # best call at target delta if you accept a below-basis strike
        "derived": derived,
        "existingPosition": {"shares": shares, "costBasis": cost_basis},
        "traderRules": {"targetDelta": cfg.get("targetDelta"), "dteRange": [cfg.get("dteLow"), cfg.get("dteHigh")]},
        "recentHeadlines": _headlines(symbol),
    }


CC_SYSTEM = """You are a skeptical portfolio advisor for a retail trader running the wheel strategy. They ALREADY OWN these shares and the position is underwater (price below cost basis).

Decide what they should do over the next 1-2 months. The options are:
- "sell_call_above_basis": sell the call at/above cost basis (small premium, no locked-in loss if called)
- "sell_call_below_basis": sell the closer-to-the-money call below basis (more premium, but locks in a loss if called away)
- "hold": keep the shares, sell no call, wait for recovery
- "exit": sell the shares, take the loss, redeploy the capital elsewhere

Treat "exit" as a real option, not a last resort. Cost basis is sunk; the only question is whether this is the best use of the capital from here. Do not favour selling a call just because this is a covered-call tool.

Rules:
- The JSON snapshot is live data and OVERRIDES your memory. Do not contradict its prices, dates or position.
- Anything relying on possibly-outdated memory (earnings, guidance, deals, management) must also appear in stale_knowledge_flags.
- Do not invent figures. Be concrete and brief. No disclaimers.

Respond with ONLY a JSON object:
{
  "verdict": "sell_call_above_basis" | "sell_call_below_basis" | "hold" | "exit",
  "conviction": <integer 1-10, confidence in your verdict>,
  "still_own_conviction": <integer 1-10: would you BUY this stock today at the current price? this is the real test of holding>,
  "fair_value_floor": <number, where downside likely stops over 3-6 months>,
  "upside_target": <number, realistic price in 3-6 months if things go right>,
  "floor_reasoning": "<one or two sentences>",
  "bull_case": ["<max 3 short points>"],
  "bear_case": ["<max 3 short points>"],
  "key_risk": "<the single biggest risk in your recommended path>",
  "better_strike": <number or null — call strike you would sell, if any>,
  "stale_knowledge_flags": ["<claims relying on possibly-outdated memory>"]
}"""


def cc_prompt(ctx: dict) -> str:
    return ("Decide what to do with this underwater position. Live snapshot (JSON):\n\n"
            + json.dumps(ctx, indent=2, default=str) + "\n\nReturn the JSON object only.")


SYNTH_SYSTEM = """You compare independent analyses from several AI models of the same options trade. You are a referee, not an analyst.

Rules:
- Do NOT give your own view of the trade and do NOT pick a winner.
- Attribute every position to the model that holds it, using the model keys given.
- Surface disagreement; agreement between models trained on similar data is weak evidence, so say what they agree on briefly.
- Flag factual claims that a trader should verify before acting — especially anything a model listed as possibly stale, or any specific number/event not present in the live snapshot.

Respond with ONLY a JSON object:
{
  "consensus": ["<short points all models share>"],
  "disagreements": [
    {"topic": "<short>", "positions": {"<model key>": "<that model's position>"}, "why_it_matters": "<one sentence>"}
  ],
  "unverified_claims": [
    {"claim": "<short>", "from": ["<model keys>"], "check": "<what to look up>"}
  ],
  "question_to_resolve": "<the ONE fact that would most change the decision if checked>"
}"""


def synth_prompt(ctx: dict, opinions: dict[str, dict]) -> str:
    return (
        "Live snapshot the models were given:\n"
        + json.dumps({k: ctx.get(k) for k in ("symbol", "stock", "contract", "belowBasisContract", "derived", "existingPosition")}, default=str)
        + "\n\nModel analyses (keyed by model):\n"
        + json.dumps(opinions, indent=2)
        + "\n\nReturn the JSON object only."
    )


# ---------------------------------------------------------------------------
# Provider calls (raw HTTP, no SDKs — keeps requirements.txt unchanged)
# ---------------------------------------------------------------------------

def _parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


async def _call_claude(client: httpx.AsyncClient, model: str, system: str, prompt: str) -> tuple[str, int, int]:
    r = await client.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
        json={"model": model, "max_tokens": 2500, "system": system,
              "messages": [{"role": "user", "content": prompt}]},
    )
    r.raise_for_status()
    d = r.json()
    text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
    u = d.get("usage", {})
    return text, u.get("input_tokens", 0), u.get("output_tokens", 0)


async def _call_openai(client: httpx.AsyncClient, model: str, system: str, prompt: str) -> tuple[str, int, int]:
    body: dict[str, Any] = {
        "model": model,
        "instructions": system,
        "input": prompt,
        "max_output_tokens": 6000,   # reasoning tokens count against this
        "text": {"format": {"type": "json_object"}},
    }
    if OPENAI_EFFORT and OPENAI_EFFORT.lower() != "none":
        body["reasoning"] = {"effort": OPENAI_EFFORT}
    r = await client.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
        json=body,
    )
    r.raise_for_status()
    d = r.json()
    text = d.get("output_text") or "".join(
        c.get("text", "")
        for item in d.get("output", []) if item.get("type") == "message"
        for c in item.get("content", []) if c.get("type") == "output_text"
    )
    u = d.get("usage", {})
    return text, u.get("input_tokens", 0), u.get("output_tokens", 0)


async def _call_gemini(client: httpx.AsyncClient, model: str, system: str, prompt: str) -> tuple[str, int, int]:
    r = await client.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            # thinking tokens count against maxOutputTokens on Gemini
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 8192},
        },
    )
    r.raise_for_status()
    d = r.json()
    parts = ((d.get("candidates") or [{}])[0].get("content") or {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    u = d.get("usageMetadata", {})
    out = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)  # thinking is billed as output
    return text, u.get("promptTokenCount", 0), out


CALLERS = {"claude": _call_claude, "openai": _call_openai, "gemini": _call_gemini}


def _http_error(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        body = e.response.text[:300]
        return f"HTTP {e.response.status_code}: {body}"
    if isinstance(e, httpx.TimeoutException):
        return "timed out"
    return f"{type(e).__name__}: {e}"


RETRY_STATUS = {429, 500, 502, 503, 504}   # overload / rate-limit / transient
RETRY_DELAYS = [3, 8]                       # seconds; two retries, then give up


def _retryable(e: Exception) -> bool:
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code in RETRY_STATUS
    return isinstance(e, (httpx.TimeoutException, httpx.TransportError))


async def _ask(client, provider: str, model: str, system: str, prompt: str, run_id: str, role: str) -> dict:
    t0 = datetime.now(_NY)
    attempts = 0
    while True:
        attempts += 1
        try:
            text, tin, tout = await CALLERS[provider](client, model, system, prompt)
            break
        except Exception as e:
            if _retryable(e) and attempts <= len(RETRY_DELAYS):
                await asyncio.sleep(RETRY_DELAYS[attempts - 1])
                continue
            msg = _http_error(e)
            if attempts > 1:
                msg += f" (after {attempts} tries)"
            return {"provider": provider, "model": model, "error": msg}
    list_cost = _cost(model, tin, tout)
    cost = 0.0 if provider in FREE_PROVIDERS else list_cost
    log_usage({"ts": t0.isoformat(), "run_id": run_id, "role": role, "provider": provider,
               "model": model, "in": tin, "out": tout, "cost": cost, "listCost": list_cost})
    base = {"provider": provider, "model": model, "tokensIn": tin, "tokensOut": tout, "costUSD": cost,
            "seconds": round((datetime.now(_NY) - t0).total_seconds(), 1), "attempts": attempts}
    try:
        return {**base, "result": _parse_json(text)}
    except Exception:
        return {**base, "error": "model did not return valid JSON", "raw": text[:1500]}


# ---------------------------------------------------------------------------
# Numeric spread — computed, not generated
# ---------------------------------------------------------------------------

def _num(v) -> Optional[float]:
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def compute_spread(opinions: dict[str, dict], ctx: dict) -> dict:
    ok = {k: v["result"] for k, v in opinions.items() if "result" in v}
    conv = {k: _num(r.get("conviction")) for k, r in ok.items()}
    comfort = {k: _num(r.get("assignment_comfort", r.get("still_own_conviction"))) for k, r in ok.items()}
    upside = {k: _num(r.get("upside_target")) for k, r in ok.items()}
    floors = {k: _num(r.get("fair_value_floor")) for k, r in ok.items()}
    verdicts = {k: r.get("verdict") for k, r in ok.items()}

    def rng(d):
        vals = [v for v in d.values() if v is not None]
        if not vals:
            return None
        return {"min": min(vals), "max": max(vals), "avg": round(sum(vals) / len(vals), 1),
                "spread": round(max(vals) - min(vals), 2)}

    be = (ctx.get("derived") or {}).get("breakeven")
    floor_vs_be = {k: round((f - be) / be * 100, 1) for k, f in floors.items() if f and be}
    return {
        "verdicts": verdicts,
        "unanimous": len(set(verdicts.values())) == 1 and len(verdicts) > 1,
        "conviction": rng(conv),
        "assignmentComfort": rng(comfort),
        "upside": rng(upside),
        "floor": rng(floors),
        # negative = model thinks the stock can fall below your breakeven
        "floorVsBreakevenPct": floor_vs_be,
    }


# ---------------------------------------------------------------------------
# Orchestration — async generator of (event, data) for SSE
# ---------------------------------------------------------------------------

async def run_council(symbol: str, cfg: dict, contract: Optional[dict], force: bool = False,
                      mode: str = "put", position: Optional[dict] = None) -> AsyncIterator[tuple[str, dict]]:
    strike = contract.get("strike") if contract else None
    expiration = contract.get("expiration") if contract else None

    if mode == "cc":
        key = f"CC|{symbol}|{float(position['costBasis']):g}|{position['shares']}|{_today_ny()}"
    else:
        key = cache_key(symbol, strike, expiration)
    if not force:
        hit = cache_get(key)
        if hit:
            yield "context", hit["context"]
            for p, op in hit["opinions"].items():
                yield "opinion", op
            if hit.get("synthesis"):
                yield "synthesis", hit["synthesis"]
            yield "done", {**hit["done"], "cached": True}
            return

    providers = configured_providers()
    if not providers:
        yield "error", {"message": "No API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY and/or GEMINI_API_KEY on Railway."}
        return
    blocked = _budget_block()
    if blocked:
        yield "error", {"message": blocked}
        return

    try:
        if mode == "cc":
            ctx = await asyncio.to_thread(build_cc_context, symbol, cfg, float(position["costBasis"]), int(position["shares"]))
        else:
            ctx = await asyncio.to_thread(build_context, symbol, cfg, contract)
    except Exception as e:
        yield "error", {"message": f"Could not load market data for {symbol}: {e}"}
        return
    if mode == "cc":
        if not ctx["stock"].get("price"):
            yield "error", {"message": f"No price for {symbol} right now."}
            return
        # Hold/exit is still worth asking even with no call in range, so no contract is required here.
    elif not ctx.get("contract"):
        yield "error", {"message": f"No qualifying put for {symbol} under your current DTE/delta settings."}
        return
    yield "context", ctx

    run_id = f"{'CC-' if mode == 'cc' else ''}{symbol}-{datetime.now(_NY).strftime('%Y%m%d%H%M%S%f')}"
    prompt = cc_prompt(ctx) if mode == "cc" else opinion_prompt(ctx)
    system = CC_SYSTEM if mode == "cc" else OPINION_SYSTEM
    opinions: dict[str, dict] = {}

    for p in PROVIDERS:
        if p not in providers:
            opinions[p] = {"provider": p, "model": PROVIDERS[p]["model"], "error": "no API key configured", "skipped": True}
            yield "opinion", opinions[p]

    async with httpx.AsyncClient(timeout=CALL_TIMEOUT) as client:
        tasks = [asyncio.create_task(_ask(client, p, PROVIDERS[p]["model"], system, prompt, run_id, "opinion"))
                 for p in providers]
        for fut in asyncio.as_completed(tasks):
            op = await fut
            opinions[op["provider"]] = op
            yield "opinion", op

        good = {k: v["result"] for k, v in opinions.items() if "result" in v}
        spread = compute_spread(opinions, ctx)
        synthesis = None
        if len(good) >= 2:
            # Preferred referee first; if it's down (e.g. Gemini overloaded), fall back to
            # a provider that just answered successfully, cheapest/free first.
            order = [SYNTH_PROVIDER] if SYNTH_PROVIDER in providers else []
            order += sorted((p for p in good if p not in order), key=lambda p: (p not in FREE_PROVIDERS, p != "gemini"))
            s, synth_p, synth_model, spent = {}, None, None, 0.0
            for synth_p in order:
                synth_model = SYNTH_MODEL if synth_p == SYNTH_PROVIDER else PROVIDERS[synth_p]["model"]
                s = await _ask(client, synth_p, synth_model, SYNTH_SYSTEM, synth_prompt(ctx, good), run_id, "synthesis")
                spent += s.get("costUSD") or 0
                if "result" in s:
                    break
            synthesis = {"spread": spread, "provider": synth_p, "model": synth_model,
                         "fallback": synth_p != (order[0] if order else None),
                         "costUSD": round(spent, 5), **({"map": s["result"]} if "result" in s else {"error": s.get("error")})}
        else:
            synthesis = {"spread": spread, "error": "Need at least two model answers to compare."}
        yield "synthesis", synthesis

    costs = [o.get("costUSD") for o in opinions.values()] + [synthesis.get("costUSD")]
    done = {"runCostUSD": round(sum(c for c in costs if c), 4), "cached": False,
            "monthSpendUSD": usage_summary()["spendUSD"], "capUSD": MONTHLY_CAP}
    # only cache complete runs — a model that errored should get another shot on reopen
    failed = [o for o in opinions.values() if "error" in o and not o.get("skipped")]
    if len(good) >= 2 and not failed and "map" in synthesis:
        cache_put(key, {"context": ctx, "opinions": opinions, "synthesis": synthesis, "done": done})
    yield "done", done
