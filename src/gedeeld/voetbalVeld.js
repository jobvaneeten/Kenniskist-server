// ═══════════════════════════════════════════════════════════════════════════
//  Voetbal: veld, doelen en de rand. ÉÉN BRON voor server en site.
// ═══════════════════════════════════════════════════════════════════════════
// Dit bestand staat in kenniskist-server/src/gedeeld/ en wordt met
// `npm run gedeeld` gekopieerd naar kenniskist/src/games/online/gedeeld/.
// Pas het alleen hier aan; een test in beide projecten faalt als de kopie
// afwijkt. Geen imports: het moet in Node én in de browser draaien.

export const FIELD_HALF = 38
export const GOAL_Z = 36
export const GOAL_HALF_W = 3.65
export const GOAL_H = 2.44
export const GOAL_DEPTH = 1.6
export const BALL_RADIUS = 0.22
export const PLAYER_RADIUS = 0.6
export const PLAYER_SPEED = 4.8
export const BOOST_SPEED = 9.0
export const GAME_DURATION = 120   // seconden

// Afgeronde rechthoek (zoals Rocket League) met open doelmonden.
export const BOUND = GOAL_Z               // muren op de witte lijn (±36)
export const CORNER_R = 8                 // straal van de hoeken
export const GOAL_BACK = BOUND + GOAL_DEPTH

// Zet (x, z) met straal `rad` terug binnen het veld. Geeft de positie en de
// naar binnen wijzende normaal van het raakvlak ({nx, nz} = 0: geen contact).
export function resolveBoundary(x, z, rad) {
  let ax = Math.abs(x), az = Math.abs(z)
  const sx = x < 0 ? -1 : 1, sz = z < 0 ? -1 : 1
  let nx = 0, nz = 0

  // in een doelmond: begrensd door het doel (zijnet en achternet)
  if (ax < GOAL_HALF_W - rad && az > BOUND - rad) {
    const sideLim = GOAL_HALF_W - rad, backLim = GOAL_BACK - rad
    if (ax > sideLim) { ax = sideLim; nx = -sx }
    if (az > backLim) { az = backLim; nz = -sz }
    return { x: sx * ax, z: sz * az, nx, nz }
  }

  // afgeronde hoek
  const C = BOUND - CORNER_R
  if (ax > C && az > C) {
    const dx = ax - C, dz = az - C
    const d = Math.hypot(dx, dz) || 1
    const maxd = CORNER_R - rad
    if (d > maxd) {
      const f = maxd / d
      ax = C + dx * f; az = C + dz * f
      nx = -sx * (dx / d); nz = -sz * (dz / d)
    }
    return { x: sx * ax, z: sz * az, nx, nz }
  }

  // rechte randen; de doellijn heeft een opening bij het doel
  const lim = BOUND - rad
  if (ax > lim) { ax = lim; nx = -sx }
  if (az > lim && !(ax < GOAL_HALF_W - rad)) { az = lim; nz = -sz }
  return { x: sx * ax, z: sz * az, nx, nz }
}

// ── Spelregels per tik ─────────────────────────────────────────────────────
// De server rekent hiermee; de site gebruikt bewegSpeler om je eigen speler
// alvast te laten lopen voordat de server antwoordt (geen vertraging voelen).

// Speler een tik verder: sprint-energie, lopen binnen het veld, draaien naar
// de looprichting. inp = { x, z, boost } met x en z van -1 tot 1.
export function bewegSpeler(p, inp, dt) {
  // energie: vol = 2 s sprinten (0,5 per s eraf), leeg → vol in 10 s
  const wilBoost = inp.boost && p.stamina > 0
  if (wilBoost) p.stamina = Math.max(0, p.stamina - dt * 0.5)
  else p.stamina = Math.min(1, p.stamina + dt * 0.1)
  const spd = wilBoost ? BOOST_SPEED : PLAYER_SPEED
  p.boosting = wilBoost
  const vx = inp.x * spd, vz = inp.z * spd
  const r = resolveBoundary(p.x + vx * dt, p.z + vz * dt, PLAYER_RADIUS)
  p.x = r.x; p.z = r.z; p.y = 0
  if (Math.hypot(vx, vz) > 0.05) {
    let d = Math.atan2(vx, vz) - p.rotY
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    p.rotY += d * Math.min(1, 14 * dt)
  }
  p.vx = vx; p.vz = vz
}

