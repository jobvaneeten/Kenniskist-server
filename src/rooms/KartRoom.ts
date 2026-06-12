import { Room, Client, CloseCode } from "colyseus";
import { KartRoomState, KartPlayer, ItemBox, Hazard, Shell } from "./schema/KartState.js";

// ── Item-systeem-constanten ─────────────────────────────────────────────
const ITEM_WEIGHTS: [string, number][] = [["boost", 4], ["banana", 3], ["shell", 3], ["star", 1]];
const BOOST_DUR = 2.2;   // sec
const STAR_DUR  = 5.0;   // sec
const SPIN_DUR  = 1.6;   // sec geraakt (tol + afremmen)
const BOX_STEP  = 26;    // afstand tussen item-boxes (in segmenten)
const BOX_RESPAWN = 5000; // ms voor een box terugkomt
const HIT_RADIUS = 2.2;   // m raak-afstand voor banaan/schild
const PICK_RADIUS = 2.6;  // m oppak-afstand item-box
function randItem(): string {
  const total = ITEM_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of ITEM_WEIGHTS) { if ((r -= w) <= 0) return k; }
  return "boost";
}

// ── Baan-geometrie (MOET exact kloppen met de client KartGame.jsx) ──────
const NSEG = 400;
function stadiumPath(N: number, STR: number, CR: number) {
  const straight = 2 * STR, corner = Math.PI * CR;
  const total = 2 * straight + 2 * corner;
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < N; i++) {
    const s = (i / N) * total;
    let x: number, z: number;
    if (s < straight) { const u = s / straight; x = -STR + u * 2 * STR; z = CR; }
    else if (s < straight + corner) { const a = (s - straight) / corner; const ang = Math.PI / 2 - a * Math.PI; x = STR + Math.cos(ang) * CR; z = Math.sin(ang) * CR; }
    else if (s < 2 * straight + corner) { const u = (s - straight - corner) / straight; x = STR - u * 2 * STR; z = -CR; }
    else { const a = (s - 2 * straight - corner) / corner; const ang = -Math.PI / 2 - a * Math.PI; x = -STR + Math.cos(ang) * CR; z = Math.sin(ang) * CR; }
    pts.push({ x, z });
  }
  return pts;
}
function polarPath(N: number, fn: (a: number) => number) {
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; const r = fn(a); pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r }); }
  return pts;
}
// MOET exact gelijk zijn aan de client (KartGame.jsx TRACKS.path)
const TRACK_PATHS: Record<string, () => { x: number; z: number }[]> = {
  groen:  () => polarPath(NSEG, (a) => 82 + 22 * Math.cos(2 * a) + 5 * Math.cos(3 * a)),
  woud:   () => polarPath(NSEG, (a) => 84 + 18 * Math.cos(2 * a) + 11 * Math.cos(3 * a) + 7 * Math.sin(5 * a)),
  bergen: () => polarPath(NSEG, (a) => 86 + 20 * Math.cos(2 * a) + 13 * Math.sin(3 * a) + 9 * Math.cos(5 * a) + 5 * Math.sin(7 * a)),
};

const NAMES = ["Luigi", "Peach", "Bowser", "Yoshi", "Toad", "Daisy", "Wario", "Rosalina"];
const COLORS = ["rood", "blauw", "groen", "geel", "oranje", "paars"];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
function botOutfit() {
  return { shirt: rand(COLORS), wearing: JSON.stringify({ broek: rand(COLORS), sokken: rand(COLORS), schoenen: rand(COLORS) }) };
}

export class KartRoom extends Room {
  maxClients = 8;
  state = new KartRoomState();

  private CENTER: { x: number; z: number }[] = [];
  private START_IDX = 0;
  private _bots: Map<string, { cum: number; cum0: number; speed: number; vel: number; lane: number; wob: number; wobAmp: number; itemDelay: number }> = new Map();
  private _botSeq = 0;
  private _loop: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _shells: Map<string, { cum: number; lane: number; owner: string; life: number }> = new Map();
  private _hazards: Map<string, { grace: number }> = new Map();
  private _boxRespawn: number[] = [];   // per box: timestamp (ms) waarop hij terugkomt, 0 = actief
  private _seq = 0;

  private tangentAt(i: number) {
    const N = NSEG, a = this.CENTER[((i + 1) % N + N) % N], b = this.CENTER[((i - 1) % N + N) % N];
    let tx = a.x - b.x, tz = a.z - b.z; const L = Math.hypot(tx, tz) || 1;
    return { x: tx / L, z: tz / L };
  }
  private normalAt(i: number) {
    const t = this.tangentAt(i), c = this.CENTER[i];
    let nx = t.z, nz = -t.x;
    if (nx * c.x + nz * c.z < 0) { nx = -nx; nz = -nz; }
    return { x: nx, z: nz };
  }
  private computeStartIdx() {
    let best = 0, bestCurv = Infinity;
    for (let i = 0; i < NSEG; i++) {
      const t1 = this.tangentAt(i - 5), t2 = this.tangentAt(i + 5);
      const dot = Math.max(-1, Math.min(1, t1.x * t2.x + t1.z * t2.z));
      const curv = Math.acos(dot);
      if (curv < bestCurv) { bestCurv = curv; best = i; }
    }
    return best;
  }

