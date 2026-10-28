/**
 * One MongoClient per process. On Vercel the module scope survives between warm
 * invocations, so the pool is reused; a cold start pays one connect (~1-4 s).
 *
 * Two databases on the same cluster, chosen per request by a fixed key — never by a
 * name taken from the request:
 *   rg   MONGO_DB      (default ResearchGate)     the ResearchGate pipeline's results
 *   eod  MONGO_DB_EOD  (default ResearchGateEOD)  the ResearchGateEOD copy + its midrun
 * Read-only either way: nothing here writes to Mongo.
 */
import { MongoClient } from 'mongodb'

export const DBS = Object.freeze({
  rg: process.env.MONGO_DB || 'ResearchGate',
  eod: process.env.MONGO_DB_EOD || 'ResearchGateEOD',
})
export const dbName = DBS.rg

/** The key for a ?db= value: absent -> 'rg'; anything not in DBS -> 400. */
export function dbKeyOf (raw) {
  if (raw == null || raw === '') return 'rg'
  const k = String(raw).toLowerCase()
  if (!Object.hasOwn(DBS, k)) {
    throw Object.assign(new Error(`db must be one of: ${Object.keys(DBS).join(', ')}`), { status: 400 })
  }
  return k
}

export function resolveUri () {
  let uri = (process.env.MONGO_URI || '').trim().replace(/^['"]|['"]$/g, '')
  if (!uri) throw new Error('MONGO_URI is not set')
  if (uri.includes('<db_password>')) {
    const pw = process.env.DB_PASSWORD
    if (!pw) throw new Error('MONGO_URI has a <db_password> placeholder but DB_PASSWORD is not set')
    uri = uri.replace('<db_password>', encodeURIComponent(pw))
  }
  return uri
}

let clientPromise = null

export function getDb (key = 'rg') {
  const name = DBS[key]
  if (!name) throw new Error(`unknown db key ${key}`)
  if (!clientPromise) {
    const client = new MongoClient(resolveUri(), {
      serverSelectionTimeoutMS: 15_000,
      maxPoolSize: 5,
      appName: 'researchgate-be',
    })
    clientPromise = client.connect().catch(err => { clientPromise = null; throw err })
  }
  return clientPromise.then(c => c.db(name))
}
