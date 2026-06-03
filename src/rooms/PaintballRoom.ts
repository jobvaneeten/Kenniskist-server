import { Room, Client, CloseCode } from "colyseus";
import { PaintballState, PBPlayer, PBShot } from "./schema/PaintballState.js";

// ── Arena + gameplay constants ──────────────────────────────────
// Per-map speelveld (halve x/z) + spawn-afstand. MOET kloppen met de client.
const MAPS: Record<string, { ax: number; az: number; spawnZ: number }> = {
  dorp: { ax: 24, az: 24, spawnZ: 20 },
  bos:  { ax: 40, az: 40, spawnZ: 34 },
};
const PLAYER_RADIUS = 0.6;
const PLAYER_SPEED  = 5.2;
const EYE_Y         = 1.45;        // shoot origin height
const BODY_TOP      = 2.0;
const CROUCH_TOP    = 1.15;        // kleinere hitbox bij hurken (= je lichaam)
const CROUCH_MULT   = 0.4;         // 2,5x trager dan normaal lopen
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

// Collision is done client-side against the GLB map; the server only needs
// spawns + arena bounds (per map).
function spawnPoint(team: number, i: number, spawnZ: number) {
  const z = team === 0 ? spawnZ : -spawnZ;   // team 0 = rood, team 1 = blauw (tegenover elkaar)
  const x = ((i % 4) - 1.5) * 3.5;
  return { x, z, rotY: team === 0 ? Math.PI : 0 };
}

export class PaintballRoom extends Room {
  maxClients = 8;
  state = new PaintballState();

  private _interval: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _lastShot: Map<string, number> = new Map();   // sessionId → last fire time
  private _shotOwner: Map<string, string> = new Map();  // shotId → owner sessionId
  private _shotTtl: Map<string, number> = new Map();    // shotId → seconds left
  private _shotRange: Map<string, number> = new Map();  // shotId → max travel (client raycast)
  private _shotTrav: Map<string, number> = new Map();   // shotId → travelled distance
  private _shotNormal: Map<string, { nx: number; ny: number; nz: number }> = new Map();
  private _reloadDone: Map<string, number> = new Map(); // sessionId → time reload finishes
  private _shotId = 1;
  private _ax = 24;
  private _az = 24;
  private _spawnZ = 20;

  onCreate(options: any) {
    this.setPatchRate(33);

    const mapKey = options?.map === "bos" ? "bos" : "dorp";
    const cfg = MAPS[mapKey];
    this._ax = cfg.ax; this._az = cfg.az; this._spawnZ = cfg.spawnZ;
    this.state.map = mapKey;

    // Movement is client-side (real mesh collision against the GLB map). The
    // client reports its authoritative position; the server just relays it.
    this.onMessage("state", (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      p.x = Math.max(-this._ax, Math.min(this._ax, Number(msg.x) || 0));
      p.z = Math.max(-this._az, Math.min(this._az, Number(msg.z) || 0));
      p.y = Math.max(0, Math.min(20, Number(msg.y) || 0));
      p.rotY = Number(msg.rotY) || 0;
      p.moving = !!msg.moving;
      p.crouching = !!msg.crouch;
      const js = Number(msg.jumpSeq);
      if (Number.isFinite(js)) p.jumpSeq = js;
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
      this._shotRange.set(id, Math.max(0.5, Number(msg.range) || 60));
      this._shotTrav.set(id, 0);
      this._shotNormal.set(id, { nx: Number(msg.nx) || 0, ny: Number(msg.ny) || 1, nz: Number(msg.nz) || 0 });

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
    const sp = spawnPoint(team, Math.floor(this.state.players.size / 2), this._spawnZ);
    p.x = sp.x; p.z = sp.z; p.rotY = sp.rotY;
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this._lastShot.delete(client.sessionId);
    this._reloadDone.delete(client.sessionId);
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
    const sp = spawnPoint(p.team, i, this._spawnZ);
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
        if (p.respawnIn <= 0) this._respawn(p, i);
        return;
      }
      // Movement is client-authoritative (see the "state" message). Server only
      // finishes reloads here.
      if (p.reloading && now / 1000 >= (this._reloadDone.get(sid) ?? 0)) {
        p.reloading = false; p.ammo = MAG_SIZE; this._reloadDone.delete(sid);
      }
    });

    // ── Projectiles ──
    this.state.shots.forEach((s: PBShot, id: string) => {
      const ttl = (this._shotTtl.get(id) ?? 0) - dt;
      s.vy -= PROJ_GRAVITY * dt;
      const px = s.x, py = s.y, pz = s.z;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      const trav = (this._shotTrav.get(id) ?? 0) + Math.hypot(s.x - px, s.y - py, s.z - pz);
      this._shotTrav.set(id, trav);

      let remove = false;
      // splat = impact point + outward surface normal (null = no decal, e.g. air)
      let splat: { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null = null;

      if (s.y <= 0.05) {                                                  // ground
        remove = true; splat = { x: s.x, y: 0.02, z: s.z, nx: 0, ny: 1, nz: 0 };
      } else if (Math.abs(s.x) > this._ax) {                             // x-wall
        remove = true; const sgn = s.x > 0 ? 1 : -1;
        splat = { x: sgn * this._ax, y: s.y, z: s.z, nx: -sgn, ny: 0, nz: 0 };
      } else if (Math.abs(s.z) > this._az) {                             // z-wall
        remove = true; const sgn = s.z > 0 ? 1 : -1;
        splat = { x: s.x, y: s.y, z: sgn * this._az, nx: 0, ny: 0, nz: -sgn };
      } else if (trav >= (this._shotRange.get(id) ?? 60)) {              // first solid wall (client raycast)
        remove = true; const n = this._shotNormal.get(id) ?? { nx: 0, ny: 1, nz: 0 };
        splat = { x: s.x, y: s.y, z: s.z, nx: n.nx, ny: n.ny, nz: n.nz };
      }
      if (!remove && ttl <= 0) remove = true;   // lifetime ended in the air → no splat

      if (!remove) {
        const owner = this._shotOwner.get(id);
        this.state.players.forEach((p: PBPlayer, sid: string) => {
          if (remove || !p.alive || sid === owner) return;
          const d = Math.hypot(p.x - s.x, p.z - s.z);
          const top = p.crouching ? CROUCH_TOP : BODY_TOP;   // hitbox = je lichaam
          if (d < PLAYER_RADIUS + PROJ_RADIUS && s.y > p.y + 0.2 && s.y < p.y + top) {
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
        this._shotRange.delete(id);
        this._shotTrav.delete(id);
        this._shotNormal.delete(id);
      } else {
        this._shotTtl.set(id, ttl);
      }
    });
  }
}
