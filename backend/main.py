import json
import os
import secrets
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from fastapi.responses import StreamingResponse

from data import scan_watchlist, get_stock_info, get_heatmap, score_results, record_iv_history, earnings_warnings, get_covered_call, get_covered_call_heatmap, scan_covered_calls
import council
from quality import attach_quality
from rolls import get_rolls
from watch import get_watch
import schwab_source

BASE_DIR           = Path(__file__).parent
# DATA_DIR points at a persistent Railway volume when RAILWAY_VOLUME_MOUNT_PATH
# is set (Railway injects this automatically once a volume is attached to the
# service). Falls back to BASE_DIR for local dev, where redeploys aren't a
# concern. Without a volume, config.json lives inside the container image and
# gets wiped back to config.default.json on every deploy — this is what makes
# it survive.
DATA_DIR           = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", BASE_DIR))
CONFIG_PATH        = DATA_DIR / "config.json"
CONFIG_DEFAULT     = BASE_DIR / "config.default.json"
POSITIONS_PATH     = BASE_DIR / "positions.json"  # read-only for earnings warnings
IV_HISTORY_PATH    = DATA_DIR / "iv_history.json"  # daily iv30 per symbol, for IV percentile
QUALITY_PATH       = DATA_DIR / "fundamentals_cache.json"  # Alpha Vantage OVERVIEW, 7-day cache


def _bootstrap() -> None:
    """Seed config.json from defaults on first deploy; leave existing data alone."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        src = CONFIG_DEFAULT if CONFIG_DEFAULT.exists() else None
        CONFIG_PATH.write_text(src.read_text() if src else "{}")


_bootstrap()
council.init_storage(DATA_DIR)

app = FastAPI(title="WheelScan API")

# ── passcode ──────────────────────────────────────────────────────────────
# Set WHEELSCAN_PASSCODE on the Railway service to lock the API: every request
# must then carry it in the X-WheelScan-Key header (the frontend asks once per
# device and remembers it). Unset = open, so a deploy can never lock you out
# before the variable exists. Registered before CORS so 401s still carry CORS
# headers and the browser can read them.
PASSCODE = os.environ.get("WHEELSCAN_PASSCODE", "")


@app.middleware("http")
async def require_passcode(request: Request, call_next):
    if PASSCODE and request.method != "OPTIONS" and request.url.path != "/health":
        key = request.headers.get("x-wheelscan-key", "")
        if not secrets.compare_digest(key.encode(), PASSCODE.encode()):
            return JSONResponse({"detail": "passcode required"}, status_code=401)
    return await call_next(request)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/auth/check")
def auth_check():
    """200 if the passcode (or no passcode) is accepted — the frontend's gate."""
    return {"ok": True, "locked": bool(PASSCODE)}


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # lock down after deploy
    allow_methods=["GET", "PUT", "POST", "DELETE"],
    allow_headers=["*"],
)


class WatchlistItem(BaseModel):
    symbol:         str
    entryCondition: str = "Any"
    notes:          str = ""
    costBasis:      Optional[float] = None
    shares:         Optional[int] = None


class OpenOption(BaseModel):
    # A short call or put you already have on — saved so the roll tool can
    # cover Fidelity (or anything) that isn't in the Schwab account.
    symbol:      str
    putCall:     str                       # "PUT" | "CALL"
    strike:      float
    expiration:  str                       # YYYY-MM-DD
    qty:         int = 1
    openPremium: Optional[float] = None    # per share, what this contract sold for
    creditSoFar: Optional[float] = None    # per share, whole chain incl. this sale
    costBasis:   Optional[float] = None    # calls: share basis, for if-called P/L
    broker:      str = ""


class Config(BaseModel):
    # Collateral and premium are UI filters only — never part of wheelScore.
    collateralCap: int
    collateralFloor: int = 0
    minPremium: float = 0          # $ per contract (mid x 100)
    hideEarningsInWindow: bool = False
    ccDteLow: int = 7              # covered-call board's own DTE window
    ccDteHigh: int = 35
    minQuality: str = "Any"        # Any | A | B | C — UI filter only, never scored
    openOptions: List[OpenOption] = []
    quickWatch: Optional[List[str]] = None   # phone watchlist; None = start with what you hold
    minROC: float
    targetROC: float
    targetDelta: float
    dteLow: int
    dteHigh: int
    targetDTE: int
    earningsBufferDays: int
    minIVRank: int
    minOpenInterest: int
    watchlist: List[WatchlistItem]


def _normalize_watchlist(raw: list) -> list[dict]:
    """Accept both plain strings and dicts; always return list of dicts."""
    out = []
    for item in raw:
        if isinstance(item, str):
            out.append({"symbol": item, "entryCondition": "Any", "notes": "", "costBasis": None, "shares": None})
        else:
            out.append({
                "symbol":         item.get("symbol", ""),
                "entryCondition": item.get("entryCondition", "Any"),
                "notes":          item.get("notes", ""),
                "costBasis":      item.get("costBasis"),
                "shares":         item.get("shares"),
            })
    return out


def read_config() -> dict:
    with CONFIG_PATH.open() as f:
        data = json.load(f)
    # fields added after the volume's config.json was first written
    data.setdefault("collateralFloor", 0)
    data.setdefault("minPremium", 0)
    data.setdefault("hideEarningsInWindow", False)
    data.setdefault("ccDteLow", 7)
    data.setdefault("ccDteHigh", 35)
    data.setdefault("minQuality", "Any")
    data.setdefault("openOptions", [])
    data["watchlist"] = _normalize_watchlist(data.get("watchlist", []))
    return data


