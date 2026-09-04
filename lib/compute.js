/**
 * Equity curve, computed on demand. The four cost levels the UI offers are
 * pre-computed by the publisher (src/publish_mongo.py in ResearchGate) and this
 * is only used for ad-hoc requests: a ticker subset or an unusual cost.
 *
 * Strategy: hold the share on days the model predicts UP; sit in cash otherwise.
 * A round trip costs `costBps` each way, charged when the position CHANGES.
 * Kept identical to the publisher's port so both paths agree bit for bit.
 */
export function equityCurve (rows, { costBps = 0 } = {}) {
  if (!rows.length) return { points: [], stats: null }

  const model = new Map()
  const hold = new Map()
  const prevPos = new Map()
  const trades = new Map()

  const byDate = new Map()
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, [])
    byDate.get(r.date).push(r)
  }
  const dates = [...byDate.keys()].sort()

  const points = []
  const cost = costBps / 10000
  for (const d of dates) {
    for (const r of byDate.get(d)) {
      if (!model.has(r.ticker)) { model.set(r.ticker, 1); hold.set(r.ticker, 1); prevPos.set(r.ticker, 0); trades.set(r.ticker, 0) }
      const pos = r.pred > 0 ? 1 : 0
      let m = model.get(r.ticker)
      if (pos !== prevPos.get(r.ticker)) {
        m *= (1 - cost)
        trades.set(r.ticker, trades.get(r.ticker) + 1)
        prevPos.set(r.ticker, pos)
      }
      m *= (1 + pos * r.actual)
      model.set(r.ticker, m)
      hold.set(r.ticker, hold.get(r.ticker) * (1 + r.actual))
    }
    points.push({ date: d, model: mean([...model.values()]), hold: mean([...hold.values()]) })
  }

  const last = points[points.length - 1]
  const years = (new Date(last.date) - new Date(points[0].date)) / 3.15576e10
  const stats = {
    nTickers: model.size,
    nDays: points.length,
    start: points[0].date,
    end: last.date,
    modelFinal: last.model,
    holdFinal: last.hold,
    modelCagr: cagr(1, last.model, years),
    holdCagr: cagr(1, last.hold, years),
    modelMaxDD: maxDrawdown(points.map(p => p.model)),
    holdMaxDD: maxDrawdown(points.map(p => p.hold)),
    tradesPerTicker: mean([...trades.values()]),
    costBps,
  }
  return { points, stats }
}

const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1)
const cagr = (from, to, years) => (years > 0 ? Math.pow(to / from, 1 / years) - 1 : 0)

function maxDrawdown (series) {
  let peak = -Infinity, dd = 0
  for (const v of series) { if (v > peak) peak = v; dd = Math.min(dd, v / peak - 1) }
  return dd
}
