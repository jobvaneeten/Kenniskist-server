import { Room, Client } from "colyseus";
import { BotsenRoomState, BotsenPlayer, BotsenShell, BotsenBomb, BotsenBox } from "./schema/BotsenState.js";

// ── Arena-geometrie (MOET kloppen met de client BotsenGame.jsx) ─────────
const ARENA_HALF = 34;
const WALL_T = 1.4;
const OBSTACLES = [
  { x: 12, z: 10, w: 6, d: 6 },
  { x: -12, z: -10, w: 6, d: 6 },
  { x: -14, z: 12, w: 5, d: 5 },
  { x: 14, z: -12, w: 5, d: 5 },
  { x: 0, z: 0, w: 7, d: 3 },
];
// Muren + obstakels als AABB's (halve breedte/diepte) voor botsing.
const half = ARENA_HALF;
const BOXES: { x: number; z: number; hw: number; hd: number }[] = [
  { x: 0, z: half + WALL_T / 2, hw: half + WALL_T, hd: WALL_T / 2 },
  { x: 0, z: -half - WALL_T / 2, hw: half + WALL_T, hd: WALL_T / 2 },
  { x: half + WALL_T / 2, z: 0, hw: WALL_T / 2, hd: half + WALL_T },
  { x: -half - WALL_T / 2, z: 0, hw: WALL_T / 2, hd: half + WALL_T },
  ...OBSTACLES.map(o => ({ x: o.x, z: o.z, hw: o.w / 2, hd: o.d / 2 })),
];
// Item-boxen: vaste plekken, weg van de obstakels (MOET kloppen met de client).
const BOX_SPOTS = [
  { x: 0, z: 22 }, { x: 0, z: -22 }, { x: 22, z: 0 }, { x: -22, z: 0 }, { x: 22, z: -22 }, { x: -22, z: 22 },
];

const CAR_RADIUS = 1.5;
const HIT_RADIUS = 2.3;
const BOMB_RADIUS = 4.5;
const USE_COOLDOWN = 0.45;   // sec tussen twee gebruiken van hetzelfde item (voorkomt spam-leegschieten)
const SHELL_SPEED = 22;      // units/s
const SHELL_LIFE = 3.2;      // sec
const FLAME_SPEED = 30;
const FLAME_LIFE = 2.0;
const BOMB_FUSE = 2.0;       // sec lont
const PICK_RADIUS = 2.6;
const BOX_RESPAWN = 6000;    // ms
const SPAWN_RADIUS = 18;
const MATCH_TIME = 150;      // sec
const ITEM_TYPES = ["schild", "bom", "vuurtje"];

function collideBoxes(pos: { x: number; z: number }, r: number) {
  for (const b of BOXES) {
    const x0 = b.x - b.hw, x1 = b.x + b.hw, z0 = b.z - b.hd, z1 = b.z + b.hd;
    const cx = Math.max(x0, Math.min(pos.x, x1)), cz = Math.max(z0, Math.min(pos.z, z1));
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    const inside = pos.x > x0 && pos.x < x1 && pos.z > z0 && pos.z < z1;
    if (!inside && d2 >= r * r) continue;
    if (inside) {
      const dL = pos.x - x0, dR = x1 - pos.x, dT = pos.z - z0, dB = z1 - pos.z;
      const m = Math.min(dL, dR, dT, dB);
      if (m === dT) pos.z = z0 - r;
      else if (m === dB) pos.z = z1 + r;
      else if (m === dL) pos.x = x0 - r;
      else pos.x = x1 + r;
    } else {
      const d = Math.sqrt(d2) || 0.0001;
      pos.x += (dx / d) * (r - d);
      pos.z += (dz / d) * (r - d);
    }
  }
}
// Simpel: is een punt binnen een obstakel (voor projectiel-blokkade)?
function hitsBoxes(x: number, z: number): boolean {
  for (const b of BOXES) {
    if (x > b.x - b.hw && x < b.x + b.hw && z > b.z - b.hd && z < b.z + b.hd) return true;
  }
  return false;
}
function randItem(): string { return ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)]; }

