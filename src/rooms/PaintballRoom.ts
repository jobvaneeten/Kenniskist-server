import { Room, Client, CloseCode } from "colyseus";
import { PaintballState, PBPlayer, PBShot } from "./schema/PaintballState.js";

// ── Arena + gameplay constants ──────────────────────────────────
const ARENA_HALF   = 38;          // square arena, walls at ±38
const PLAYER_RADIUS = 0.6;
const PLAYER_SPEED  = 5.2;
const EYE_Y         = 1.45;        // shoot origin height
const BODY_TOP      = 2.0;
const PROJ_SPEED    = 40;
const PROJ_RADIUS   = 0.18;
const PROJ_LIFE     = 2.2;         // seconds
const PROJ_GRAVITY  = 5.0;
const FIRE_CD       = 0.26;        // seconds between shots
const DMG           = 100;         // 1 treffer = uit
const RESPAWN_TIME  = 5;           // seconds
const MATCH_TIME    = 120;         // seconds
const TICK_RATE     = 60;
const MAG_SIZE      = 10;          // kogels per magazijn
const RELOAD_TIME   = 1.0;         // seconds
const GRAVITY       = 18;          // m/s² (jump physics)
const JUMP_VEL      = 7.5;         // m/s → ~1.5 m sprong (klim per stap)
const STEP_UP       = 0.3;         // landings-/sta-tolerantie

// Cover/platform boxes (centre x,z + half-width hw / half-depth hd + top
// height). You can stand on top and jump from box to box to climb. Mirrored
// exactly on the client so everything lines up.
type Obstacle = { x: number; z: number; hw: number; hd: number; top: number };
const OBSTACLES: Obstacle[] = [
  // Centrale klimpiramide (3 tieren)
  { x:   0, z:   0, hw: 3.0, hd: 3.0, top: 1.2 },
  { x:   0, z:   0, hw: 2.0, hd: 2.0, top: 2.4 },
  { x:   0, z:   0, hw: 1.0, hd: 1.0, top: 3.6 },
  // Dekking (laag)
  { x:  14, z:  10, hw: 1.8, hd: 1.8, top: 1.4 },
  { x: -14, z:  10, hw: 1.8, hd: 1.8, top: 1.4 },
  { x:  14, z: -10, hw: 1.8, hd: 1.8, top: 1.4 },
  { x: -14, z: -10, hw: 1.8, hd: 1.8, top: 1.4 },
  { x:   0, z:  19, hw: 3.0, hd: 1.2, top: 1.4 },
  { x:   0, z: -19, hw: 3.0, hd: 1.2, top: 1.4 },
  { x:  25, z:   0, hw: 1.2, hd: 3.0, top: 1.4 },
  { x: -25, z:   0, hw: 1.2, hd: 3.0, top: 1.4 },
  { x:  11, z:  25, hw: 1.6, hd: 1.6, top: 1.4 },
  { x: -11, z:  25, hw: 1.6, hd: 1.6, top: 1.4 },
  { x:  11, z: -25, hw: 1.6, hd: 1.6, top: 1.4 },
  { x: -11, z: -25, hw: 1.6, hd: 1.6, top: 1.4 },
  // Verhoogde platforms (bereikbaar via de lage dekking ernaast)
  { x:  19, z:  14, hw: 2.5, hd: 2.5, top: 2.6 },
  { x: -19, z:  14, hw: 2.5, hd: 2.5, top: 2.6 },
  { x:  19, z: -14, hw: 2.5, hd: 2.5, top: 2.6 },
  { x: -19, z: -14, hw: 2.5, hd: 2.5, top: 2.6 },
];

// Push a circle out of the arena walls + boxes whose top is above the feet
// (so you can walk across the top of a box you're standing on).
function resolvePos(cx: number, cz: number, rad: number, feetY: number) {
  const lim = ARENA_HALF - rad;
  let x = Math.max(-lim, Math.min(lim, cx));
  let z = Math.max(-lim, Math.min(lim, cz));
  for (const o of OBSTACLES) {
    if (o.top <= feetY + 0.15) continue;   // standing on/above it → no wall
    const minx = o.x - o.hw - rad, maxx = o.x + o.hw + rad;
    const minz = o.z - o.hd - rad, maxz = o.z + o.hd + rad;
    if (x > minx && x < maxx && z > minz && z < maxz) {
      const dl = x - minx, dr = maxx - x, dt = z - minz, db = maxz - z;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl)      x = minx;
      else if (m === dr) x = maxx;
      else if (m === dt) z = minz;
      else               z = maxz;
    }
  }
  return { x, z };
}

