/**
 * ResearchGate API — read-only view of the PSO + LS-SVM results in MongoDB.
 * Vercel wraps this Express app as one serverless function (see vercel.json);
 * server.js hosts the same app locally.
 */
import express from 'express'
import cors from 'cors'
import {
  DBS, defaultRun, cachedAt, getRun, getEquity, computeEquity,
  getNextSession, queryPredictions, listRuns, getStrategyList, getStrategyTicker, getMidrun,
} from '../lib/data.js'
import { dbKeyOf } from '../lib/db.js'
import { liveQuotes } from '../lib/quotes.js'

const app = express()
app.disable('x-powered-by')
app.set('json spaces', 0)

const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({ origin: origins.includes('*') ? true : origins }))

// The data changes once a day; let Vercel's edge absorb repeat hits.
const MAXAGE = Math.max(0, Number(process.env.EDGE_CACHE_S ?? 60))
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', `public, s-maxage=${MAXAGE}, stale-while-revalidate=${MAXAGE * 5}`)
  next()
})

const wrap = fn => (req, res, next) => fn(req, res).catch(next)
const runOf = req => String(req.query.run || defaultRun)
// ?db=eod reads the ResearchGateEOD database instead (see lib/db.js); 400 on anything else.
const dbOf = req => dbKeyOf(req.query.db)
const unpublished = (res, run, db) => res.status(404).json({
  error: `run "${run}" has not been published to ${DBS[db]}`,
  hint: db === 'eod' ? 'bash scripts/sync_from_rg.sh (ResearchGateEOD repo)'
    : 'python3 -m src.publish_mongo (ResearchGate repo)',
})
const iso = ms => (ms ? new Date(ms).toISOString() : null)

const ENDPOINTS = {
  '/api/health': 'row counts, when and from where the run was published',
  '/api/summary': 'overall metrics, per-year table, date range',
  '/api/equity?costBps=N&tickers=A,B': 'equity curve points + stats',
  '/api/tickers': 'per-ticker leaderboard',
  '/api/next-session': "tomorrow's paper-trade predictions",
  '/api/midrun': "ResearchGateEOD's intraday prediction, as if IB's price were today's close",
  '/api/live-price?tickers=A,B': 'current EODHD price per ticker, never cached',
  '/api/predictions?ticker=A,B&from=YYYY-MM-DD&to=&source=live|backtest&page=1&limit=500': 'graded rows',
  '/api/strategy': '$10k-per-stock stop-loss paper trade: rollup + per-ticker totals',
  '/api/strategy/:ticker': 'one stock, including the daily balance series per stop level',
  '/api/runs': 'every published run',
}

app.get('/', (_req, res) => res.json({
  name: 'ResearchGate API', db: DBS.rg, dbs: DBS, defaultRun, endpoints: ENDPOINTS,
  note: 'every endpoint accepts ?run=<run_id> and ?db=rg|eod (default rg)',
}))

app.get('/api/health', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const r = await getRun(db, run)
  if (!r) return unpublished(res, run, db)
  res.json({
    ok: true, runId: run, db: DBS[db],
    rows: r.rows, rowsScored: r.rows_scored, rowsInMongo: r.predictions_in_mongo,
    publishedAt: r.published_at, origin: r.origin, forSession: r.for_session,
    loadedAt: iso(cachedAt(`${db}:run:${run}`)),
  })
}))

app.get('/api/summary', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const r = await getRun(db, run)
  if (!r) return unpublished(res, run, db)
  res.json({
    ...r.summary,
    runId: run, db: DBS[db], origin: r.origin, publishedAt: r.published_at,
    forSession: r.for_session, asOf: r.as_of, runMeta: r.run_meta ?? null,
    loadedAt: iso(cachedAt(`${db}:run:${run}`)),
  })
}))

app.get('/api/equity', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const r = await getRun(db, run)
  if (!r) return unpublished(res, run, db)
  const costBps = Number(req.query.costBps ?? 0)
  if (!Number.isFinite(costBps) || costBps < 0) return res.status(400).json({ error: 'costBps must be a number >= 0' })
  const tickers = req.query.tickers
    ? String(req.query.tickers).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null
  if (!tickers && (r.costs_bps || []).includes(costBps)) {
    const pre = await getEquity(db, run, costBps)
    if (pre) return res.json({ ...pre, precomputed: true })
  }
  res.json({ ...(await computeEquity(db, run, { costBps, tickers })), precomputed: false })
}))

