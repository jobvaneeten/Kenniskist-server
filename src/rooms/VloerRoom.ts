import { Room, Client, CloseCode } from "colyseus";
import { VloerState, VloerSpeler } from "./schema/VloerState.js";
// Vorm van de vloer en de punten: gedeeld met de site (src/gedeeld/vloerArena.js).
import { MIDDEN, SNELHEID, MAX_SPELERS, vakVan, vakMidden, klem, punten } from "../gedeeld/vloerArena.js";

// Vloerquiz: Kahoot met je eigen poppetje. De leerkracht maakt het potje aan
// (host, staat zelf niet op de vloer) en geeft de vragen mee. Per vraag rennen
// de kinderen naar het vlak met het goede antwoord; wie op een fout vlak staat
// valt eraf. Tijdens een vraag ziet niemand de anderen. Na de uitslag staan
// de kinderen die het goed hadden op het bord en kunnen ze een emote doen; na
// UITSLAG_TIJD gaat het vanzelf door (de leerkracht kan pauzeren).
//
// De kinderen sturen zelf hun plek (vloeiend op een trage school-wifi); de
// server houdt ze binnen de vloer en remt te grote sprongen af.

type Vraag = { vraag: string; opties: string[]; goed: number };
type Bot = { kans: number; doel: { x: number; z: number } | null; start: number };

export const MAX_VRAGEN = 60;
export const TIJDEN = [10, 20, 30, 60];
const VAL_TIJD = 2600;   // ms van vallen tot weer op het startvlak
const UITSLAG_TIJD = 8000;   // ms dat de goede kinderen op het bord staan
const PATCH_NORMAAL = 50;    // ms tussen updates naar de kinderen
const PATCH_VRAAG = 125;     // tijdens een vraag (niemand ziet de anderen)
const BOT_NAMES = ["Luigi", "Peach", "Yoshi", "Toad", "Daisy", "Wario", "Rosalina", "Bowser"];
const BOT_KLEUREN = ["rood", "blauw", "groen", "geel", "oranje", "paars"];
const BOT_KANS: Record<string, number> = { makkelijk: 0.45, normaal: 0.7, moeilijk: 0.92 };

