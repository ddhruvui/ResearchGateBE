/**
 * Reads what src/publish_mongo.py (ResearchGate repo) wrote:
 *   runs          _id = run_id            metrics, summary, ticker table, run_meta
 *   equity        _id = run_id:costBps    pre-computed curves for the UI's cost levels
 *   next_session  _id = run_id:ticker     the current ungraded guess per ticker
 *   predictions   _id = run_id:ticker:date  every graded row
 *   strategy      _id = run_id:ticker       the $10k stop-loss paper trade per ticker
 *   midrun        _id = run_id:ticker       ResearchGateEOD only: the intraday guess per
 *                                           ticker, as if IB's price were today's close
 *
 * Every reader takes the db key ('rg' | 'eod', see db.js) first; it is part of
 * every cache key, so the two databases never share a memoised answer.
 *
 * Small documents are memoised for CACHE_TTL_MS so a warm function answers the
 * whole dashboard from memory; the publisher's published_at tells the reader
 * how fresh it is.
 */
import { getDb, dbName, DBS } from './db.js'
import { equityCurve } from './compute.js'

export { dbName, DBS }
export const defaultRun = process.env.RUN_ID || 'pso_lssvm_v1'

const TTL = Number(process.env.CACHE_TTL_MS || 60_000)
const cache = new Map()

async function memo (key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.v
  const v = await fn()
  cache.set(key, { v, at: Date.now() })
  return v
}

export const cachedAt = key => cache.get(key)?.at ?? null

export async function getRun (db, run) {
  return memo(`${db}:run:${run}`, async () =>
    (await getDb(db)).collection('runs').findOne({ _id: run }))
}

export async function getEquity (db, run, costBps) {
  return memo(`${db}:eq:${run}:${costBps}`, async () => {
    const d = await (await getDb(db)).collection('equity').findOne({ _id: `${run}:${costBps}` })
    return d ? { points: d.points, stats: d.stats } : null
  })
}

export async function getNextSession (db, run) {
  return memo(`${db}:ns:${run}`, async () =>
    (await getDb(db)).collection('next_session')
      .find({ run_id: run }, { projection: { _id: 0, run_id: 0 } })
      .sort({ pred: -1 }).toArray())
}

/**
 * Every ticker's stop-loss summary WITHOUT the daily balance series. The series
 * is ~1,400 points per ticker per stop level; sending 164 of them would be a
 * multi-megabyte response for a table that only shows totals.
 */
export async function getStrategyList (db, run) {
  return memo(`${db}:strat:${run}`, async () =>
    (await getDb(db)).collection('strategy')
      .find({ run_id: run }, { projection: { _id: 0, run_id: 0, series: 0 } })
      .sort({ ticker: 1 }).toArray())
}

/** One ticker, series included — what the per-stock chart draws. */
export async function getStrategyTicker (db, run, ticker) {
  const t = String(ticker).trim().toUpperCase()
  return memo(`${db}:strat:${run}:${t}`, async () =>
    (await getDb(db)).collection('strategy')
      .findOne({ _id: `${run}:${t}` }, { projection: { _id: 0, run_id: 0 } }))
}

/** Ad-hoc path: streams the run's rows out of Mongo and computes here. */
export async function computeEquity (db, run, { costBps = 0, tickers = null } = {}) {
  const q = { run_id: run }
  if (tickers?.length) q.ticker = { $in: tickers }
  const cur = (await getDb(db)).collection('predictions')
    .find(q, { projection: { _id: 0, date: 1, ticker: 1, pred_return: 1, actual_return: 1 } })
    .sort({ date: 1, ticker: 1 }).batchSize(20_000)     // fewer round trips: 220k rows otherwise take ~25 s
  const rows = []
  for await (const r of cur) {
    const pred = Number(r.pred_return), actual = Number(r.actual_return)
    if (r.date && Number.isFinite(pred) && Number.isFinite(actual)) {
      rows.push({ date: r.date, ticker: r.ticker, pred, actual })
    }
  }
  return equityCurve(rows, { costBps })
}

export async function queryPredictions (db, run, { ticker, from, to, source, limit, page } = {}) {
  const q = { run_id: run }
  if (ticker) q.ticker = { $in: String(ticker).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) }
  if (from || to) {
    q.date = {}
    if (from) q.date.$gte = String(from)
    if (to) q.date.$lte = String(to)
  }
  if (source) q.source = String(source)
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000)
  const pg = Math.max(Number(page) || 1, 1)
  const col = (await getDb(db)).collection('predictions')
  const [total, rows] = await Promise.all([
    col.countDocuments(q),
    col.find(q, { projection: { _id: 0, run_id: 0 } })
      .sort({ date: 1, ticker: 1 }).skip((pg - 1) * lim).limit(lim).toArray(),
  ])
  return { runId: run, total, page: pg, limit: lim, pages: Math.ceil(total / lim), rows }
}

export async function listRuns (db) {
  return (await getDb(db)).collection('runs')
    .find({}, { projection: { metrics: 0, summary: 0, tickers: 0, ticker_info: 0, fingerprint: 0 } })
    .sort({ published_at: -1 }).toArray()
}

const day = v => (v == null ? null : String(v).slice(0, 10))

/**
 * The latest midrun (ResearchGateEOD only), in the same row shape as getNextSession so the
 * UI renders it with the same table, plus what makes it a midrun: the official close it
 * started from and the IB snapshot time it treated as today's close.
 */
export async function getMidrun (run) {
  return memo(`eod:midrun:${run}`, async () => {
    const d = await getDb('eod')
    const [docs, meta] = await Promise.all([
      d.collection('midrun').find({ run_id: run }, { projection: { _id: 0, run_id: 0 } })
        .sort({ pred_return: -1 }).toArray(),
      d.collection('midrun_runs').find({ run_id: run }, { projection: { _id: 0, run_id: 0 } })
        .sort({ stamp: -1 }).limit(1).next(),
    ])
    const rows = docs.map(r => ({
      ticker: r.ticker,
      forSession: day(r.for_session),
      asOf: day(r.as_of),
      lastClose: r.last_close,
      officialAsOf: day(r.official_as_of),
      officialClose: r.official_close,
      pred: r.pred_return,
      impliedClose: r.implied_close,
      bar: r.bar,
      nTrain: r.n_train,
    }))
    return { rows, meta }
  })
}
