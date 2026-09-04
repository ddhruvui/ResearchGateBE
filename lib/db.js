/**
 * One MongoClient per process. On Vercel the module scope survives between warm
 * invocations, so the pool is reused; a cold start pays one connect (~1-4 s).
 */
import { MongoClient } from 'mongodb'

export const dbName = process.env.MONGO_DB || 'ResearchGate'

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

export function getDb () {
  if (!clientPromise) {
    const client = new MongoClient(resolveUri(), {
      serverSelectionTimeoutMS: 15_000,
      maxPoolSize: 5,
      appName: 'researchgate-be',
    })
    clientPromise = client.connect().catch(err => { clientPromise = null; throw err })
  }
  return clientPromise.then(c => c.db(dbName))
}
