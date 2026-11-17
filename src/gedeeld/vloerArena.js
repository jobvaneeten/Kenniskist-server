// ═══════════════════════════════════════════════════════════════════════════
//  Vloerquiz: vorm van de vloer en de puntentelling. ÉÉN BRON voor server en site.
// ═══════════════════════════════════════════════════════════════════════════
// Dit bestand staat in kenniskist-server/src/gedeeld/ en wordt met
// `npm run gedeeld` gekopieerd naar kenniskist/src/games/online/gedeeld/.
// Pas het alleen hier aan. Geen imports: het moet in Node én in de browser draaien.
//
// Een vierkante vloer met vier vlakken (2×2), elk vlak is een antwoord. In het
// midden ligt een rond startvlak: wie daar blijft staan kiest niets. Bovenaan
// in beeld is +z (de camera staat aan de -z-kant; Babylon is linkshandig, dus
// zo is +x rechts in beeld).
//
//    0 rood   | 1 blauw          bij twee antwoorden (waar/niet waar):
//    ---------+---------          links = 0, rechts = 1
//    2 geel   | 3 groen

export const HALF = 13          // de vloer loopt van -13 tot 13 in x en z
export const RAND = 12.4        // verder kan het poppetje niet
export const MIDDEN = 3.2       // straal van het startvlak
export const SNELHEID = 7       // meter per seconde
export const KLEUREN = ['#ff3d6e', '#3d8bff', '#ffc23d', '#3dff9a']
export const VORMEN = ['driehoek', 'ruit', 'rondje', 'vierkant']
export const MAX_SPELERS = 40

// Op welk vlak staat iemand? -1 = midden of een vlak zonder antwoord.
export function vakVan(x, z, aantal = 4) {
  if (Math.hypot(x, z) < MIDDEN) return -1
  if (aantal === 2) return x < 0 ? 0 : 1
  const i = (x < 0 ? 0 : 1) + (z > 0 ? 0 : 2)
  return i < aantal ? i : -1
}

// Middelpunt van een vlak (daar lopen de bots naartoe).
export function vakMidden(i, aantal = 4) {
  const d = HALF / 2 + MIDDEN / 2
  if (aantal === 2) return { x: i === 0 ? -d : d, z: 0 }
  return { x: i % 2 === 0 ? -d : d, z: i < 2 ? d : -d }
}

// Binnen de vloer houden.
export function klem(x, z) {
  return {
    x: Math.max(-RAND, Math.min(RAND, Number.isFinite(x) ? x : 0)),
    z: Math.max(-RAND, Math.min(RAND, Number.isFinite(z) ? z : 0)),
  }
}

// Punten voor een goed antwoord: 1000 als je er meteen staat, aflopend tot 500
// als je er pas op het laatst bent. `sec` = seconden na het begin van de vraag.
export function punten(sec, tijd) {
  const t = Math.max(0, Math.min(1, sec / Math.max(1, tijd)))
  return Math.round(1000 * (1 - t / 2))
}