// Bal tegen de rand: terugkaatsen (stuit 0,5).
function kaatsBal(ball) {
  const r = resolveBoundary(ball.x, ball.z, BALL_RADIUS)
  ball.x = r.x; ball.z = r.z
  if (r.nx || r.nz) {
    const dot = ball.vx * r.nx + ball.vz * r.nz
    if (dot < 0) { ball.vx -= 1.5 * dot * r.nx; ball.vz -= 1.5 * dot * r.nz }
  }
}

// Bal een tik verder: rollen over de grond met wrijving, tegen de rand kaatsen.
export function bewegBal(ball, dt) {
  ball.x += ball.vx * dt; ball.z += ball.vz * dt
  ball.y = BALL_RADIUS; ball.vy = 0
  const f = Math.pow(0.91, dt * 60)
  ball.vx *= f; ball.vz *= f
  kaatsBal(ball)
}

// Raakt de speler de bal deze tik? Vergelijkt de baan van de bal met die van
// de speler (vorige → nu), zodat een snelle speler of bal er nooit doorheen
// glipt. Bij raak schiet de bal weg; `pass` (potje-voetbal-knop) schiet harder.
export function balTegenSpeler(ball, balVoor, p, spelerVoor, pass) {
  const R = PLAYER_RADIUS + BALL_RADIUS
  const ax = balVoor.x - spelerVoor.x, az = balVoor.z - spelerVoor.z
  const bx = ball.x - p.x, bz = ball.z - p.z
  const ex = bx - ax, ez = bz - az
  const a = ex * ex + ez * ez, b = 2 * (ax * ex + az * ez), c = ax * ax + az * az - R * R
  let raak = false, t = 0
  if (c < 0) raak = true
  else if (a > 1e-9) {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * a)
      if (t1 >= 0 && t1 <= 1) { raak = true; t = t1 }
    }
  }
  if (!raak) return false
  let nx = ax + ex * t, nz = az + ez * t
  let nl = Math.hypot(nx, nz)
  if (nl < 1e-4) { nx = bx; nz = bz; nl = Math.hypot(nx, nz) || 1 }
  nx /= nl; nz /= nl
  // wegschieten: harder dan de speler zelf loopt, anders blijft de bal plakken
  const fwdX = Math.sin(p.rotY), fwdZ = Math.cos(p.rotY)
  const dx = fwdX + (nx - fwdX) * 0.3, dz = fwdZ + (nz - fwdZ) * 0.3
  const dl = Math.hypot(dx, dz) || 1
  const kracht = Math.max(Math.hypot(p.vx, p.vz) * 3 + 10, 14) * (pass ? 2.7 : 1)
  ball.vx = (dx / dl) * kracht; ball.vz = (dz / dl) * kracht
  ball.x = p.x + nx * (R + 0.15); ball.z = p.z + nz * (R + 0.15)
  return true
}

// Na alle trappen: de bal nooit in een muur laten zitten.
export const klemBal = kaatsBal

// Ging de bal deze tik over een doellijn? 'A' (doel op -z) / 'B' (+z) / null.
export function doelpunt(ball, vorigeZ) {
  if (Math.abs(ball.x) >= GOAL_HALF_W - 0.05) return null
  if (!(ball.y > 0.05 && ball.y < GOAL_H + 0.1)) return null
  if (vorigeZ > -GOAL_Z && ball.z <= -GOAL_Z) return 'A'
  if (vorigeZ < GOAL_Z && ball.z >= GOAL_Z) return 'B'
  return null
}