const NAMES = ["Luigi", "Peach", "Bowser", "Yoshi", "Toad", "Daisy", "Wario", "Rosalina"];
const COLORS = ["rood", "blauw", "groen", "geel", "oranje", "paars"];
const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
function botOutfit() {
  return { shirt: rand(COLORS), wearing: JSON.stringify({ broek: rand(COLORS), sokken: rand(COLORS), schoenen: rand(COLORS) }) };
}
function spawnFor(grid: number, total: number) {
  const n = Math.max(total, 4);
  const a = (grid / n) * Math.PI * 2;
  return { x: Math.cos(a) * SPAWN_RADIUS, z: Math.sin(a) * SPAWN_RADIUS, heading: a + Math.PI };
}

export class BotsenRoom extends Room {
  maxClients = 8;
  state = new BotsenRoomState();

  private _bots: Map<string, { wanderX: number; wanderZ: number; useCd: number; vel: number }> = new Map();
  private _botSeq = 0;
  private _shells: Map<string, { vx: number; vz: number; life: number; owner: string }> = new Map();
  private _shellSeq = 0;
  private _bombSeq = 0;
  private _cooldowns: Map<string, number> = new Map();   // sessionId → seconden tot volgend item-gebruik mag
  private _boxRespawn: number[] = [];
  private _loop: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _aliveAtStart = 0;
  private _eliminated = 0;

  onCreate() {
    this.setPatchRate(33);
    this._spawnBoxes();

    this.onMessage("state", (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.isBot || !p.alive) return;
      p.x = msg.x ?? p.x; p.z = msg.z ?? p.z; p.rotY = msg.rotY ?? p.rotY; p.vel = msg.vel ?? 0;
    });

    this.onMessage("start", (_c: Client) => { if (this.state.phase === "lobby") this._beginCountdown(); });

