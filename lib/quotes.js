/**
 * Live quotes for the price column on "Tomorrow's prediction".
 *
 * Two sources, deliberately both:
 *
 *   WebSocket (wss://ws.eodhistoricaldata.com/ws/us) is the real-time tape —
 *     actual trade prints, including pre- and post-market. It is the freshest
 *     thing EODHD sells, but it only tells you about a name when that name
 *     trades, and the token is capped at 50 concurrent symbols.
 *   REST (/api/real-time) always answers for every symbol, instantly, but the
 *     value can be the previous close when the tape has moved on.
 *
 * So both run at once and the socket's print wins wherever it arrives. REST
 * guarantees every row has a number within a second; the socket upgrades the
 * ones it catches. Each quote says which source it came from.
 *
 * The 50-symbol cap is worked around by rotating: subscribe a batch, listen,
 * unsubscribe, move on. Measured on the 105-name universe in extended hours,
 * three rounds priced 104 of them. A round also ends the moment every symbol
 * in it has printed, so during regular hours — when this is actually used —
 * the whole pass usually costs a second or two rather than the full budget.
 *
 * Nothing is cached anywhere: the route sets `no-store`, because a cached
 * "live" price is worse than none. It looks current and is not.
 */

const REST = 'https://eodhd.com/api/real-time'
const WS_URL = 'wss://ws.eodhistoricaldata.com/ws/us'
const REST_CHUNK = 15         // symbols per REST call, via the `s` parameter
const WS_CAP = 50             // EODHD: symbols per token across all open sockets
const WS_WINDOW_MS = 2500     // per round, cut short once the round is complete
const WS_BUDGET_MS = 20_000   // hard ceiling; Vercel allows this route 30 s
const REST_TIMEOUT_MS = 12_000

/** EODHD sends the string "NA" for a field it has no value for. */
const num = v => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const chunk = (xs, n) => xs.reduce((out, x, i) =>
  (i % n ? out[out.length - 1].push(x) : out.push([x]), out), [])

function token () {
  const t = (process.env.EODHD_API_TOKEN || '').trim()
  if (!t) {
    const e = new Error('EODHD_API_TOKEN is not set on the API')
    e.status = 503
    e.hint = 'set EODHD_API_TOKEN in Vercel → Settings → Environment Variables (and in .env for local dev)'
    throw e
  }
  return t
}

/* ---------------------------------------------------------------- REST ---- */

async function restChunk (tickers, tok) {
  const [first, ...rest] = tickers
  const url = new URL(`${REST}/${encodeURIComponent(`${first}.US`)}`)
  url.searchParams.set('api_token', tok)
  url.searchParams.set('fmt', 'json')
  if (rest.length) url.searchParams.set('s', rest.map(t => `${t}.US`).join(','))

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REST_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } })
    // Never surface the URL itself — it carries the token.
    if (!r.ok) throw new Error(`EODHD REST ${r.status} ${r.statusText}`)
    const body = await r.json()
    return Array.isArray(body) ? body : [body]
  } finally {
    clearTimeout(timer)
  }
}

async function restQuotes (tickers, tok) {
  const settled = await Promise.allSettled(chunk(tickers, REST_CHUNK).map(g => restChunk(g, tok)))
  const out = new Map()
  const failures = []
  for (const s of settled) {
    if (s.status === 'rejected') { failures.push(s.reason?.message || String(s.reason)); continue }
    for (const q of s.value) {
      const t = String(q?.code || '').replace(/\.US$/i, '').toUpperCase()
      const price = num(q?.close)
      if (!t || price == null) continue
      out.set(t, {
        price,
        prevClose: num(q.previousClose),
        change: num(q.change),
        changePct: num(q.change_p),
        at: num(q.timestamp) != null ? new Date(num(q.timestamp) * 1000).toISOString() : null,
        source: 'rest',
      })
    }
  }
  return { quotes: out, failures }
}

