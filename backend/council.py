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
    now = datetime.now(_NY)
    month = now.strftime("%Y-%m")
    rows = _read_usage()
    month_rows = [r for r in rows if r.get("ts", "").startswith(month)]
    runs = {r["run_id"] for r in month_rows if r.get("run_id")}
    spend = sum(r.get("cost") or 0 for r in month_rows)
    by_model: dict[str, float] = {}
    for r in month_rows:
        by_model[r.get("model", "?")] = round(by_model.get(r.get("model", "?"), 0) + (r.get("cost") or 0), 4)
    return {
        "month": month,
        "spendUSD": round(spend, 4),
        "capUSD": MONTHLY_CAP,
        "runs": len(runs),
        "avgPerRunUSD": round(spend / len(runs), 4) if runs else None,
        "byModel": by_model,
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
        + json.dumps({k: ctx[k] for k in ("symbol", "stock", "contract", "derived", "existingPosition")}, default=str)
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


async def _ask(client, provider: str, model: str, system: str, prompt: str, run_id: str, role: str) -> dict:
    t0 = datetime.now(_NY)
    try:
        text, tin, tout = await CALLERS[provider](client, model, system, prompt)
    except Exception as e:
        return {"provider": provider, "model": model, "error": _http_error(e)}
    cost = _cost(model, tin, tout)
    log_usage({"ts": t0.isoformat(), "run_id": run_id, "role": role, "provider": provider,
               "model": model, "in": tin, "out": tout, "cost": cost})
    base = {"provider": provider, "model": model, "tokensIn": tin, "tokensOut": tout, "costUSD": cost,
            "seconds": round((datetime.now(_NY) - t0).total_seconds(), 1)}
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
    comfort = {k: _num(r.get("assignment_comfort")) for k, r in ok.items()}
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
        "floor": rng(floors),
        # negative = model thinks the stock can fall below your breakeven
        "floorVsBreakevenPct": floor_vs_be,
    }


# ---------------------------------------------------------------------------
# Orchestration — async generator of (event, data) for SSE
# ---------------------------------------------------------------------------

async def run_council(symbol: str, cfg: dict, contract: Optional[dict], force: bool = False) -> AsyncIterator[tuple[str, dict]]:
    strike = contract.get("strike") if contract else None
    expiration = contract.get("expiration") if contract else None

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
        ctx = await asyncio.to_thread(build_context, symbol, cfg, contract)
    except Exception as e:
        yield "error", {"message": f"Could not load market data for {symbol}: {e}"}
        return
    if not ctx.get("contract"):
        yield "error", {"message": f"No qualifying put for {symbol} under your current DTE/delta settings."}
        return
    yield "context", ctx

    run_id = f"{symbol}-{datetime.now(_NY).strftime('%Y%m%d%H%M%S%f')}"
    prompt = opinion_prompt(ctx)
    opinions: dict[str, dict] = {}

    for p in PROVIDERS:
        if p not in providers:
            opinions[p] = {"provider": p, "model": PROVIDERS[p]["model"], "error": "no API key configured", "skipped": True}
            yield "opinion", opinions[p]

    async with httpx.AsyncClient(timeout=CALL_TIMEOUT) as client:
        tasks = [asyncio.create_task(_ask(client, p, PROVIDERS[p]["model"], OPINION_SYSTEM, prompt, run_id, "opinion"))
                 for p in providers]
        for fut in asyncio.as_completed(tasks):
            op = await fut
            opinions[op["provider"]] = op
            yield "opinion", op

        good = {k: v["result"] for k, v in opinions.items() if "result" in v}
        spread = compute_spread(opinions, ctx)
        synthesis = None
        if len(good) >= 2:
            synth_p = SYNTH_PROVIDER if SYNTH_PROVIDER in providers else next(iter(good))
            synth_model = SYNTH_MODEL if synth_p == SYNTH_PROVIDER else PROVIDERS[synth_p]["model"]
            s = await _ask(client, synth_p, synth_model, SYNTH_SYSTEM, synth_prompt(ctx, good), run_id, "synthesis")
            synthesis = {"spread": spread, "provider": synth_p, "model": synth_model,
                         "costUSD": s.get("costUSD"), **({"map": s["result"]} if "result" in s else {"error": s.get("error")})}
        else:
            synthesis = {"spread": spread, "error": "Need at least two model answers to compare."}
        yield "synthesis", synthesis

    costs = [o.get("costUSD") for o in opinions.values()] + [synthesis.get("costUSD")]
    done = {"runCostUSD": round(sum(c for c in costs if c), 4), "cached": False,
            "monthSpendUSD": usage_summary()["spendUSD"], "capUSD": MONTHLY_CAP}
    # only cache runs where at least two models answered
    if len(good) >= 2:
        cache_put(key, {"context": ctx, "opinions": opinions, "synthesis": synthesis, "done": done})
    yield "done", done