    this.onMessage("addBot", (_c: Client) => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size >= this.maxClients) return;
      this._addBot();
    });
    this.onMessage("removeBot", (_c: Client) => {
      if (this.state.phase !== "lobby") return;
      const ids = [...this._bots.keys()];
      const last = ids[ids.length - 1];
      if (last) { this._bots.delete(last); this.state.players.delete(last); }
    });

    this.onMessage("useItem", (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.isBot || !p.alive || this.state.phase !== "playing") return;
      this._useItem(client.sessionId, p);
    });
  }

  // Item-boxen op vaste plekken; active=false tijdens respawn.
  private _spawnBoxes() {
    this.state.boxes.clear();
    this._boxRespawn = [];
    BOX_SPOTS.forEach(s => {
      const b = new BotsenBox();
      b.x = s.x; b.z = s.z; b.active = true;
      this.state.boxes.push(b);
      this._boxRespawn.push(0);
    });
  }

  private _tickBoxes(now: number) {
    const boxes = this.state.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box.active) {
        if (this._boxRespawn[i] && now >= this._boxRespawn[i]) { box.active = true; this._boxRespawn[i] = 0; }
        continue;
      }
      this.state.players.forEach((p) => {
        if (!box.active || p.item || !p.alive) return;
        const dx = p.x - box.x, dz = p.z - box.z;
        if (dx * dx + dz * dz < PICK_RADIUS * PICK_RADIUS) {
          p.item = randItem(); p.itemCount = 3;
          box.active = false;
          this._boxRespawn[i] = now + BOX_RESPAWN;
        }
      });
    }
  }

  // Gebruik één lading van het huidige item (speler óf bot).
  private _useItem(sid: string, p: BotsenPlayer) {
    if (!p.item || p.itemCount <= 0) return;
    const cd = this._cooldowns.get(sid) ?? 0;
    if (cd > 0) return;
    this._cooldowns.set(sid, USE_COOLDOWN);

    if (p.item === "bom") {
      const bomb = new BotsenBomb();
      bomb.x = p.x - Math.sin(p.rotY) * 2.4; bomb.z = p.z - Math.cos(p.rotY) * 2.4;
      bomb.fuse = BOMB_FUSE;
      this.state.bombs.set("bm_" + (this._bombSeq++), bomb);
    } else {
      const kind = p.item === "vuurtje" ? "vuurtje" : "schild";
      const speed = kind === "vuurtje" ? FLAME_SPEED : SHELL_SPEED;
      const life = kind === "vuurtje" ? FLAME_LIFE : SHELL_LIFE;
      const sh = new BotsenShell();
      sh.x = p.x + Math.sin(p.rotY) * 2.2; sh.z = p.z + Math.cos(p.rotY) * 2.2; sh.kind = kind;
      const id = "sh_" + (this._shellSeq++);
      this.state.shells.set(id, sh);
      this._shells.set(id, { vx: Math.sin(p.rotY) * speed, vz: Math.cos(p.rotY) * speed, life, owner: sid });
    }

    p.itemCount--;
    if (p.itemCount <= 0) { p.item = ""; p.itemCount = 0; }
  }

  private _addBot() {
    const sid = "bot_" + (this._botSeq++);
    const p = new BotsenPlayer();
    const grid = this.state.players.size;
    p.grid = grid; p.isBot = true;
    p.name = "🤖 " + rand(NAMES);
    const o = botOutfit(); p.shirt = o.shirt; p.wearing = o.wearing;
    const s = spawnFor(grid, this.state.players.size + 1);
    p.x = s.x; p.z = s.z; p.rotY = s.heading;
    this.state.players.set(sid, p);
    this._bots.set(sid, { wanderX: s.x, wanderZ: s.z, useCd: Math.random() * 1.5, vel: 0 });
  }

  onJoin(client: Client, options: { shirt?: string; wearing?: string; name?: string } = {}) {
    const p = new BotsenPlayer();
    p.grid = this.state.players.size;
    p.shirt = options.shirt ?? ""; p.wearing = options.wearing ?? ""; p.name = options.name ?? "Speler";
    const s = spawnFor(p.grid, this.state.players.size + 1);
    p.x = s.x; p.z = s.z; p.rotY = s.heading;
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
        this.state.phase = "playing";
        this.state.timeLeft = MATCH_TIME;
        this._aliveAtStart = this.state.players.size;
        this._eliminated = 0;
        this._lastTick = Date.now();
        this._loop = setInterval(() => this._tick(), 1000 / 30);
      }
    }, 1000);
  }

  private _popBalloon(sid: string, p: BotsenPlayer) {
    p.balloons = Math.max(0, p.balloons - 1);
    p.hitSeq++;
    if (p.balloons <= 0 && p.alive) {
      p.alive = false;
      this._eliminated++;
      p.place = this._aliveAtStart - this._eliminated + 1;
      this._checkWin();
    }
  }

  private _checkWin() {
    const alivePlayers: [string, BotsenPlayer][] = [];
    this.state.players.forEach((p, sid) => { if (p.alive) alivePlayers.push([sid, p]); });
    if (alivePlayers.length <= 1 && this.state.players.size > 1) {
      this._finish(alivePlayers[0]?.[1]?.name ?? "");
    } else if (this.state.players.size === 1 && alivePlayers.length === 0) {
      this._finish("");
    }
  }

  private _finish(winnerName: string) {
    if (this.state.phase !== "playing") return;
    this.state.phase = "gameover";
    this.state.winnerName = winnerName;
    if (this._loop) { clearInterval(this._loop); this._loop = null; }
  }

  private _tick() {
    if (this.state.phase !== "playing") return;
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;

    this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
    if (this.state.timeLeft <= 0) {
      // Tijd op: meeste ballonnen wint (bij gelijk: gedeelde overwinning → geen naam)
      let best: BotsenPlayer | null = null, bestCount = -1, tie = false;
      this.state.players.forEach(p => {
        if (!p.alive) return;
        if (p.balloons > bestCount) { best = p; bestCount = p.balloons; tie = false; }
        else if (p.balloons === bestCount) tie = true;
      });
      this._finish(tie || !best ? "" : (best as BotsenPlayer).name);
      return;
    }

    // Cooldowns aftellen
    for (const [sid, cd] of this._cooldowns) if (cd > 0) this._cooldowns.set(sid, Math.max(0, cd - dt));

    // ── Bots besturen ──
    this._bots.forEach((b, sid) => {
      const p = this.state.players.get(sid);
      if (!p || !p.alive) return;
      // dichtstbijzijnde levende tegenstander zoeken
      let best: { sid: string; p: BotsenPlayer; d: number } | null = null;
      this.state.players.forEach((op, osid) => {
        if (osid === sid || !op.alive) return;
        const d = Math.hypot(op.x - p.x, op.z - p.z);
        if (!best || d < best.d) best = { sid: osid, p: op, d };
      });
      let tx: number, tz: number;
      if (best && (best as any).d < 30) { tx = (best as any).p.x; tz = (best as any).p.z; }
      else { tx = b.wanderX; tz = b.wanderZ; }
      if (Math.hypot(tx - p.x, tz - p.z) < 3) {
        // nieuw random wander-doel binnen de arena
        b.wanderX = (Math.random() * 2 - 1) * (ARENA_HALF - 8);
        b.wanderZ = (Math.random() * 2 - 1) * (ARENA_HALF - 8);
      }
      const dx = tx - p.x, dz = tz - p.z;
      const desired = Math.atan2(dx, dz);
      let diff = desired - p.rotY;
      while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      p.rotY += Math.max(-1, Math.min(1, diff)) * 1.8 * dt;
      b.vel = Math.min(20, b.vel + 16 * dt);
      const fx = Math.sin(p.rotY), fz = Math.cos(p.rotY);
      const pos = { x: p.x + fx * b.vel * dt, z: p.z + fz * b.vel * dt };
      collideBoxes(pos, CAR_RADIUS);
      p.x = pos.x; p.z = pos.z; p.vel = b.vel;
      // item gebruiken als de tegenstander recht voor hem staat en dichtbij genoeg (of altijd voor een bom)
      b.useCd = Math.max(0, b.useCd - dt);
      if (p.item && b.useCd <= 0) {
        const aimedOk = p.item === "bom" ? true : (!!best && (best as any).d < 24 && Math.abs(diff) < 0.25);
        if (aimedOk) { this._useItem(sid, p); b.useCd = 0.6 + Math.random() * 0.6; }
      }
    });

    this._tickBoxes(now);

    // ── Schilden/vuurtjes bewegen + botsing checken ──
    this._shells.forEach((s, id) => {
      const sh = this.state.shells.get(id);
      if (!sh) { this._shells.delete(id); return; }
      s.life -= dt;
      sh.x += s.vx * dt; sh.z += s.vz * dt;
      let hitDone = false;
      if (hitsBoxes(sh.x, sh.z) || Math.abs(sh.x) > ARENA_HALF || Math.abs(sh.z) > ARENA_HALF) hitDone = true;
      if (!hitDone) this.state.players.forEach((p, pid) => {
        if (hitDone || pid === s.owner || !p.alive) return;
        const dx = p.x - sh.x, dz = p.z - sh.z;
        if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS) { this._popBalloon(pid, p); hitDone = true; }
      });
      if (hitDone || s.life <= 0) { this.state.shells.delete(id); this._shells.delete(id); }
    });

    // ── Bommen: lont aftellen, dan ontploffen (iedereen binnen bereik, incl. eigenaar) ──
    this.state.bombs.forEach((bomb, id) => {
      bomb.fuse -= dt;
      if (bomb.fuse <= 0) {
        this.state.players.forEach((p, pid) => {
          if (!p.alive) return;
          const dx = p.x - bomb.x, dz = p.z - bomb.z;
          if (dx * dx + dz * dz < BOMB_RADIUS * BOMB_RADIUS) this._popBalloon(pid, p);
        });
        this.state.bombs.delete(id);
      }
    });
  }
}