/* ------------------------------------------------------------ WebSocket ---- */

/**
 * One socket, batches rotated through it. Resolves to a Map of the prints that
 * arrived; never rejects, because this is the optional half of the answer — if
 * the socket is unavailable (no WebSocket global, plan without streaming, a
 * dropped connection) the REST result still stands on its own.
 */
function wsQuotes (tickers, tok) {
  if (typeof WebSocket === 'undefined') return Promise.resolve(new Map())

  return new Promise(resolve => {
    const out = new Map()
    let ws
    try { ws = new WebSocket(`${WS_URL}?api_token=${encodeURIComponent(tok)}`) }
    catch { return resolve(out) }

    let done = false
    // `pending` is the batch currently subscribed; a round ends early once it empties.
    let pending = new Set()
    let onRoundDone = null

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(hardStop)
      try { ws.close() } catch { /* already closing */ }
      resolve(out)
    }
    const hardStop = setTimeout(finish, WS_BUDGET_MS)

    ws.onerror = finish
    ws.onclose = finish
    ws.onmessage = e => {
      let m
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.status_code) {
        // 422 = symbols limit; the round is lost but later ones may still land.
        if (m.status_code >= 400) { pending.clear(); onRoundDone?.() }
        return
      }
      const t = typeof m.s === 'string' ? m.s.toUpperCase() : null
      const price = num(m.p)
      if (!t || price == null) return
      out.set(t, {
        price,
        at: num(m.t) != null ? new Date(num(m.t)).toISOString() : null,
        // "extended-hours" / "regular" — worth showing, a thin print reads differently.
        marketStatus: typeof m.ms === 'string' ? m.ms : null,
        source: 'ws',
      })
      if (pending.delete(t) && pending.size === 0) onRoundDone?.()
    }

    ws.onopen = async () => {
      try {
        for (const group of chunk(tickers, WS_CAP)) {
          if (done) break
          pending = new Set(group)
          ws.send(JSON.stringify({ action: 'subscribe', symbols: group.join(',') }))
          // Whichever comes first: every name in the batch printed, or the window.
          await Promise.race([
            new Promise(r => { onRoundDone = r }),
            sleep(WS_WINDOW_MS),
          ])
          onRoundDone = null
          if (done) break
          ws.send(JSON.stringify({ action: 'unsubscribe', symbols: group.join(',') }))
          await sleep(150)         // let the server release the slots before the next batch
        }
      } catch { /* fall through to whatever arrived */ }
      finish()
    }
  })
}

/* --------------------------------------------------------------- merge ---- */

export async function liveQuotes (tickers) {
  const tok = token()
  const [rest, ws] = await Promise.all([
    restQuotes(tickers, tok),
    wsQuotes(tickers, tok).catch(() => new Map()),
  ])

  const quotes = {}
  for (const t of tickers) {
    const r = rest.quotes.get(t)
    const w = ws.get(t)
    if (!r && !w) continue
    // The socket carries an actual trade print; prefer it, but keep REST's
    // previous close so the day's move can still be shown.
    quotes[t] = w
      ? { ...w, prevClose: r?.prevClose ?? null,
          change: r?.prevClose != null ? +(w.price - r.prevClose).toFixed(4) : null,
          changePct: r?.prevClose ? +(((w.price / r.prevClose) - 1) * 100).toFixed(4) : null }
      : r
  }

  const got = Object.keys(quotes).length
  if (!got && rest.failures.length) {
    const e = new Error(`EODHD returned nothing — ${rest.failures[0]}`)
    e.status = 502
    throw e
  }

  return {
    quotes,
    missing: tickers.filter(t => !quotes[t]),
    fromStream: Object.values(quotes).filter(q => q.source === 'ws').length,
    fetchedAt: new Date().toISOString(),
    ...(rest.failures.length ? { partial: rest.failures.length } : {}),
  }
}
