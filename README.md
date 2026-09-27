# WheelScan

Cash-secured put wheel strategy screener.

## Prerequisites

- Python 3.10+
- Node.js 18+

## Backend (FastAPI — port 8000)

```bash
cd wheelscan/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --reload --port 8000
```

### Schwab data source (optional)

Price and option-chain data try [schwab-oauth-service](../../Schwab/schwab-oauth-service)
first (real broker bid/ask/Greeks) and fall back to yfinance automatically —
see `backend/schwab_source.py`. Stock stats (HV30, SMA20, earnings, sector)
stay yfinance-only either way. To enable it, set:

```bash
SCHWAB_OAUTH_SERVICE_URL=https://schwab-oauth-service-production.up.railway.app
SCHWAB_OAUTH_SERVICE_SECRET=<same value as schwab-oauth-service's SCHWAB_PROXY_SHARED_SECRET>
```

Leaving these unset just means every request falls back to yfinance — nothing breaks.

### AI Council (optional)

Each screener row has a **Council** button. It sends that put (plus live price,
IV/HV, earnings date, your existing position and recent headlines) to Claude,
GPT and Gemini in parallel, then a referee pass maps where they disagree. Results
are cached per symbol/strike/expiry for the day; re-opening is free.

On the **Positions** tab, a held position that's *below* your cost basis gets its own
**Council** button (after you run CC on it). That version asks a different question:
sell a call above basis, sell one below basis (locking in a loss if called), hold, or exit.

Set on Railway (any provider without a key is skipped):

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
COUNCIL_MONTHLY_CAP_USD=10        # hard stop on spend
COUNCIL_FREE_PROVIDERS=gemini     # providers on a free tier are logged at $0
TOOLING_FIXED_COSTS=Railway=5     # monthly bills that exist only because of trading
```

Optional: `COUNCIL_CLAUDE_MODEL`, `COUNCIL_OPENAI_MODEL`, `COUNCIL_GEMINI_MODEL`,
`COUNCIL_SYNTH_PROVIDER` (e.g. `gemini`) / `COUNCIL_SYNTH_MODEL`, `COUNCIL_MAX_RUNS_PER_HOUR`.
Month-to-date spend, projection and monthly history: the **Tooling cost** badge in the top bar, or `GET /council/usage`. See `backend/council.py` for details.

## Frontend (React — port 3000)

In a separate terminal:

```bash
cd wheelscan/frontend
npm install
npm start
```

Open http://localhost:3000

## Config

Settings are persisted to `backend/config.json`.  
API endpoints:

| Method | Path      | Description          |
|--------|-----------|----------------------|
| GET    | /config   | Read current config  |
| PUT    | /config   | Write config (JSON body) |

Interactive API docs: http://localhost:8000/docs
