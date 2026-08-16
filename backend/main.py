import json
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from data import scan_watchlist, get_stock_info, get_heatmap, score_results, earnings_warnings, get_covered_call, get_covered_call_heatmap

BASE_DIR           = Path(__file__).parent
CONFIG_PATH        = BASE_DIR / "config.json"
CONFIG_DEFAULT     = BASE_DIR / "config.default.json"
POSITIONS_PATH     = BASE_DIR / "positions.json"  # read-only for earnings warnings


def _bootstrap() -> None:
    """Seed config.json from defaults on first deploy; leave existing data alone."""
    if not CONFIG_PATH.exists():
        src = CONFIG_DEFAULT if CONFIG_DEFAULT.exists() else None
        CONFIG_PATH.write_text(src.read_text() if src else "{}")


_bootstrap()

app = FastAPI(title="WheelScan API")

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


class Config(BaseModel):
    collateralCap: int
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