@app.get("/config", response_model=Config)
def get_config():
    return read_config()


@app.put("/config", response_model=Config)
def put_config(config: Config):
    data = config.model_dump()
    with CONFIG_PATH.open("w") as f:
        json.dump(data, f, indent=2)
    return data


def _symbols(cfg: dict) -> list[str]:
    """Extract plain symbol strings from watchlist (which may be dicts)."""
    return [w["symbol"] if isinstance(w, dict) else w for w in cfg.get("watchlist", [])]


@app.get("/scan")
def scan():
    cfg = read_config()
    results = scan_watchlist(_symbols(cfg), cfg)
    record_iv_history(results, IV_HISTORY_PATH)
    attach_quality(results, QUALITY_PATH)
    return score_results(results)


@app.get("/scan/{symbol}")
def scan_one(symbol: str):
    """Single-symbol endpoint for fast testing."""
    cfg = read_config()
    results = scan_watchlist([symbol.upper()], cfg)
    return results[0]


@app.get("/earnings-warnings")
def get_earnings_warnings():
    """
    Check open positions for earnings dates close to their expiration.
    Returns a list of warning objects — no scan needed, runs on page load.
    """
    if POSITIONS_PATH.exists():
        with POSITIONS_PATH.open() as f:
            positions = json.load(f)
    else:
        positions = []
    open_pos = [p for p in positions if p.get("status") == "open"]
    return earnings_warnings(open_pos)


class CoveredCallRequest(BaseModel):
    costBasis:       float
    shares:          int
    allowBelowBasis: bool = False


@app.post("/covered-call/{symbol}")
def covered_call(symbol: str, req: CoveredCallRequest):
    """
    Best covered-call contract for a position you already own.
    costBasis = effective per-share cost (strike minus prior premium if assigned from CSP).
    """
    cfg = read_config()
    return get_covered_call(
        symbol.upper(),
        req.costBasis,
        req.shares,
        cfg,
        allow_below_basis=req.allowBelowBasis,
    )


class RollRequest(BaseModel):
    symbol:      str
    putCall:     str
    strike:      float
    expiration:  str
    qty:         int = 1
    openPremium: Optional[float] = None
    creditSoFar: Optional[float] = None
    costBasis:   Optional[float] = None


@app.post("/rolls")
def rolls(req: RollRequest):
    """Close-now vs every later-expiry roll for one short option."""
    return get_rolls(
        req.symbol, req.putCall, req.strike, req.expiration,
        qty=req.qty, open_premium=req.openPremium,
        credit_so_far=req.creditSoFar, cost_basis=req.costBasis,
    )


@app.get("/watch")
def watch():
    """Quick watchlist: live quotes + earnings + what you hold, for the phone view."""
    return get_watch(read_config())


@app.get("/open-options")
def open_options():
    """Saved short options plus whatever is open in the Schwab account."""
    cfg = read_config()
    try:
        schwab, err = schwab_source.get_option_positions(), None
    except schwab_source.SchwabUnavailable as exc:
        schwab, err = [], str(exc)
    return {"saved": cfg.get("openOptions", []), "schwab": schwab, "schwabError": err}


@app.get("/covered-calls")
def covered_calls_board():
    """Covered-call board for every position with a cost basis and shares."""
    cfg = read_config()
    return scan_covered_calls(cfg["watchlist"], cfg)


@app.get("/heatmap/covered-call/{symbol}")
def covered_call_heatmap(
    symbol: str,
    costBasis: float,
    shares: int,
    allowBelowBasis: bool = False,
):
    """Wide-range call surface for a held position, scored against cost basis."""
    cfg = read_config()
    return get_covered_call_heatmap(
        symbol.upper(), costBasis, shares, cfg, allow_below_basis=allowBelowBasis,
    )


@app.get("/heatmap/{symbol}")
def heatmap(symbol: str):
    """Wide-range options surface for the heatmap view (DTE 7-60, all strikes)."""
    cfg = read_config()
    return get_heatmap(symbol.upper(), cfg)


# ─── AI Council ─────────────────────────────────────────────────────────────

class CouncilRequest(BaseModel):
    # Optional: the exact contract to evaluate (e.g. a pinned heatmap cell).
    # Omit to use the screener's best contract for this symbol.
    contract: Optional[dict] = None
    force:    bool = False   # bypass today's cache (costs a fresh run)


@app.post("/council/{symbol}")
async def council_run(symbol: str, req: CouncilRequest):
    """
    Streams Server-Sent Events: context → opinion ×3 (as each model finishes)
    → synthesis (disagreement map) → done (cost). One run ≈ 4 paid calls.
    """
    cfg = read_config()

    async def events():
        async for event, data in council.run_council(symbol.upper(), cfg, req.contract, req.force):
            yield f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class CoveredCallCouncilRequest(BaseModel):
    costBasis: float
    shares:    int
    force:     bool = False


@app.post("/council/cc/{symbol}")
async def council_cc(symbol: str, req: CoveredCallCouncilRequest):
    """Council for an UNDERWATER held position: sell call above basis / below basis / hold / exit."""
    cfg = read_config()

    async def events():
        async for event, data in council.run_council(
            symbol.upper(), cfg, None, req.force, mode="cc",
            position={"costBasis": req.costBasis, "shares": req.shares},
        ):
            yield f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/council/usage")
def council_usage():
    """Month-to-date council spend, run count, and which providers are configured."""
    from fastapi.responses import JSONResponse
    return JSONResponse(council.usage_summary(), headers={"Cache-Control": "no-store"})
