import { Room, Client, CloseCode } from "colyseus";
import { RocketRoomState, PlayerState } from "./schema/RocketState.js";

// ── Exact same constants as FootballScene3D ─────────────────────
const FIELD_HALF   = 38;
const GOAL_Z       = 36;
const GOAL_HALF_W  = 3.65;
const GOAL_H       = 2.44;
const GOAL_DEPTH   = 1.6;
const BALL_RADIUS  = 0.22;
const PLAYER_RADIUS = 0.6;
const KICK_DIST    = 1.1;
const PLAYER_SPEED = 4.8;
const BOOST_SPEED  = 9.0;
const TICK_RATE    = 60;    // Hz — same feel as FootballScene3D
const GAME_DURATION = 120;  // seconds

// ── Rounded-rectangle arena boundary (Rocket League style) ──────
const BOUND     = GOAL_Z;        // walls sit on the white line (±36)
const CORNER_R  = 8;             // rounded-corner radius
const GOAL_BACK = BOUND + GOAL_DEPTH;  // back-net z (±37.6)

// Resolve a position against the rounded arena + open goal mouths.
// Returns the corrected position and the unit inward normal of contact
// ({nx,nz} = 0 if no contact).
function resolveBoundary(x: number, z: number, rad: number) {
  let ax = Math.abs(x), az = Math.abs(z);
  const sx = x < 0 ? -1 : 1, sz = z < 0 ? -1 : 1;
  let nx = 0, nz = 0;

  // ── Inside a goal mouth → bounded by the goal box (side + back nets) ──
  if (ax < GOAL_HALF_W - rad && az > BOUND - rad) {
    const sideLim = GOAL_HALF_W - rad;
    const backLim = GOAL_BACK - rad;
    if (ax > sideLim) { ax = sideLim; nx = -sx; }
    if (az > backLim) { az = backLim; nz = -sz; }
    return { x: sx * ax, z: sz * az, nx, nz };
  }

  // ── Rounded corner region ──
  const C = BOUND - CORNER_R;   // corner-arc centre coord (28)
  if (ax > C && az > C) {
    const dx = ax - C, dz = az - C;
    const d  = Math.hypot(dx, dz) || 1;
    const maxd = CORNER_R - rad;
    if (d > maxd) {
      const f = maxd / d;
      ax = C + dx * f; az = C + dz * f;
      nx = -sx * (dx / d); nz = -sz * (dz / d);
    }
    return { x: sx * ax, z: sz * az, nx, nz };
  }

  // ── Straight edges ──
  const lim = BOUND - rad;
  if (ax > lim) { ax = lim; nx = -sx; }
  if (az > lim) {
    // z-edge has the goal opening — only block outside the mouth
    if (!(ax < GOAL_HALF_W - rad)) { az = lim; nz = -sz; }
  }
  return { x: sx * ax, z: sz * az, nx, nz };
}

export class RocketRoom extends Room {
  maxClients = 6;
  state = new RocketRoomState();

  private _interval: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _inputs: Map<string, { x: number; z: number; boost: boolean }> = new Map();

  onCreate(options: any) {
    this.setPatchRate(33);   // broadcast state ~30x/sec — client interpolates

    this.onMessage("input", (client: Client, msg: { x: number; z: number; boost: boolean }) => {
      this._inputs.set(client.sessionId, {
        x:     Math.max(-1, Math.min(1, msg.x  ?? 0)),
        z:     Math.max(-1, Math.min(1, msg.z  ?? 0)),
        boost: !!msg.boost,
      });
    });

    this.onMessage("start", (_client: Client) => {
      if (this.state.phase === "lobby") this._beginCountdown();
    });
  }

