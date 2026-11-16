// ═══════════════════════════════════════════════════════════════════════════
//  Ballonnengevecht: arena-vorm en botsingen. ÉÉN BRON voor server en site.
// ═══════════════════════════════════════════════════════════════════════════
// Dit bestand staat in kenniskist-server/src/gedeeld/ en wordt met
// `npm run gedeeld` gekopieerd naar kenniskist/src/games/online/gedeeld/.
// Pas het alleen hier aan; een test in beide projecten faalt als de kopie
// afwijkt. Geen imports: het moet in Node én in de browser draaien.
//
// Vier platforms in een 2×2-grid, verbonden door vier smalle bruggen; elk
// platform heeft een helling naar de grond. Onder de bruggen kun je door.

export const ARENA_HALF = 58   // speelveld: -58..58 in x en z
export const CAR_RADIUS = 1.5
export const PLAT_H = 4.2      // hoogte van de platforms en bruggen
export const PLAT_SIZE = 22
export const CORRIDOR = 20     // open ruimte tussen twee platforms
export const BRIDGE_W = 8      // breedte van het brugdek (smaller dan CORRIDOR)
export const OFF = PLAT_SIZE / 2 + CORRIDOR / 2   // 21: midden → platform
export const RAMP_LEN = 14
export const BOMB_RADIUS = 4.5
export const BOMB_FUSE = 2.0
// kart-kleuren waaruit een speler kiest (en bots krijgen er een van)
export const KART_KLEUREN = ['#e63946', '#1d6fd0', '#2a9d8f', '#e9c46a', '#9b5de5', '#f4a261', '#43aa8b', '#ff6b6b']

// rampDir: naar welke kant (x) de helling van het platform loopt
export const QUADRANTS = [
  { key: 'nw', x: -OFF, z: -OFF, rampDir: -1 },
  { key: 'ne', x: OFF, z: -OFF, rampDir: 1 },
  { key: 'sw', x: -OFF, z: OFF, rampDir: -1 },
  { key: 'se', x: OFF, z: OFF, rampDir: 1 },
]
// dekking (bumpers) in de diagonale hoeken van de grond-ring
export const DIAG = OFF + PLAT_SIZE / 2 + 5
export const OBSTACLES = [
  { x: -DIAG, z: -DIAG, w: 6, d: 6 },
  { x: DIAG, z: -DIAG, w: 6, d: 6 },
  { x: -DIAG, z: DIAG, w: 6, d: 6 },
  { x: DIAG, z: DIAG, w: 6, d: 6 },
]
// item-boxen: één midden op elk platform
export const BOX_SPOTS = QUADRANTS.map(q => ({ x: q.x, z: q.z }))

export function inRect(x, z, cx, cz, hw, hd) {
  return x >= cx - hw && x <= cx + hw && z >= cz - hd && z <= cz + hd
}

// Hoogte van de grond op (x, z): platforms en bruggen op PLAT_H, hellingen
// daartussen, de rest 0.
export function heightAt(x, z) {
  const hp = PLAT_SIZE / 2, hc = CORRIDOR / 2, hb = BRIDGE_W / 2
  for (const q of QUADRANTS) if (inRect(x, z, q.x, q.z, hp, hp)) return PLAT_H
  if (inRect(x, z, 0, -OFF, hc, hb)) return PLAT_H
  if (inRect(x, z, 0, OFF, hc, hb)) return PLAT_H
  if (inRect(x, z, -OFF, 0, hb, hc)) return PLAT_H
  if (inRect(x, z, OFF, 0, hb, hc)) return PLAT_H
  for (const q of QUADRANTS) {
    const rx0 = q.x + q.rampDir * hp
    const t = q.rampDir > 0 ? (x - rx0) / RAMP_LEN : (rx0 - x) / RAMP_LEN
    if (t >= 0 && t <= 1 && z >= q.z - hp && z <= q.z + hp) return PLAT_H * (1 - t)
  }
  return 0
}

// Omhoog alleen geleidelijk (via een helling): een sprong van de grond naar
// het volle dek betekent dat je ónder een brug rijdt, niet erop.
export function clampHeightStep(rawTarget, prevY) {
  if (rawTarget <= prevY + 0.05) return rawTarget          // gelijk blijven of dalen mag altijd
  if (prevY > PLAT_H - 0.3) return rawTarget                // al (bijna) boven: platform → brug
  if (rawTarget > 0.02 && rawTarget < PLAT_H - 0.02) return rawTarget   // op een helling
  return prevY                                               // sprong vanaf de grond: geblokkeerd
}

// Vanaf deze hoogte gelden de wanden van het bovendek in plaats van die van
// de grond. Ruim onder PLAT_H, zodat je bovenaan de helling al op de
// dek-regels zit (anders duwt de voetafdruk je de helling weer af).
export const DEK_Y = PLAT_H - 1.2