// Highest box-top under (x,z) that the feet can rest on (≤ feetY + step).
function supportHeight(x: number, z: number, feetY: number) {
  let h = 0;
  for (const o of OBSTACLES) {
    if (Math.abs(x - o.x) < o.hw && Math.abs(z - o.z) < o.hd && o.top <= feetY + STEP_UP) {
      h = Math.max(h, o.top);
    }
  }
  return h;
}

// Obstacle whose footprint contains (x,z) and that is tall enough to stop a
// projectile at height y (returns its top, or 0 if none).
function obstacleTopAt(x: number, z: number, y: number) {
  let top = 0;
  for (const o of OBSTACLES) {
    if (Math.abs(x - o.x) < o.hw && Math.abs(z - o.z) < o.hd && o.top > y) top = Math.max(top, o.top);
  }
  return top;
}

function spawnPoint(team: number, i: number) {
  const z = team === 0 ? 32 : -32;
  const x = ((i % 4) - 1.5) * 5;
  return { x, z, rotY: team === 0 ? Math.PI : 0 };
}

export class PaintballRoom extends Room {
  maxClients = 8;
  state = new PaintballState();

  private _interval: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _inputs: Map<string, { x: number; z: number; rotY: number; sprint: boolean }> = new Map();
  private _lastShot: Map<string, number> = new Map();   // sessionId → last fire time
  private _shotOwner: Map<string, string> = new Map();  // shotId → owner sessionId
  private _shotTtl: Map<string, number> = new Map();    // shotId → seconds left
  private _reloadDone: Map<string, number> = new Map(); // sessionId → time reload finishes
  private _vy: Map<string, number> = new Map();         // sessionId → vertical velocity
  private _grounded: Map<string, boolean> = new Map();  // sessionId → on a surface
  private _shotId = 1;

  onCreate(_options: any) {
    this.setPatchRate(33);

    this.onMessage("input", (client: Client, msg: any) => {
      this._inputs.set(client.sessionId, {
        x:     Math.max(-1, Math.min(1, msg.x ?? 0)),
        z:     Math.max(-1, Math.min(1, msg.z ?? 0)),
        rotY:  Number(msg.rotY) || 0,
        sprint: !!msg.sprint,
      });
    });

    this.onMessage("shoot", (client: Client, msg: any) => {
      if (this.state.phase !== "playing") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      if (p.reloading || p.ammo <= 0) return;
      const now = Date.now() / 1000;
      const last = this._lastShot.get(client.sessionId) ?? 0;
      if (now - last < FIRE_CD) return;
      this._lastShot.set(client.sessionId, now);

      let dx = Number(msg.dx) || 0, dy = Number(msg.dy) || 0, dz = Number(msg.dz) || 0;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;

      const id = String(this._shotId++);
      const s = new PBShot();
      s.team = p.team;
      s.x = p.x + dx * 0.7;
      s.y = EYE_Y + dy * 0.7;
      s.z = p.z + dz * 0.7;
      s.vx = dx * PROJ_SPEED;
      s.vy = dy * PROJ_SPEED;
      s.vz = dz * PROJ_SPEED;
      this.state.shots.set(id, s);
      this._shotOwner.set(id, client.sessionId);
      this._shotTtl.set(id, PROJ_LIFE);

      p.shootSeq++;
      p.ammo--;
      if (p.ammo <= 0) {
        p.reloading = true; p.reloadSeq++;
        this._reloadDone.set(client.sessionId, now + RELOAD_TIME);
      }
    });

    this.onMessage("reload", (client: Client) => {
      if (this.state.phase !== "playing") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive || p.reloading || p.ammo >= MAG_SIZE) return;
      p.reloading = true; p.reloadSeq++;
      this._reloadDone.set(client.sessionId, Date.now() / 1000 + RELOAD_TIME);
    });

