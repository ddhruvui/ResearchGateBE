/**
 * ResearchGate API — read-only view of the PSO + LS-SVM results in MongoDB.
 * Vercel wraps this Express app as one serverless function (see vercel.json);
 * server.js hosts the same app locally.
 */
import express from 'express'
import cors from 'cors'
import {
  dbName, defaultRun, cachedAt, getRun, getEquity, computeEquity,
  getNextSession, queryPredictions, listRuns, getStrategyList, getStrategyTicker,
} from '../lib/data.js'

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
const unpublished = (res, run) => res.status(404).json({
  error: `run "${run}" has not been published to ${dbName}`,
  hint: 'python3 -m src.publish_mongo (ResearchGate repo)',
})
const iso = ms => (ms ? new Date(ms).toISOString() : null)

const ENDPOINTS = {
  '/api/health': 'row counts, when and from where the run was published',
  '/api/summary': 'overall metrics, per-year table, date range',
  '/api/equity?costBps=N&tickers=A,B': 'equity curve points + stats',
  '/api/tickers': 'per-ticker leaderboard',
  '/api/next-session': "tomorrow's paper-trade predictions",
  '/api/predictions?ticker=A,B&from=YYYY-MM-DD&to=&source=live|backtest&page=1&limit=500': 'graded rows',
  '/api/strategy': '$10k-per-stock stop-loss paper trade: rollup + per-ticker totals',
  '/api/strategy/:ticker': 'one stock, including the daily balance series per stop level',
  '/api/runs': 'every published run',
}

app.get('/', (_req, res) => res.json({
  name: 'ResearchGate API', db: dbName, defaultRun, endpoints: ENDPOINTS,
  note: 'every endpoint accepts ?run=<run_id>',
}))

app.get('/api/health', wrap(async (req, res) => {
  const run = runOf(req)
  const r = await getRun(run)
  if (!r) return unpublished(res, run)
  res.json({
    ok: true, runId: run, db: dbName,
    rows: r.rows, rowsScored: r.rows_scored, rowsInMongo: r.predictions_in_mongo,
    publishedAt: r.published_at, origin: r.origin, forSession: r.for_session,
    loadedAt: iso(cachedAt(`run:${run}`)),
  })
}))

app.get('/api/summary', wrap(async (req, res) => {
  const run = runOf(req)
  const r = await getRun(run)
  if (!r) return unpublished(res, run)
  res.json({
    ...r.summary,
    runId: run, db: dbName, origin: r.origin, publishedAt: r.published_at,
    forSession: r.for_session, asOf: r.as_of, runMeta: r.run_meta ?? null,
    loadedAt: iso(cachedAt(`run:${run}`)),
  })
}))

app.get('/api/equity', wrap(async (req, res) => {
  const run = runOf(req)
  const r = await getRun(run)
  if (!r) return unpublished(res, run)
  const costBps = Number(req.query.costBps ?? 0)
  if (!Number.isFinite(costBps) || costBps < 0) return res.status(400).json({ error: 'costBps must be a number >= 0' })
  const tickers = req.query.tickers
    ? String(req.query.tickers).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null
  if (!tickers && (r.costs_bps || []).includes(costBps)) {
    const pre = await getEquity(run, costBps)
    if (pre) return res.json({ ...pre, precomputed: true })
  }
  res.json({ ...(await computeEquity(run, { costBps, tickers })), precomputed: false })
}))

app.get('/api/tickers', wrap(async (req, res) => {
  const run = runOf(req)
  const r = await getRun(run)
  if (!r) return unpublished(res, run)
  res.json(r.tickers || [])
}))

app.get('/api/next-session', wrap(async (req, res) => {
  const run = runOf(req)
  const rows = await getNextSession(run)
  res.json({
    forSession: rows[0]?.forSession ?? null,
    asOf: rows[0]?.asOf ?? null,
    up: rows.filter(r => r.pred > 0).length,
    down: rows.filter(r => r.pred <= 0).length,
    rows,
  })
}))

app.get('/api/strategy', wrap(async (req, res) => {
  const run = runOf(req)
  const r = await getRun(run)
  if (!r) return unpublished(res, run)
  const rows = await getStrategyList(run)
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
    loadedAt: iso(cachedAt(`strat:${run}`)),
  })
}))

app.get('/api/strategy/:ticker', wrap(async (req, res) => {
  const run = runOf(req)
  const doc = await getStrategyTicker(run, req.params.ticker)
  if (!doc) {
    return res.status(404).json({
      error: `no strategy for ${String(req.params.ticker).toUpperCase()} in run "${run}"`,
    })
  }
  res.json({ runId: run, ...doc })
}))

app.get('/api/predictions', wrap(async (req, res) => {
  res.json(await queryPredictions(runOf(req), req.query))
}))

app.get('/api/runs', wrap(async (_req, res) => {
  const runs = await listRuns()
  res.json(runs.map(r => ({
    runId: r._id, publishedAt: r.published_at, origin: r.origin, rows: r.rows,
    rowsInMongo: r.predictions_in_mongo, maxDate: r.max_date, forSession: r.for_session,
    runMeta: r.run_meta ?? null,
  })))
}))

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, endpoints: ENDPOINTS }))
app.use((err, _req, res, _next) => {          // eslint-disable-line no-unused-vars
  console.error(err)
  res.status(500).json({ error: err.message })
})

export default app