app.get('/api/tickers', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const r = await getRun(db, run)
  if (!r) return unpublished(res, run, db)
  res.json(r.tickers || [])
}))

app.get('/api/next-session', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const rows = await getNextSession(db, run)
  res.json({
    forSession: rows[0]?.forSession ?? null,
    asOf: rows[0]?.asOf ?? null,
    up: rows.filter(r => r.pred > 0).length,
    down: rows.filter(r => r.pred <= 0).length,
    rows,
  })
}))

/**
 * ResearchGateEOD's midrun: next-session guesses from today's PARTIAL bar (IB's price at
 * midrunAsOf taken as the close), same shape as /api/next-session. Always the eod
 * database — only it has a midrun. 404 until one has been published.
 */
app.get('/api/midrun', wrap(async (req, res) => {
  const run = runOf(req)
  const { rows, meta } = await getMidrun(run)
  if (!rows.length) {
    return res.status(404).json({
      error: `no midrun published to ${DBS.eod} for run "${run}"`,
      hint: 'bash scripts/midrun.sh (ResearchGateEOD repo)',
    })
  }
  res.json({
    db: DBS.eod,
    forSession: meta?.for_session ?? rows[0].forSession,
    asOf: rows[0].asOf,
    officialAsOf: rows[0].officialAsOf,
    midrunAsOf: meta?.midrun_as_of ?? null,
    publishedAt: meta?.published_at ?? null,
    up: rows.filter(r => r.pred > 0).length,
    down: rows.filter(r => r.pred <= 0).length,
    fromMidrunBar: rows.filter(r => r.bar === 'midrun').length,
    rows,
    loadedAt: iso(cachedAt(`eod:midrun:${run}`)),
  })
}))

/**
 * The price column behind the button on "Tomorrow's prediction". Deliberately
 * uncached at every layer — the caller asked for the tape as it is right now,
 * and a 60 s edge cache would quietly serve them a stale one.
 */
app.get('/api/live-price', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const tickers = [...new Set(String(req.query.tickers || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean))]
  if (!tickers.length) return res.status(400).json({ error: 'tickers is required, e.g. ?tickers=AAPL,MSFT' })
  if (tickers.length > 250) return res.status(400).json({ error: 'at most 250 tickers per call' })
  if (tickers.some(t => !/^[A-Z0-9.-]{1,12}$/.test(t))) {
    return res.status(400).json({ error: 'tickers must be plain symbols, e.g. AAPL,BRK-B' })
  }
  res.json(await liveQuotes(tickers))
}))

app.get('/api/strategy', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const r = await getRun(db, run)
  if (!r) return unpublished(res, run, db)
  const rows = await getStrategyList(db, run)
  if (!rows.length) {
    return res.status(404).json({
      error: `run "${run}" has no stop-loss strategy published`,
      hint: 'python3 -m src.strategy && python3 -m src.publish_mongo (ResearchGate repo)',
    })
  }
  res.json({
    runId: run,
    meta: r.strategy?.meta ?? null,
    rollup: r.strategy?.rollup ?? null,
    stops: rows[0].stops ?? [],
    startCapital: rows[0].startCapital ?? null,
    rows,
    loadedAt: iso(cachedAt(`${db}:strat:${run}`)),
  })
}))

app.get('/api/strategy/:ticker', wrap(async (req, res) => {
  const run = runOf(req), db = dbOf(req)
  const doc = await getStrategyTicker(db, run, req.params.ticker)
  if (!doc) {
    return res.status(404).json({
      error: `no strategy for ${String(req.params.ticker).toUpperCase()} in run "${run}"`,
    })
  }
  res.json({ runId: run, ...doc })
}))

app.get('/api/predictions', wrap(async (req, res) => {
  res.json(await queryPredictions(dbOf(req), runOf(req), req.query))
}))

app.get('/api/runs', wrap(async (req, res) => {
  const runs = await listRuns(dbOf(req))
  res.json(runs.map(r => ({
    runId: r._id, publishedAt: r.published_at, origin: r.origin, rows: r.rows,
    rowsInMongo: r.predictions_in_mongo, maxDate: r.max_date, forSession: r.for_session,
    runMeta: r.run_meta ?? null,
  })))
}))

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, endpoints: ENDPOINTS }))
app.use((err, _req, res, _next) => {          // eslint-disable-line no-unused-vars
  console.error(err)
  const status = Number.isInteger(err.status) ? err.status : 500
  if (status >= 500) res.set('Cache-Control', 'no-store')
  res.status(status).json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) })
})

export default app
