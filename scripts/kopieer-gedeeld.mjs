// Kopieert src/gedeeld/*.js (arena-vorm en botsingen, één bron voor server en
// site) naar de site: ../kenniskist/src/games/online/gedeeld/.
//   npm run gedeeld
// Daarna beide projecten committen. De tests (hier test/Gedeeld.test.ts, in de
// site src/games/online/gedeeld.test.js) falen zolang de kopie afwijkt.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const hier = path.dirname(fileURLToPath(import.meta.url))
const bron = path.join(hier, '..', 'src', 'gedeeld')
const doel = path.join(hier, '..', '..', 'kenniskist', 'src', 'games', 'online', 'gedeeld')
export const KOP = '// KOPIE uit kenniskist-server/src/gedeeld/ (npm run gedeeld). Pas het daar aan, niet hier.\n'

if (!fs.existsSync(path.dirname(doel))) {
  console.error('Site niet gevonden op', path.dirname(doel))
  process.exit(1)
}
fs.mkdirSync(doel, { recursive: true })
for (const f of fs.readdirSync(bron).filter(f => f.endsWith('.js'))) {
  fs.writeFileSync(path.join(doel, f), KOP + fs.readFileSync(path.join(bron, f), 'utf8').replace(/\r\n/g, '\n'))
  console.log('gekopieerd:', f)
}