    this.onMessage("jump", (client: Client) => {
      if (this.state.phase !== "playing") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive || p.reloading) return;
      if (this._grounded.get(client.sessionId)) {
        this._vy.set(client.sessionId, JUMP_VEL);
        this._grounded.set(client.sessionId, false);
        p.jumpSeq++;
      }
    });

    this.onMessage("start", (_client: Client) => {
      if (this.state.phase === "lobby") this._beginCountdown();
    });
  }

  onJoin(client: Client, options: { shirt?: string; wearing?: string; name?: string } = {}) {
    const p = new PBPlayer();
    const team = this.state.players.size % 2;
    p.team    = team;
    p.shirt   = options.shirt   ?? "";
    p.wearing = options.wearing ?? "";
    p.name    = options.name    ?? "Speler";
    const sp = spawnPoint(team, Math.floor(this.state.players.size / 2));
    p.x = sp.x; p.z = sp.z; p.rotY = sp.rotY;
    this.state.players.set(client.sessionId, p);
    this._inputs.set(client.sessionId, { x: 0, z: 0, rotY: p.rotY, sprint: false });
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this._inputs.delete(client.sessionId);
    this._lastShot.delete(client.sessionId);
    this._reloadDone.delete(client.sessionId);
    this._vy.delete(client.sessionId);
    this._grounded.delete(client.sessionId);
  }

  onDispose() {
    if (this._interval) clearInterval(this._interval);
  }

  private _beginCountdown() {
    this.state.phase = "countdown";
    this.state.countdown = 3;
    const tick = setInterval(() => {
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        clearInterval(tick);
        this.state.phase    = "playing";
        this.state.timeLeft = MATCH_TIME;
        this._startGameLoop();
      }
    }, 1000);
  }

  private _startGameLoop() {
    if (this._interval) clearInterval(this._interval);
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), 1000 / TICK_RATE);
  }

  private _respawn(p: PBPlayer, i: number) {
    const sp = spawnPoint(p.team, i);
    p.x = sp.x; p.z = sp.z; p.y = 0; p.rotY = sp.rotY;
    p.hp = 100; p.alive = true; p.respawnIn = 0;
    p.ammo = MAG_SIZE; p.reloading = false;
  }

  private _tick() {
    if (this.state.phase !== "playing") return;
    const now = Date.now();
    const dt  = Math.min((now - this._lastTick) / 1000, 0.05);
    this._lastTick = now;

    this.state.timeLeft -= dt;
    if (this.state.timeLeft <= 0) {
      this.state.timeLeft = 0;
      this.state.phase    = "gameover";
      if (this._interval) clearInterval(this._interval);
      return;
    }

    // ── Players ──
    let idx = 0;
    this.state.players.forEach((p: PBPlayer, sid: string) => {
      const i = idx++;
      if (!p.alive) {
        p.respawnIn = Math.max(0, p.respawnIn - dt);
        if (p.respawnIn <= 0) { this._respawn(p, i); this._vy.set(sid, 0); this._grounded.set(sid, true); }
        return;
      }
      if (p.reloading && now / 1000 >= (this._reloadDone.get(sid) ?? 0)) {
        p.reloading = false; p.ammo = MAG_SIZE; this._reloadDone.delete(sid);
      }
      const inp = this._inputs.get(sid) ?? { x: 0, z: 0, rotY: p.rotY, sprint: false };
      p.rotY = inp.rotY;
      // Horizontal (frozen while reloading)
      const vx = p.reloading ? 0 : inp.x * PLAYER_SPEED, vz = p.reloading ? 0 : inp.z * PLAYER_SPEED;
      const res = resolvePos(p.x + vx * dt, p.z + vz * dt, PLAYER_RADIUS, p.y);
      p.x = res.x; p.z = res.z;
      // Vertical (gravity + landing on box tops)
      let vy = (this._vy.get(sid) ?? 0) - GRAVITY * dt;
      p.y += vy * dt;
      const support = supportHeight(p.x, p.z, p.y);
      if (p.y <= support) { p.y = support; vy = 0; this._grounded.set(sid, true); }
      else this._grounded.set(sid, false);
      this._vy.set(sid, vy);
      p.moving = !p.reloading && Math.hypot(inp.x, inp.z) > 0.05;
    });

    // ── Projectiles ──
    this.state.shots.forEach((s: PBShot, id: string) => {
      const ttl = (this._shotTtl.get(id) ?? 0) - dt;
      s.vy -= PROJ_GRAVITY * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;

      let remove = false;
      // splat = impact point + outward surface normal (null = no decal, e.g. air)
      let splat: { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null = null;

      if (s.y <= 0.05) {                                                  // ground
        remove = true; splat = { x: s.x, y: 0.02, z: s.z, nx: 0, ny: 1, nz: 0 };
      } else if (Math.abs(s.x) > ARENA_HALF) {                            // x-wall
        remove = true; const sgn = s.x > 0 ? 1 : -1;
        splat = { x: sgn * ARENA_HALF, y: s.y, z: s.z, nx: -sgn, ny: 0, nz: 0 };
      } else if (Math.abs(s.z) > ARENA_HALF) {                            // z-wall
        remove = true; const sgn = s.z > 0 ? 1 : -1;
        splat = { x: s.x, y: s.y, z: sgn * ARENA_HALF, nx: 0, ny: 0, nz: -sgn };
      } else {                                                           // cover/platform box?
        let hitO: Obstacle | null = null;
        for (const o of OBSTACLES) {
          if (Math.abs(s.x - o.x) < o.hw && Math.abs(s.z - o.z) < o.hd && o.top > s.y) {
            if (!hitO || o.top > hitO.top) hitO = o;
          }
        }
        if (hitO) {
          remove = true; const o = hitO;
          const dl = s.x - (o.x - o.hw), dr = (o.x + o.hw) - s.x, db = s.z - (o.z - o.hd), df = (o.z + o.hd) - s.z;
          const m = Math.min(dl, dr, db, df);
          if (m === dl)      splat = { x: o.x - o.hw, y: s.y, z: s.z, nx: -1, ny: 0, nz: 0 };
          else if (m === dr) splat = { x: o.x + o.hw, y: s.y, z: s.z, nx: 1, ny: 0, nz: 0 };
          else if (m === db) splat = { x: s.x, y: s.y, z: o.z - o.hd, nx: 0, ny: 0, nz: -1 };
          else               splat = { x: s.x, y: s.y, z: o.z + o.hd, nx: 0, ny: 0, nz: 1 };
        }
      }
      if (!remove && ttl <= 0) remove = true;   // lifetime ended in the air → no splat

      if (!remove) {
        const owner = this._shotOwner.get(id);
        this.state.players.forEach((p: PBPlayer, sid: string) => {
          if (remove || !p.alive || sid === owner) return;
          const d = Math.hypot(p.x - s.x, p.z - s.z);
          if (d < PLAYER_RADIUS + PROJ_RADIUS && s.y > p.y + 0.2 && s.y < p.y + BODY_TOP) {
            remove = true;
            let nx = s.x - p.x, nz = s.z - p.z; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
            splat = { x: p.x + nx * PLAYER_RADIUS, y: s.y, z: p.z + nz * PLAYER_RADIUS, nx, ny: 0, nz };
            p.hp -= DMG;
            p.hitSeq++;
            if (p.hp <= 0) {
              p.hp = 0; p.alive = false; p.respawnIn = RESPAWN_TIME;
              const shooter = owner ? this.state.players.get(owner) : undefined;
              if (shooter) {
                shooter.score++;
                if (shooter.team === 0) this.state.scoreA++; else this.state.scoreB++;
              }
            }
          }
        });
      }

      if (remove) {
        if (splat) this.broadcast("splat", { ...splat, team: s.team });
        this.state.shots.delete(id);
        this._shotOwner.delete(id);
        this._shotTtl.delete(id);
      } else {
        this._shotTtl.set(id, ttl);
      }
    });
  }
}
