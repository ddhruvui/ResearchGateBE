// Local entry point only. Vercel imports api/index.js directly and never runs this.
import 'dotenv/config'
import app from './api/index.js'

const port = Number(process.env.PORT || 8891)
app.listen(port, () => console.log(`ResearchGate API on http://localhost:${port}`))