  onCreate(options: any) {
    this.setPatchRate(33);
    this.state.laps = Math.max(1, Math.min(5, Number(options?.laps) || 3));
    if (typeof options?.track === "string") this.state.track = options.track;
    this.CENTER = (TRACK_PATHS[this.state.track] || TRACK_PATHS.groen)();
    this.START_IDX = this.computeStartIdx();
    this._spawnBoxes();

    // Positie-update vanaf de echte client (zijn eigen kart)
    this.onMessage("state", (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.isBot) return;
      p.x = msg.x ?? p.x; p.z = msg.z ?? p.z; p.rotY = msg.rotY ?? p.rotY; p.vel = msg.vel ?? 0;
      if (typeof msg.lap === "number") p.lap = msg.lap;
    });

    this.onMessage("start", (_c: Client) => { if (this.state.phase === "lobby") this._beginCountdown(); });

    this.onMessage("addBot", (_c: Client, msg: any) => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size >= this.maxClients) return;
      this._addBot(typeof msg === "string" ? msg : msg?.difficulty);
    });
    this.onMessage("removeBot", (_c: Client) => {
      if (this.state.phase !== "lobby") return;
      const ids = [...this._bots.keys()];
      const last = ids[ids.length - 1];
      if (last) { this._bots.delete(last); this.state.players.delete(last); }
    });

    this.onMessage("finished", (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.finished) return;
      this._finish(p);
    });

    // Speler gebruikt zijn vastgehouden item
    this.onMessage("useItem", (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.isBot || !p.item || this.state.phase !== "racing") return;
      this._useItem(client.sessionId, p);
    });
  }

  // Vaste item-box-posities langs de centerline (wisselende baan-offset)
  private _spawnBoxes() {
    this.state.boxes.clear();
    this._boxRespawn = [];
    const LANES = [-3, 0, 3];
    let k = 0;
    for (let i = 0; i < NSEG; i += BOX_STEP) {
      const c = this.CENTER[i], n = this.normalAt(i);
      const lane = LANES[k % LANES.length];
      const b = new ItemBox();
      b.x = c.x + n.x * lane; b.z = c.z + n.z * lane; b.active = true;
      this.state.boxes.push(b);
      this._boxRespawn.push(0);
      k++;
    }
  }

  // ── Item gebruiken (speler óf bot) ──
  private _useItem(sid: string, p: KartPlayer) {
    const item = p.item;
    p.item = "";
    if (item === "boost") { p.boost = BOOST_DUR; }
    else if (item === "star") { p.star = STAR_DUR; }
    else if (item === "banana") {
      // Banaan iets achter de kart
      const bx = p.x - Math.sin(p.rotY) * 2.2, bz = p.z - Math.cos(p.rotY) * 2.2;
      const h = new Hazard(); h.x = bx; h.z = bz;
      const id = "hz_" + (this._seq++);
      this.state.hazards.set(id, h);
      this._hazards.set(id, { grace: 0.6 });
    } else if (item === "shell") {
      // Schild vooruit langs de baan vanaf de huidige positie
      const near = this._nearestIdx(p.x, p.z);
      const sh = new Shell(); sh.x = p.x; sh.z = p.z;
      const id = "sh_" + (this._seq++);
      this.state.shells.set(id, sh);
      this._shells.set(id, { cum: near.idx, lane: near.lane, owner: sid, life: 6 });
    }
  }

  private _nearestIdx(x: number, z: number) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < NSEG; i++) {
      const dx = x - this.CENTER[i].x, dz = z - this.CENTER[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    // lane = signed afstand langs de normaal
    const n = this.normalAt(best), c = this.CENTER[best];
    const lane = (x - c.x) * n.x + (z - c.z) * n.z;
    return { idx: best, lane };
  }

  private _gridFor(grid: number) {
    const c = this.CENTER[this.START_IDX], t = this.tangentAt(this.START_IDX), n = this.normalAt(this.START_IDX);
    const row = Math.floor(grid / 2), col = grid % 2;
    const back = row * 4.5 + 1, side = (col === 0 ? -1 : 1) * 2.4;
    return { x: c.x - t.x * back + n.x * side, z: c.z - t.z * back + n.z * side, heading: Math.atan2(t.x, t.z), back };
  }

  private _addBot(difficulty?: string) {
    const sid = "bot_" + (this._botSeq++);
    const p = new KartPlayer();
    const grid = this.state.players.size;
    p.grid = grid; p.isBot = true;
    const diff = difficulty === "makkelijk" || difficulty === "moeilijk" ? difficulty : "normaal";
    const tag = diff === "makkelijk" ? " (makkelijk)" : diff === "moeilijk" ? " (moeilijk)" : "";
    p.name = "🤖 " + rand(NAMES) + tag;
    const o = botOutfit(); p.shirt = o.shirt; p.wearing = o.wearing;
    // Snelheid als fractie van de speler-topsnelheid (34 units/s), omgerekend
    // naar index-eenheden/sec via de baanlengte → consistente moeilijkheid op
    // elke (nu langere) baan. Bots rijden de centerline op constante snelheid en
    // remmen niet voor bochten, dus ~0.9 is al keihard.
    const PLAYER_MAX = 34;
    const trackLen = this._trackLen();
    const segPerUnit = NSEG / trackLen;
    const segLen = trackLen / NSEG;                          // units per segment
    const FRAC: Record<string, [number, number]> = {
      makkelijk: [0.66, 0.08],   // 0.66–0.74
      normaal:   [0.85, 0.06],   // 0.85–0.91
      moeilijk:  [1.00, 0.07],   // 1.00–1.07  (boven speler-top + perfecte lijn → echt moeilijk)
    };
    const WOB: Record<string, number> = { makkelijk: 1.0, normaal: 0.4, moeilijk: 0.04 };
    const [fb, fs] = FRAC[diff];
    const frac = fb + Math.random() * fs;
    const speed = (frac * PLAYER_MAX) / segLen;              // idx/s

    // ── Spawn-positie = EXACT wat _tick straks berekent (centerline + lane),
    // zodat de bot bij GO niet vooruit/opzij springt. 2 banen, rijen naar
    // achteren — net als de human-grid. ──
    const row = Math.floor(grid / 2), col = grid % 2;
    const lane = (col === 0 ? -1 : 1) * 2.4;
    const back = row * 4.5 + 1;                              // units achter de startlijn
    const cum0 = this.START_IDX - back * segPerUnit;
    const idx0 = (((Math.round(cum0)) % NSEG) + NSEG) % NSEG;
    const c0 = this.CENTER[idx0], n0 = this.normalAt(idx0), t0 = this.tangentAt(idx0);
    p.x = c0.x + n0.x * lane;
    p.z = c0.z + n0.z * lane;
    p.rotY = Math.atan2(t0.x, t0.z);
    p.lap = 1;
    this.state.players.set(sid, p);

    this._bots.set(sid, {
      cum: cum0, cum0,
      speed,
      vel: 0,
      lane,
      wob: Math.random() * Math.PI * 2,
      wobAmp: WOB[diff],
      itemDelay: 0,
    });
  }

  private _trackLen() {
    let L = 0;
    for (let i = 0; i < NSEG; i++) { const a = this.CENTER[i], b = this.CENTER[(i + 1) % NSEG]; L += Math.hypot(b.x - a.x, b.z - a.z); }
    return L;
  }

  onJoin(client: Client, options: { shirt?: string; wearing?: string; name?: string } = {}) {
    const p = new KartPlayer();
    p.grid = this.state.players.size;
    p.shirt = options.shirt ?? ""; p.wearing = options.wearing ?? ""; p.name = options.name ?? "Speler";
    const g = this._gridFor(p.grid);
    p.x = g.x; p.z = g.z; p.rotY = g.heading;
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client) { this.state.players.delete(client.sessionId); }
  onDispose() { if (this._loop) clearInterval(this._loop); }

  private _beginCountdown() {
    this.state.phase = "countdown";
    this.state.countdown = 3;
    const tick = setInterval(() => {
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        clearInterval(tick);
        this.state.phase = "racing";
        this._lastTick = Date.now();
        this._loop = setInterval(() => this._tick(), 1000 / 30);
      }
    }, 1000);
  }

  private _finish(p: KartPlayer) {
    p.finished = true;
    this.state.finishedCount++;
    p.place = this.state.finishedCount;
    if (this.state.finishedCount >= this.state.players.size) {
      this.state.phase = "finished";
      if (this._loop) { clearInterval(this._loop); this._loop = null; }
    }
  }

  private _tick() {
    if (this.state.phase !== "racing") return;
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;
    const segLen = this._trackLen() / NSEG;

    // ── Effect-timers aftellen voor IEDEREEN (mens + bot) ──
    this.state.players.forEach((p) => {
      if (p.boost > 0) p.boost = Math.max(0, p.boost - dt);
      if (p.star  > 0) p.star  = Math.max(0, p.star  - dt);
      if (p.spin  > 0) p.spin  = Math.max(0, p.spin  - dt);
    });

    // ── Bots verplaatsen (met optrek-ramp zodat ze niet instant vooruitschieten) ──
    this._bots.forEach((b, sid) => {
      const p = this.state.players.get(sid);
      if (!p || p.finished) return;

      // Doelsnelheid + effecten
      let target = b.speed;
      if (p.boost > 0) target *= 1.5;
      if (p.star  > 0) target *= 1.25;
      if (p.spin  > 0) target  = 0;            // geraakt → sta (bijna) stil
      // Optrekken/afremmen richting doel (≈ speler-gevoel: 0→top in ~1.2s)
      const accel = b.speed / 1.2;
      if (b.vel < target) b.vel = Math.min(target, b.vel + accel * dt);
      else                b.vel = Math.max(target, b.vel - accel * 2 * dt);

      b.cum += b.vel * dt;
      b.wob += dt * (b.wobAmp > 0.8 ? 0.7 : 1.2);
      const idx = ((Math.round(b.cum) % NSEG) + NSEG) % NSEG;
      const c = this.CENTER[idx], n = this.normalAt(idx), t = this.tangentAt(idx);
      const lane = b.lane + Math.sin(b.wob) * b.wobAmp;
      p.x = c.x + n.x * lane;
      p.z = c.z + n.z * lane;
      p.rotY = Math.atan2(t.x, t.z);
      p.vel = b.vel * segLen;                  // units/s (voor wiel-spin op de client)

      // Bot-AI: kort na het oppakken het item gebruiken
      if (p.item) {
        if (b.itemDelay <= 0) b.itemDelay = 0.6 + Math.random() * 1.2;
        b.itemDelay -= dt;
        if (b.itemDelay <= 0) { this._useItem(sid, p); b.itemDelay = 0; }
      }

      const prog = b.cum - b.cum0;
      p.lap = Math.min(this.state.laps, Math.floor(prog / NSEG) + 1);
      if (prog >= this.state.laps * NSEG) this._finish(p);
    });

    this._tickBoxes(now);
    this._tickShells(dt, segLen);
    this._tickHazards(dt);
  }

  // Item-boxes: oppakken + respawnen
  private _tickBoxes(now: number) {
    const boxes = this.state.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box.active) {
        if (this._boxRespawn[i] && now >= this._boxRespawn[i]) { box.active = true; this._boxRespawn[i] = 0; }
        continue;
      }
      // Eerste kart zonder item die de box raakt, pakt 'm
      this.state.players.forEach((p) => {
        if (!box.active || p.item || p.finished) return;
        const dx = p.x - box.x, dz = p.z - box.z;
        if (dx * dx + dz * dz < PICK_RADIUS * PICK_RADIUS) {
          p.item = randItem();
          box.active = false;
          this._boxRespawn[i] = now + BOX_RESPAWN;
        }
      });
    }
  }

  // Schild-projectielen: vooruit langs de baan, raakt eerste kart op de weg
  private _tickShells(dt: number, segLen: number) {
    const SHELL_SPEED = (40 / segLen);   // idx/s, sneller dan de karts
    this._shells.forEach((s, id) => {
      s.life -= dt;
      s.cum += SHELL_SPEED * dt;
      const idx = ((Math.round(s.cum) % NSEG) + NSEG) % NSEG;
      const c = this.CENTER[idx], n = this.normalAt(idx);
      const sh = this.state.shells.get(id);
      if (sh) { sh.x = c.x + n.x * s.lane; sh.z = c.z + n.z * s.lane; }
      let hitDone = false;
      this.state.players.forEach((p, pid) => {
        if (hitDone || pid === s.owner || p.star > 0 || p.finished || !sh) return;
        const dx = p.x - sh.x, dz = p.z - sh.z;
        if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS) { p.spin = SPIN_DUR; hitDone = true; }
      });
      if (hitDone || s.life <= 0) { this.state.shells.delete(id); this._shells.delete(id); }
    });
  }

  // Bananen: blijven liggen, raken de eerste kart (behalve de eigenaar kort)
  private _tickHazards(dt: number) {
    this._hazards.forEach((h, id) => {
      h.grace = Math.max(0, h.grace - dt);
      const hz = this.state.hazards.get(id);
      if (!hz) { this._hazards.delete(id); return; }
      if (h.grace > 0) return;   // pas scherp na korte armering (eigenaar rijdt weg)
      let hit = false;
      this.state.players.forEach((p) => {
        if (hit || p.star > 0 || p.spin > 0 || p.finished) return;
        const dx = p.x - hz.x, dz = p.z - hz.z;
        if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS) { p.spin = SPIN_DUR; hit = true; }
      });
      if (hit) { this.state.hazards.delete(id); this._hazards.delete(id); }
    });
  }
}
