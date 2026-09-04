# ResearchGate API (backend)

Read-only Express API over the PSO + LS-SVM results that the pipeline publishes
to MongoDB Atlas (database `ResearchGate`). Deployed on **Vercel** as a single
serverless function. The UI that renders it lives in
[ResearchGateFE](https://github.com/ddhruvui/ResearchGateFE) on Render; the
pipeline that produces the data lives in the `ResearchGate` repo.

Nothing here writes to Mongo. `python3 -m src.publish_mongo` in the pipeline
repo does that — the daily pod runs it automatically after each run.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/health` | row counts, `publishedAt`, and the S3 prefix the data came from |
| `GET /api/summary` | overall metrics, live-only block, per-year table, date range |
| `GET /api/equity?costBps=N&tickers=A,B` | equity curve points + stats (pre-computed for 0/1/5/10 bps; computed on demand otherwise) |
| `GET /api/tickers` | per-ticker leaderboard |
| `GET /api/next-session` | tomorrow's paper-trade predictions with the up/down split |
| `GET /api/predictions?ticker=AAPL,MSFT&from=2026-01-01&to=&source=live&page=1&limit=500` | graded rows, paginated (max 5000/page) |
| `GET /api/runs` | every published run and when it was published |

Every endpoint accepts `?run=<run_id>`; the default is `RUN_ID`.

## Environment

| Key | Meaning |
|---|---|
| `MONGO_URI` | Atlas connection string. May keep the `<db_password>` placeholder |
| `DB_PASSWORD` | substituted for `<db_password>`, URL-encoded |
| `MONGO_DB` | database, default `ResearchGate` |
| `RUN_ID` | run served by default, `pso_lssvm_v1` |
| `ALLOWED_ORIGINS` | CORS allow-list, comma-separated; `*` by default |
| `EDGE_CACHE_S` | seconds Vercel's edge may cache a response, default 60 |

See `.env.example`. `.env` is gitignored — never commit it.

## Run locally

```sh
npm install
cp .env.example .env      # fill in MONGO_URI / DB_PASSWORD
npm run dev               # http://localhost:8891/api/health
```

## Deploy on Vercel

1. vercel.com → **Add New… → Project** → import `ddhruvui/ResearchGateBE`.
   Framework preset: **Other**. Leave build and output settings empty.
2. Under **Environment Variables** add `MONGO_URI`, `DB_PASSWORD`, `MONGO_DB`,
   `RUN_ID` (and later `ALLOWED_ORIGINS=https://researchgatefe.onrender.com`).
3. Deploy. Check `https://<project>.vercel.app/api/health`.

`vercel.json` rewrites every path to `api/index.js`, so Express handles routing.
Every push to `main` redeploys.

## Data layout in Mongo

| Collection | `_id` | Holds |
|---|---|---|
| `runs` | `run_id` | metrics.json, summary, ticker table, run_meta, `published_at` |
| `equity` | `run_id:costBps` | pre-computed curve for each UI cost level |
| `next_session` | `run_id:ticker` | the current ungraded guess |
| `predictions` | `run_id:ticker:date` | every graded row, as scored |