  onJoin(client: Client, options: { shirt?: string; wearing?: string; name?: string } = {}) {
    const p = new PlayerState();
    const team = this.state.players.size % 2;
    p.team    = team;
    p.shirt   = options.shirt   ?? "";
    p.wearing = options.wearing ?? "";
    p.name    = options.name    ?? "Speler";
    p.x = 0;
    p.z = team === 0 ? 10 : -10;
    // Face the ball at centre: team 0 (z>0) looks toward -z (rotY=π), team 1 toward +z (rotY=0)
    p.rotY = team === 0 ? Math.PI : 0;
    this.state.players.set(client.sessionId, p);
    this._inputs.set(client.sessionId, { x: 0, z: 0, boost: false });
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this._inputs.delete(client.sessionId);
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
        this.state.timeLeft = GAME_DURATION;
        this._startGameLoop();
      }
    }, 1000);
  }

  private _startGameLoop() {
    if (this._interval) clearInterval(this._interval);
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), 1000 / TICK_RATE);
  }

  private _tick() {
    if (this.state.phase !== "playing") return;

    const now = Date.now();
    const dt  = Math.min((now - this._lastTick) / 1000, 0.05);
    this._lastTick = now;

    // Timer
    this.state.timeLeft -= dt;
    if (this.state.timeLeft <= 0) {
      this.state.timeLeft = 0;
      this.state.phase    = "gameover";
      if (this._interval) clearInterval(this._interval);
      return;
    }

    // ── Move players (same as CharacterController in FootballScene3D) ──
    this.state.players.forEach((p: PlayerState, sid: string) => {
      const inp = this._inputs.get(sid) ?? { x: 0, z: 0, boost: false };
      // Stamina: full = 2s sprint (drain 0.5/s); regen empty→full in 10s (0.1/s)
      const wantBoost = inp.boost && p.stamina > 0;
      if (wantBoost) p.stamina = Math.max(0, p.stamina - dt * 0.5);
      else           p.stamina = Math.min(1, p.stamina + dt * 0.1);

      const spd = wantBoost ? BOOST_SPEED : PLAYER_SPEED;
      p.boosting = wantBoost;

      const vx = inp.x * spd;
      const vz = inp.z * spd;

      const pres = resolveBoundary(p.x + vx * dt, p.z + vz * dt, PLAYER_RADIUS);
      p.x = pres.x; p.z = pres.z; p.y = 0;

      const speed = Math.hypot(vx, vz);
      if (speed > 0.05) {
        const targetRot = Math.atan2(vx, vz);
        let diff = targetRot - p.rotY;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        p.rotY += diff * Math.min(1, 14 * dt);
      }
      p.vx = vx;
      p.vz = vz;
    });

    // ── Ball physics (exact copy of PhysicsObject.update) ──────────────
    const ball = this.state.ball;
    const prevZ = ball.z;
    const prevX = ball.x;

    // Ball stays on the ground — purely 2D, never airborne.
    ball.x += ball.vx * dt;
    ball.z += ball.vz * dt;
    ball.y  = BALL_RADIUS;
    ball.vy = 0;

    // Friction (rolling on the ground)
    const f = Math.pow(0.91, dt * 60);
    ball.vx *= f;
    ball.vz *= f;

    // Rounded arena boundary — reflect velocity about the contact normal
    const bres = resolveBoundary(ball.x, ball.z, BALL_RADIUS);
    ball.x = bres.x; ball.z = bres.z;
    if (bres.nx !== 0 || bres.nz !== 0) {
      const dot = ball.vx * bres.nx + ball.vz * bres.nz;
      if (dot < 0) {
        ball.vx -= 1.5 * dot * bres.nx;   // restitution 0.5 → (1 + 0.5)
        ball.vz -= 1.5 * dot * bres.nz;
      }
    }

    // ── Ball ↔ player collision (swept circle — no tunnelling) ─────────
    // Treat the ball's path this tick as a segment from (prevX,prevZ) to
    // (ball.x,ball.z) and test it against each player's collision circle of
    // radius R. This catches fast balls that would skip past in one tick.
    const R = PLAYER_RADIUS + BALL_RADIUS;   // contact distance (0.82)
    this.state.players.forEach((p: PlayerState) => {
      const ax = prevX, az = prevZ;          // segment start
      const ex = ball.x - ax, ez = ball.z - az;  // segment direction
      const len2 = ex * ex + ez * ez;

      const fx = ax - p.x, fz = az - p.z;
      const a = len2;
      const b = 2 * (fx * ex + fz * ez);
      const c = fx * fx + fz * fz - R * R;

      let hit = false, tHit = 0;
      if (c < 0) {
        // ball started this tick already overlapping the player
        hit = true; tHit = 0;
      } else if (a > 1e-9) {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const t1 = (-b - Math.sqrt(disc)) / (2 * a);  // entry point
          if (t1 >= 0 && t1 <= 1) { hit = true; tHit = t1; }
        }
      }
      if (!hit) return;

      // Contact position along the path, snapped onto the player's surface
      const cx = ax + ex * tHit, cz = az + ez * tHit;
      let nx = cx - p.x, nz = cz - p.z;
      let nl = Math.hypot(nx, nz);
      if (nl < 1e-4) { nx = ball.x - p.x; nz = ball.z - p.z; nl = Math.hypot(nx, nz) || 1; }
      nx /= nl; nz /= nl;
      ball.x = p.x + nx * R;
      ball.z = p.z + nz * R;

      const pspd = Math.hypot(p.vx, p.vz);
      if (pspd > 0.3) {
        // Moving player kicks the ball forward along the ground (no lift)
        const fwdX = Math.sin(p.rotY), fwdZ = Math.cos(p.rotY);
        const kx = lerp(fwdX, nx, 0.35), kz = lerp(fwdZ, nz, 0.35);
        const kl = Math.hypot(kx, kz) || 1;
        const force = pspd * 2.5 + 1;
        ball.vx = (kx / kl) * force;
        ball.vz = (kz / kl) * force;
      } else {
        // Standing player: bounce the ball off (reflect along the normal)
        const vn = ball.vx * nx + ball.vz * nz;
        if (vn < 0) {
          ball.vx -= 1.6 * vn * nx;   // restitution 0.6
          ball.vz -= 1.6 * vn * nz;
        }
        // ensure a minimum push so it never rests inside the player
        const out = ball.vx * nx + ball.vz * nz;
        if (out < 0.8) { ball.vx += nx * 0.8; ball.vz += nz * 0.8; }
      }
    });

    // ── Goal detection (same crossing logic as FootballScene3D) ────────
    const inX = Math.abs(ball.x) < GOAL_HALF_W - 0.05;
    const inY = ball.y > 0.05 && ball.y < GOAL_H + 0.1;
    if (inX && inY) {
      // openDir=+1 → goal at -GOAL_Z, ball enters from +Z (prevZ > -GOAL_Z, currZ <= -GOAL_Z)
      if (prevZ > -GOAL_Z && ball.z <= -GOAL_Z) { this._goal("A"); return; }
      // openDir=-1 → goal at +GOAL_Z, ball enters from -Z (prevZ < GOAL_Z, currZ >= GOAL_Z)
      if (prevZ < GOAL_Z  && ball.z >= GOAL_Z)  { this._goal("B"); return; }
    }
  }

  private _goal(team: "A" | "B") {
    this.state.phase = "goal";
    if (team === "A") this.state.scoreA++;
    else              this.state.scoreB++;

    if (this._interval) clearInterval(this._interval);

    setTimeout(() => {
      this._reset();
      this.state.phase = "countdown";
      this.state.countdown = 3;
      const tick = setInterval(() => {
        this.state.countdown--;
        if (this.state.countdown <= 0) {
          clearInterval(tick);
          this.state.phase = "playing";
          this._startGameLoop();
        }
      }, 1000);
    }, 2500);
  }

  private _reset() {
    const b = this.state.ball;
    b.x = 0; b.y = BALL_RADIUS; b.z = 0;
    b.vx = 0; b.vy = 0; b.vz = 0;

    let tA = 0, tB = 0;
    this.state.players.forEach((p: PlayerState) => {
      if (p.team === 0) { p.x = (tA++ - 0.5) * 4; p.z =  12; p.rotY = Math.PI; }
      else              { p.x = (tB++ - 0.5) * 4; p.z = -12; p.rotY = 0; }
      p.vx = 0; p.vz = 0;
    });
  }
}

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
