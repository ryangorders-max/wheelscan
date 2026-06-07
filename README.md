# WheelScan

Cash-secured put wheel strategy screener.

## Prerequisites

- Python 3.10+
- Node.js 18+

## Backend (FastAPI — port 8000)

```bash
cd wheelscan/backend
python3 -m venv .venv
.venv/bin/pip install numpy yfinance pandas uvicorn fastapi
.venv/bin/uvicorn main:app --reload --port 8000
```

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