// Wanden van een platform op het bovendek: buitenrand dicht, leuningen langs
// de helling, en de randen naar de bruggen dicht behalve waar het brugdek zit.
export function platformWalls(q) {
  const hp = PLAT_SIZE / 2, hb = BRIDGE_W / 2
  const isTop = q.z < 0
  const outerZ = isTop ? q.z - hp : q.z + hp
  const innerZ = isTop ? q.z + hp : q.z - hp
  const rampX0 = q.x + q.rampDir * hp
  const innerX = q.x - q.rampDir * hp
  const railMidX = rampX0 + q.rampDir * (RAMP_LEN / 2)
  const flankLen = hp - hb, flankOff = hb + flankLen / 2
  return [
    { x: q.x, z: outerZ, hw: hp, hd: 0.4 },                       // buitenrand
    { x: railMidX, z: q.z - hp, hw: RAMP_LEN / 2, hd: 0.4 },      // leuning helling noord
    { x: railMidX, z: q.z + hp, hw: RAMP_LEN / 2, hd: 0.4 },      // leuning helling zuid
    { x: q.x - flankOff, z: innerZ, hw: flankLen / 2, hd: 0.4 },  // naast de opening naar de z-brug
    { x: q.x + flankOff, z: innerZ, hw: flankLen / 2, hd: 0.4 },
    { x: innerX, z: q.z - flankOff, hw: 0.4, hd: flankLen / 2 },  // naast de opening naar de x-brug
    { x: innerX, z: q.z + flankOff, hw: 0.4, hd: flankLen / 2 },
  ]
}

// Zijwanden van de vier bruggen (onder de leuningen). Alleen op het bovendek:
// op de grond moet je er juist onderdoor kunnen.
export function bridgeWalls() {
  const hc = CORRIDOR / 2, hb = BRIDGE_W / 2
  const bruggen = [
    { x: 0, z: -OFF, horizontaal: true }, { x: 0, z: OFF, horizontaal: true },
    { x: -OFF, z: 0, horizontaal: false }, { x: OFF, z: 0, horizontaal: false },
  ]
  return bruggen.flatMap(b => b.horizontaal
    ? [{ x: b.x, z: b.z - hb, hw: hc, hd: 0.35 }, { x: b.x, z: b.z + hb, hw: hc, hd: 0.35 }]
    : [{ x: b.x - hb, z: b.z, hw: 0.35, hd: hc }, { x: b.x + hb, z: b.z, hw: 0.35, hd: hc }])
}

// Vanaf de grond is een platform een dicht blok.
export function platformFootprint(q) {
  const hp = PLAT_SIZE / 2
  return { x: q.x, z: q.z, hw: hp, hd: hp }
}

// Voet van de helling: waar je moet zijn om het platform op te rijden.
export function rampFoot(q) {
  return { x: q.x + q.rampDir * (PLAT_SIZE / 2 + RAMP_LEN - 1), z: q.z }
}

// Botsingsblokken: onzichtbare rand + bumpers, plus per hoogte de platformvorm.
const half = ARENA_HALF
const BOXES_BASIS = [
  { x: 0, z: half + 1, hw: half + 1, hd: 1 },
  { x: 0, z: -half - 1, hw: half + 1, hd: 1 },
  { x: half + 1, z: 0, hw: 1, hd: half + 1 },
  { x: -half - 1, z: 0, hw: 1, hd: half + 1 },
  ...OBSTACLES.map(o => ({ x: o.x, z: o.z, hw: o.w / 2, hd: o.d / 2 })),
]
export const BOXES_GROND = [...BOXES_BASIS, ...QUADRANTS.map(platformFootprint)]
export const BOXES_BOVEN = [...BOXES_BASIS, ...QUADRANTS.flatMap(platformWalls), ...bridgeWalls()]
export const boxesVoorHoogte = (y) => (y > DEK_Y ? BOXES_BOVEN : BOXES_GROND)

// Cirkel tegen blokken: duwt pos (met straal r) uit elk blok. Past pos aan.
export function collideBoxes(pos, r, boxes = BOXES_GROND) {
  for (const b of boxes) {
    const x0 = b.x - b.hw, x1 = b.x + b.hw, z0 = b.z - b.hd, z1 = b.z + b.hd
    const cx = Math.max(x0, Math.min(pos.x, x1)), cz = Math.max(z0, Math.min(pos.z, z1))
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz
    const inside = pos.x > x0 && pos.x < x1 && pos.z > z0 && pos.z < z1
    if (!inside && d2 >= r * r) continue
    if (inside) {
      const dL = pos.x - x0, dR = x1 - pos.x, dT = pos.z - z0, dB = z1 - pos.z
      const m = Math.min(dL, dR, dT, dB)
      if (m === dT) pos.z = z0 - r
      else if (m === dB) pos.z = z1 + r
      else if (m === dL) pos.x = x0 - r
      else pos.x = x1 + r
    } else {
      const d = Math.sqrt(d2) || 0.0001
      pos.x += (dx / d) * (r - d)
      pos.z += (dz / d) * (r - d)
    }
  }
}

// Zit een punt in een blok? (projectielen stoppen tegen een platform, ook waar
// het bovendek een brug-opening heeft)
export function hitsBoxes(x, z) {
  for (const b of BOXES_GROND) {
    if (x > b.x - b.hw && x < b.x + b.hw && z > b.z - b.hd && z < b.z + b.hd) return true
  }
  return false
}