const tekst = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const willekeurig = <T>(lijst: T[]) => lijst[Math.floor(Math.random() * lijst.length)];
function schud<T>(lijst: T[]): T[] {
  const a = [...lijst];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Vragen van de leerkracht controleren: { vraag, goed, fout: [] } met 1 tot 3
// foute keuzes. De keuzes komen in een willekeurige volgorde op de vlakken.
export function maakVragen(ruw: unknown): Vraag[] {
  if (!Array.isArray(ruw)) return [];
  const uit: Vraag[] = [];
  for (const v of ruw.slice(0, MAX_VRAGEN)) {
    const vraag = tekst(v?.vraag, 200), goed = tekst(v?.goed, 80);
    if (!vraag || !goed) continue;
    const fout: string[] = [];
    for (const f of Array.isArray(v?.fout) ? v.fout : []) {
      const t = tekst(f, 80);
      const al = [goed, ...fout].some(x => x.toLowerCase() === t.toLowerCase());
      if (t && !al) fout.push(t);
      if (fout.length === 3) break;
    }
    if (!fout.length) continue;   // minstens twee keuzes
    const opties = schud([goed, ...fout]);
    uit.push({ vraag, opties, goed: opties.indexOf(goed) });
  }
  return uit;
}

// Plekken op het startvlak: een zonnebloem-spiraal, zodat 40 kinderen niet
// precies op elkaar staan.
function startPlek(i: number) {
  const r = Math.min(MIDDEN - 0.7, 0.55 * Math.sqrt(i + 0.5));
  const a = i * 2.39996;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

export class VloerRoom extends Room {
  maxClients = MAX_SPELERS + 1;   // + de leerkracht
  state = new VloerState();

  private _hostId = "";
  private _vragen: Vraag[] = [];
  private _vraagStart = 0;
  private _sinds = new Map<string, { vak: number; t: number }>();   // sinds wanneer op dit vlak
  private _laatst = new Map<string, number>();                      // laatste plek-bericht
  private _valt = new Set<string>();
  private _bots = new Map<string, Bot>();
  private _botSeq = 0;
  private _uitslagEind = 0;
  private _emoteT = new Map<string, number>();

  onCreate(options: any) {
    this._vragen = maakVragen(options?.vragen);
    if (!this._vragen.length) throw new Error("geen vragen");
    this.state.aantal = this._vragen.length;
    this.state.tijd = TIJDEN.includes(Number(options?.tijd)) ? Number(options.tijd) : 20;
    this.setPatchRate(PATCH_NORMAAL);

    const isHost = (c: Client) => c.sessionId === this._hostId;

    this.onMessage("plek", (client: Client, m: any) => this._plek(client.sessionId, m));

    this.onMessage("start", (c: Client) => {
      if (isHost(c) && this.state.phase === "lobby") this._aftellen();
    });
    // eerder stoppen: iedereen staat al
    this.onMessage("klaar", (c: Client) => {
      if (isHost(c) && this.state.phase === "vraag") this._uitslag();
    });
    this.onMessage("volgende", (c: Client) => {
      if (isHost(c) && this.state.phase === "uitslag") this._volgende();
    });
    this.onMessage("pauze", (c: Client) => {
      if (isHost(c)) this.state.pauze = !this.state.pauze;
    });
    this.onMessage("emote", (c: Client, k: any) => this._emote(c.sessionId, k));
    // nog een keer: zelfde vragen en kinderen, punten weer op 0
    this.onMessage("opnieuw", (c: Client) => {
      if (!isHost(c) || this.state.phase !== "einde") return;
      this.state.players.forEach(p => { p.score = 0; p.laatste = 0; p.reeks = 0; p.goed = -1; });
      this._vragen = this._vragen.map(v => {
        const opties = schud(v.opties);
        return { vraag: v.vraag, opties, goed: opties.indexOf(v.opties[v.goed]) };
      });
      this.state.nr = 0; this.state.vraag = ""; this.state.opties.clear(); this.state.goed = -1;
      this._allesNaarMidden();
      this.state.phase = "lobby";
    });

    this.onMessage("addBot", (c: Client, niveau: any) => {
      if (!isHost(c) || this.state.phase !== "lobby" || this.state.players.size >= MAX_SPELERS) return;
      this._addBot(typeof niveau === "string" ? niveau : "normaal");
    });
    this.onMessage("removeBot", (c: Client) => {
      if (!isHost(c) || this.state.phase !== "lobby") return;
      const laatste = [...this._bots.keys()].pop();
      if (laatste) { this._bots.delete(laatste); this.state.players.delete(laatste); }
    });

    this.clock.setInterval(() => this._tik(), 100);
  }

  onJoin(client: Client, options: any = {}) {
    if (options?.host && !this._hostId) { this._hostId = client.sessionId; return; }
    if (this.state.players.size >= MAX_SPELERS) throw new Error("vol");
    const p = new VloerSpeler();
    p.name = tekst(options?.name, 12) || "Speler";
    p.shirt = tekst(options?.shirt, 40);
    p.wearing = tekst(options?.wearing, 600);
    const plek = startPlek(this.state.players.size);
    p.x = plek.x; p.z = plek.z;
    this.state.players.set(client.sessionId, p);
  }

  // Wifi even weg: kinderen 30 seconden, de leerkracht 2 minuten.
  onDrop(client: Client) {
    const host = client.sessionId === this._hostId;
    if (host) this.state.hostWeg = true;
    this.allowReconnection(client, host ? 120 : 30);
  }

  onReconnect(client: Client) {
    if (client.sessionId === this._hostId) this.state.hostWeg = false;
  }

  onLeave(client: Client, _code: CloseCode) {
    if (client.sessionId === this._hostId) {
      // Zonder leerkracht kan het potje niet verder. Eerst een bericht, dan
      // gaan de kinderen zelf weg: een sluiting door de server komt via de
      // proxy van Render aan als 'verbinding kwijt', en dan blijft de SDK het
      // een minuut lang opnieuw proberen. Na 3 seconden ruimt de server op.
      this.broadcast("gestopt");
      this.clock.setTimeout(() => this.disconnect(), 3000);
      return;
    }
    this.state.players.delete(client.sessionId);
    this._sinds.delete(client.sessionId);
    this._laatst.delete(client.sessionId);
    this._valt.delete(client.sessionId);
    this._emoteT.delete(client.sessionId);
  }

  // Een emote: alleen in de wachtkamer, bij de uitslag en op het podium, en
  // niet vaker dan eens per 0,7 seconde. Welke emotes er zijn weet de site.
  private _emote(sid: string, k: any) {
    const p = this.state.players.get(sid);
    const f = this.state.phase;
    if (!p || (f !== "lobby" && f !== "uitslag" && f !== "einde")) return;
    if (typeof k !== "string" || !/^[a-z_]{1,24}$/.test(k)) return;
    const nu = Date.now();
    if (nu - (this._emoteT.get(sid) ?? 0) < 700) return;
    this._emoteT.set(sid, nu);
    p.emote = k;
    p.emoteSeq++;
  }

  // ── Plek van een kind ─────────────────────────────────────────────────
  private _plek(sid: string, m: any) {
    const p = this.state.players.get(sid);
    if (!p || this._valt.has(sid) || this.state.phase === "einde") return;
    // nog een oude plek van voordat de server het kind ergens neerzette
    if (Number(m?.s) !== p.plekSeq) return;
    const { x, z } = klem(Number(m?.x), Number(m?.z));
    const nu = Date.now();
    const sinds = Math.min(2, (nu - (this._laatst.get(sid) ?? nu - 1000)) / 1000);
    this._laatst.set(sid, nu);
    const max = SNELHEID * 1.6 * sinds + 2;
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > max) {
      // te grote sprong: zo ver als kan, en het kind krijgt de plek van de server
      p.x += (x - p.x) / d * max; p.z += (z - p.z) / d * max;
      p.plekSeq++;
    } else {
      p.x = x; p.z = z;
    }
    if (Number.isFinite(Number(m?.r))) p.rotY = Number(m.r);
    p.loopt = !!m?.l;
  }

  // ── Verloop ───────────────────────────────────────────────────────────
  private _aftellen() {
    this.state.phase = "aftellen";
    this.state.countdown = 3;
    this._allesNaarMidden();
    const t = this.clock.setInterval(() => {
      this.state.countdown--;
      if (this.state.countdown <= 0) { t.clear(); this._vraag(0); }
    }, 1000);
  }

  private _vraag(i: number) {
    const v = this._vragen[i];
    this._allesNaarMidden();
    this.state.nr = i + 1;
    this.state.vraag = v.vraag;
    this.state.opties.clear();
    v.opties.forEach(o => this.state.opties.push(o));
    this.state.goed = -1;
    this.state.players.forEach(p => { p.laatste = 0; p.goed = -1; });
    this._sinds.clear();
    this._vraagStart = Date.now();
    this.state.timeLeft = this.state.tijd;
    this.state.phase = "vraag";
    // tijdens de vraag ziet niemand de anderen: minder vaak bijwerken scheelt
    // met 35 kinderen veel verkeer op de schoolwifi
    this.setPatchRate(PATCH_VRAAG);

    // bots: kiezen met een kans goed, en beginnen pas na even nadenken
    this._bots.forEach(b => {
      const n = v.opties.length;
      const fout = [...Array(n).keys()].filter(k => k !== v.goed);
      const vak = Math.random() < b.kans ? v.goed : willekeurig(fout);
      const m = vakMidden(vak, n);
      b.doel = { x: m.x + (Math.random() - 0.5) * 5, z: m.z + (Math.random() - 0.5) * 5 };
      b.start = Date.now() + (1 + Math.random() * this.state.tijd * 0.45) * 1000;
    });
  }

  private _uitslag() {
    const v = this._vragen[this.state.nr - 1];
    this.state.phase = "uitslag";
    this.setPatchRate(PATCH_NORMAAL);
    this._uitslagEind = Date.now() + UITSLAG_TIJD;
    this.state.timeLeft = UITSLAG_TIJD / 1000;
    this.state.goed = v.goed;
    const n = v.opties.length;
    this.state.players.forEach((p, sid) => {
      const vak = vakVan(p.x, p.z, n);
      if (vak === v.goed) {
        const s = this._sinds.get(sid);
        const sec = s && s.vak === vak ? (s.t - this._vraagStart) / 1000 : this.state.tijd;
        p.laatste = punten(sec, this.state.tijd);
        p.score += p.laatste;
        p.reeks++;
        p.goed = 1;
      } else {
        p.laatste = 0;
        p.reeks = 0;
        p.goed = vak < 0 ? -1 : 0;
        // fout vlak of op het startvlak blijven staan: dat valt allebei weg
        p.valSeq++;
        this._valt.add(sid);
      }
    });
    this.clock.setTimeout(() => {
      let i = 0;
      this._valt.forEach(sid => {
        const p = this.state.players.get(sid);
        if (p) this._zet(p, startPlek(i++));
      });
      this._valt.clear();
    }, VAL_TIJD);
  }

  private _volgende() {
    if (this.state.nr < this._vragen.length) this._vraag(this.state.nr);
    else this._einde();
  }

  private _einde() {
    this.state.phase = "einde";
    this.state.pauze = false;
    this._valt.clear();
    // de beste drie op het podium in het midden, de rest in een kring eromheen
    const rij = [...this.state.players.values()].sort((a, b) => b.score - a.score);
    const podium = [{ x: 0, z: 0.6 }, { x: -2.4, z: 0 }, { x: 2.4, z: 0 }];
    rij.forEach((p, i) => {
      if (i < 3) this._zet(p, podium[i]);
      else {
        const a = Math.PI * (0.15 + 0.7 * ((i - 3) / Math.max(1, rij.length - 4)));
        this._zet(p, { x: -Math.cos(a) * 7, z: -1.5 - Math.sin(a) * 3 });
      }
      p.rotY = Math.PI;   // naar de camera (die staat aan de -z-kant)
      p.loopt = false;
    });
  }

  private _allesNaarMidden() {
    this._valt.clear();
    let i = 0;
    this.state.players.forEach(p => this._zet(p, startPlek(i++)));
  }

  private _zet(p: VloerSpeler, plek: { x: number; z: number }) {
    p.x = plek.x; p.z = plek.z; p.loopt = false;
    p.plekSeq++;
  }

  private _addBot(niveau: string) {
    const sid = "bot_" + (this._botSeq++);
    const p = new VloerSpeler();
    const nv = BOT_KANS[niveau] !== undefined ? niveau : "normaal";
    p.isBot = true;
    p.name = "🤖 " + willekeurig(BOT_NAMES);
    p.shirt = willekeurig(BOT_KLEUREN);
    p.wearing = JSON.stringify({ broek: willekeurig(BOT_KLEUREN), sokken: willekeurig(BOT_KLEUREN), schoenen: willekeurig(BOT_KLEUREN) });
    const plek = startPlek(this.state.players.size);
    p.x = plek.x; p.z = plek.z;
    this.state.players.set(sid, p);
    this._bots.set(sid, { kans: BOT_KANS[nv], doel: null, start: 0 });
  }

  // ── Elke 0,1 seconde ──────────────────────────────────────────────────
  private _tik() {
    const nu = Date.now();
    const s = this.state;

    this._botsLopen(0.1, nu);

    if (s.phase === "uitslag") {
      s.timeLeft = Math.max(0, (this._uitslagEind - nu) / 1000);
      if (!s.pauze && nu >= this._uitslagEind) this._volgende();
      return;
    }
    if (s.phase !== "vraag") return;
    s.timeLeft = Math.max(0, s.tijd - (nu - this._vraagStart) / 1000);
    const n = s.opties.length;
    s.players.forEach((p, sid) => {
      const vak = vakVan(p.x, p.z, n);
      const was = this._sinds.get(sid);
      if (!was || was.vak !== vak) this._sinds.set(sid, { vak, t: nu });
    });
    if (s.timeLeft <= 0) this._uitslag();
  }

  private _botsLopen(dt: number, nu: number) {
    const fase = this.state.phase;
    this._bots.forEach((b, sid) => {
      const p = this.state.players.get(sid);
      if (!p || this._valt.has(sid)) return;
      // in de wachtkamer wat rondlopen
      if (fase === "lobby" && (!b.doel || Math.random() < 0.01)) {
        b.doel = klem((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22); b.start = nu;
      }
      if ((fase !== "vraag" && fase !== "lobby") || !b.doel || nu < b.start) { p.loopt = false; return; }
      const dx = b.doel.x - p.x, dz = b.doel.z - p.z, d = Math.hypot(dx, dz);
      const stap = SNELHEID * (fase === "lobby" ? 0.45 : 0.85) * dt;
      if (d <= stap) { p.x = b.doel.x; p.z = b.doel.z; p.loopt = false; if (fase === "lobby") b.doel = null; return; }
      p.x += dx / d * stap; p.z += dz / d * stap;
      p.rotY = Math.atan2(dx, dz);
      p.loopt = true;
    });
  }
}
