import json
import uuid
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from data import scan_watchlist, get_stock_info, get_heatmap

CONFIG_PATH    = Path(__file__).parent / "config.json"
POSITIONS_PATH = Path(__file__).parent / "positions.json"

DEFAULT_CONFIG = {
    "collateralCap": 12000,
    "minROC": 1.5,
    "targetROC": 2.5,
    "targetDelta": 0.20,
    "dteLow": 21,
    "dteHigh": 35,
    "targetDTE": 30,
    "earningsBufferDays": 7,
    "minIVRank": 30,
    "minOpenInterest": 500,
    "watchlist": [
        {"symbol": "RKLB", "entryCondition": "Any", "notes": ""},
        {"symbol": "ASTS", "entryCondition": "Any", "notes": ""},
        {"symbol": "PLTR", "entryCondition": "Any", "notes": ""},
        {"symbol": "HOOD", "entryCondition": "Any", "notes": ""},
        {"symbol": "COIN", "entryCondition": "Any", "notes": ""},
        {"symbol": "MARA", "entryCondition": "Any", "notes": ""},
        {"symbol": "CLSK", "entryCondition": "Any", "notes": ""},
        {"symbol": "APP",  "entryCondition": "Any", "notes": ""},
    ],
}

def _bootstrap() -> None:
    """Create data files with defaults if they don't exist (first deploy)."""
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
    if not POSITIONS_PATH.exists():
        POSITIONS_PATH.write_text("[]")

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
            out.append({"symbol": item, "entryCondition": "Any", "notes": ""})
        else:
            out.append({
                "symbol":         item.get("symbol", ""),
                "entryCondition": item.get("entryCondition", "Any"),
                "notes":          item.get("notes", ""),
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
    return scan_watchlist(_symbols(cfg), cfg)


@app.get("/scan/{symbol}")
def scan_one(symbol: str):
    """Single-symbol endpoint for fast testing."""
    cfg = read_config()
    results = scan_watchlist([symbol.upper()], cfg)
    return results[0]


@app.get("/heatmap/{symbol}")
def heatmap(symbol: str):
    """Wide-range options surface for the heatmap view (DTE 7-60, all strikes)."""
    cfg = read_config()
    return get_heatmap(symbol.upper(), cfg)


# ── Positions ────────────────────────────────────────────────────────────────

class Position(BaseModel):
    symbol:       str
    type:         str           # "CSP" or "CC"
    strike:       float
    expiration:   str           # ISO date string
    premium:      float
    openDate:     str           # ISO date string
    collateral:   float
    costBasis:    Optional[float] = None
    status:       str = "open"  # "open" | "closed" | "assigned"
    closeDate:    Optional[str]   = None
    closePremium: Optional[float] = None
    notes:        str = ""


class PositionUpdate(BaseModel):
    symbol:       Optional[str]   = None
    type:         Optional[str]   = None
    strike:       Optional[float] = None
    expiration:   Optional[str]   = None
    premium:      Optional[float] = None
    openDate:     Optional[str]   = None
    collateral:   Optional[float] = None
    costBasis:    Optional[float] = None
    status:       Optional[str]   = None
    closeDate:    Optional[str]   = None
    closePremium: Optional[float] = None
    notes:        Optional[str]   = None


def _read_positions() -> list:
    if not POSITIONS_PATH.exists():
        return []
    with POSITIONS_PATH.open() as f:
        return json.load(f)


def _write_positions(data: list) -> None:
    with POSITIONS_PATH.open("w") as f:
        json.dump(data, f, indent=2)


@app.get("/positions")
def get_positions():
    return _read_positions()


@app.post("/positions", status_code=201)
def add_position(pos: Position):
    positions = _read_positions()
    record = {"id": str(uuid.uuid4()), **pos.model_dump()}
    positions.append(record)
    _write_positions(positions)
    return record


@app.put("/positions/{pos_id}")
def update_position(pos_id: str, update: PositionUpdate):
    positions = _read_positions()
    for i, p in enumerate(positions):
        if p["id"] == pos_id:
            patch = {k: v for k, v in update.model_dump().items() if v is not None}
            positions[i] = {**p, **patch}
            _write_positions(positions)
            return positions[i]
    raise HTTPException(status_code=404, detail="Position not found")


@app.delete("/positions/{pos_id}", status_code=204)
def delete_position(pos_id: str):
    positions = _read_positions()
    updated = [p for p in positions if p["id"] != pos_id]
    if len(updated) == len(positions):
        raise HTTPException(status_code=404, detail="Position not found")
    _write_positions(updated)
    return None
