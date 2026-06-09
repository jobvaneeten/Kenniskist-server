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

const BOT_NAMES  = ["Luigi", "Peach", "Bowser", "Yoshi", "Toad", "Daisy", "Wario", "Rosalina"];
const BOT_COLORS = ["rood", "blauw", "groen", "geel", "oranje", "paars"];

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
  private _inputs: Map<string, { x: number; z: number; boost: boolean; pass: boolean }> = new Map();
  private _prevPos: Map<string, { x: number; z: number }> = new Map();
  private _bots: Set<string> = new Set();
  private _botSeq = 0;
  private _botSkill: Map<string, { noise: number; boostDist: number; speedMul: number }> = new Map();
  private _botTarget: Map<string, { x: number; z: number; nextUpdate: number }> = new Map();

  onCreate(options: any) {
    this.setPatchRate(33);   // broadcast state ~30x/sec — client interpolates

    this.onMessage("input", (client: Client, msg: { x: number; z: number; boost: boolean; pass: boolean }) => {
      this._inputs.set(client.sessionId, {
        x:     Math.max(-1, Math.min(1, msg.x  ?? 0)),
        z:     Math.max(-1, Math.min(1, msg.z  ?? 0)),
        boost: !!msg.boost,
        pass:  !!msg.pass,    // pass-mode toggle: stronger forward kick on contact
      });
    });

    this.onMessage("start", (_client: Client) => {
      if (this.state.phase === "lobby") this._beginCountdown();
    });

    this.onMessage("addBot", (_client: Client, msg: any) => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size >= this.maxClients) return;
      this._addBot(typeof msg === "string" ? msg : msg?.difficulty);
    });
    this.onMessage("removeBot", (_client: Client) => {
      if (this.state.phase !== "lobby") return;
      const ids = [...this._bots];
      const last = ids[ids.length - 1];
      if (last) { this._bots.delete(last); this.state.players.delete(last); this._inputs.delete(last); this._botSkill.delete(last); }
    });

    const EMOTES = new Set(["hip_hop", "breakdance", "verloren"]);
    this.onMessage("emote", (client: Client, name: string) => {
      if (!EMOTES.has(name)) return;
      const p = this.state.players.get(client.sessionId);
      if (p) { p.emote = name; p.emoteSeq++; }
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
    this._inputs.set(client.sessionId, { x: 0, z: 0, boost: false, pass: false });
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this._inputs.delete(client.sessionId);
    this._prevPos.delete(client.sessionId);
  }

  private _addBot(difficulty?: string) {
    const sid = "bot_" + (this._botSeq++);
    const p = new PlayerState();
    const team = this.state.players.size % 2;
    p.team = team; p.isBot = true;
    const diff = difficulty === "makkelijk" || difficulty === "moeilijk" ? difficulty : "normaal";
    const tag = diff === "makkelijk" ? " (makkelijk)" : diff === "moeilijk" ? " (moeilijk)" : "";
    p.name = "🤖 " + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + tag;
    p.shirt = BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)];
    p.wearing = JSON.stringify({ broek: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)], sokken: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)], schoenen: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)] });
    p.x = 0; p.z = team === 0 ? 10 : -10; p.rotY = team === 0 ? Math.PI : 0;
    this.state.players.set(sid, p);
    this._inputs.set(sid, { x: 0, z: 0, boost: false, pass: false });
    this._bots.add(sid);
    const SK: Record<string, { noise: number; boostDist: number; speedMul: number }> = {
      makkelijk: { noise: 3.5, boostDist: 999, speedMul: 0.72 },
      normaal:   { noise: 1.5, boostDist: 14, speedMul: 0.90 },
      moeilijk:  { noise: 0,   boostDist: 7,  speedMul: 1 },
    };
    this._botSkill.set(sid, SK[diff]);
  }

  // Bot-AI: beweeg naar benaderpunt achter de bal (richting eigen doel).
  // Target wordt slechts elke N seconden herberekend zodat bots niet elke tick
  // flikkeren door de ruis.
  private _botThink() {
    const ball = this.state.ball;
    const now = Date.now() / 1000;
    this._bots.forEach((sid) => {
      const p = this.state.players.get(sid);
      if (!p) return;
      const sk = this._botSkill.get(sid) ?? { noise: 1.5, boostDist: 14, speedMul: 0.90 };
      let bt = this._botTarget.get(sid);
      const interval = sk.noise > 2 ? 0.45 : sk.noise > 0.5 ? 0.2 : 0.08;
      if (!bt || now >= bt.nextUpdate) {
        const goalZ = p.team === 0 ? -GOAL_Z : GOAL_Z;
        let gx = ball.x, gz = ball.z - goalZ;
        const gl = Math.hypot(gx, gz) || 1; gx /= gl; gz /= gl;
        bt = {
          x: ball.x + gx * 1.5 + (Math.random() - 0.5) * sk.noise,
          z: ball.z + gz * 1.5 + (Math.random() - 0.5) * sk.noise,
          nextUpdate: now + interval,
        };
        this._botTarget.set(sid, bt);
      }
      let dx = bt.x - p.x, dz = bt.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const inp = this._inputs.get(sid)!;
      inp.x = Math.max(-1, Math.min(1, (dx / d) * sk.speedMul));
      inp.z = Math.max(-1, Math.min(1, (dz / d) * sk.speedMul));
      inp.boost = Math.hypot(ball.x - p.x, ball.z - p.z) > sk.boostDist;
      inp.pass = false;
    });
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

    this._botThink();

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
      this._prevPos.set(sid, { x: p.x, z: p.z });   // start-of-tick position
      const inp = this._inputs.get(sid) ?? { x: 0, z: 0, boost: false, pass: false };
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

    // ── Ball ↔ player collision (RELATIVE swept circle — no tunnelling) ─
    // Test the ball's path relative to each player's path this tick, so a
    // fast player into a slow ball (or vice-versa) can never pass through.
    const R = PLAYER_RADIUS + BALL_RADIUS;   // contact distance (0.82)
    this.state.players.forEach((p: PlayerState, sid: string) => {
      const pp = this._prevPos.get(sid) ?? { x: p.x, z: p.z };
      // relative position (ball − player) at start and end of the tick
      const ax = prevX  - pp.x, az = prevZ  - pp.z;
      const bx = ball.x - p.x,  bz = ball.z - p.z;
      const ex = bx - ax, ez = bz - az;
      const a = ex * ex + ez * ez;
      const b = 2 * (ax * ex + az * ez);
      const c = ax * ax + az * az - R * R;

      let hit = false, tHit = 0;
      if (c < 0) { hit = true; tHit = 0; }            // started overlapping
      else if (a > 1e-9) {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const t1 = (-b - Math.sqrt(disc)) / (2 * a);  // entry point
          if (t1 >= 0 && t1 <= 1) { hit = true; tHit = t1; }
        }
      }
      if (!hit) return;

      // Contact normal (relative position at the moment of contact)
      let nx = ax + ex * tHit, nz = az + ez * tHit;
      let nl = Math.hypot(nx, nz);
      if (nl < 1e-4) { nx = bx; nz = bz; nl = Math.hypot(nx, nz) || 1; }
      nx /= nl; nz /= nl;
      // Snap ball onto the player's surface
      ball.x = p.x + nx * R;
      ball.z = p.z + nz * R;

      // Shoot the ball forward on contact. The force must clearly beat the
      // player's own speed so the ball separates instead of sticking.
      // Pass-mode ON → a much harder shot (≥ 2.5× the normal contact kick).
      const inp   = this._inputs.get(sid);
      const passMult = inp?.pass ? 2.7 : 1;
      const pspd  = Math.hypot(p.vx, p.vz);
      const fwdX  = Math.sin(p.rotY), fwdZ = Math.cos(p.rotY);
      const dx    = lerp(fwdX, nx, 0.3), dz = lerp(fwdZ, nz, 0.3);
      const dl    = Math.hypot(dx, dz) || 1;
      const force = Math.max(pspd * 3 + 10, 14) * passMult;
      ball.vx = (dx / dl) * force;
      ball.vz = (dz / dl) * force;
      // Nudge the ball slightly further out so the player can't re-grab it
      ball.x = p.x + nx * (R + 0.15);
      ball.z = p.z + nz * (R + 0.15);
    });

    // Final safety clamp: keep the ball inside the arena even right after a
    // kick pinned it against the wall (so it never ends up inside a wall).
    {
      const cl = resolveBoundary(ball.x, ball.z, BALL_RADIUS);
      ball.x = cl.x; ball.z = cl.z;
      if (cl.nx !== 0 || cl.nz !== 0) {
        const dot = ball.vx * cl.nx + ball.vz * cl.nz;
        if (dot < 0) { ball.vx -= 1.5 * dot * cl.nx; ball.vz -= 1.5 * dot * cl.nz; }
      }
    }

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
