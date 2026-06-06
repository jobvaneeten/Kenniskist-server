import { Room, Client, CloseCode } from "colyseus";
import { KartRoomState, KartPlayer } from "./schema/KartState.js";

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
const TRACK_PATHS: Record<string, () => { x: number; z: number }[]> = {
  groen:  () => stadiumPath(NSEG, 36, 26),
  woud:   () => polarPath(NSEG, (a) => 48 + 12 * Math.cos(2 * a) + 7 * Math.cos(3 * a)),
  bergen: () => polarPath(NSEG, (a) => 44 + 10 * Math.cos(2 * a) + 9 * Math.sin(3 * a) + 6 * Math.cos(5 * a)),
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
  private _bots: Map<string, { cum: number; cum0: number; speed: number; lane: number; wob: number; wobAmp: number }> = new Map();
  private _botSeq = 0;
  private _loop: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();

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
    const g = this._gridFor(grid);
    p.x = g.x; p.z = g.z; p.rotY = g.heading; p.lap = 1;
    this.state.players.set(sid, p);
    // Snelheid (index-eenheden/sec) + slinger per moeilijkheid
    const SP: Record<string, [number, number]> = { makkelijk: [9, 2], normaal: [13, 3], moeilijk: [17, 3] };
    const WOB: Record<string, number> = { makkelijk: 1.7, normaal: 1.2, moeilijk: 0.5 };
    const [base, span] = SP[diff];
    const cum0 = this.START_IDX - g.back * (NSEG / this._trackLen());
    this._bots.set(sid, {
      cum: cum0, cum0,
      speed: base + Math.random() * span,
      lane: (grid % 3 - 1) * 2.0,
      wob: Math.random() * Math.PI * 2,
      wobAmp: WOB[diff],
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

    this._bots.forEach((b, sid) => {
      const p = this.state.players.get(sid);
      if (!p || p.finished) return;
      b.cum += b.speed * dt;
      b.wob += dt * 1.5;
      const idx = ((Math.round(b.cum) % NSEG) + NSEG) % NSEG;
      const c = this.CENTER[idx], n = this.normalAt(idx), t = this.tangentAt(idx);
      const lane = b.lane + Math.sin(b.wob) * b.wobAmp;     // slinger per niveau
      p.x = c.x + n.x * lane;
      p.z = c.z + n.z * lane;
      p.rotY = Math.atan2(t.x, t.z);
      p.vel = 24;
      const prog = b.cum - b.cum0;
      p.lap = Math.min(this.state.laps, Math.floor(prog / NSEG) + 1);
      if (prog >= this.state.laps * NSEG) this._finish(p);
    });
  }
}
