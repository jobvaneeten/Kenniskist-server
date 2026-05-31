import { Room, Client, CloseCode } from "colyseus";
import { RocketRoomState, PlayerState } from "./schema/RocketState.js";

// ── Exact same constants as FootballScene3D ─────────────────────
const FIELD_HALF   = 38;
const GOAL_Z       = 36;
const GOAL_HALF_W  = 3.65;
const GOAL_H       = 2.44;
const BALL_RADIUS  = 0.22;
const KICK_DIST    = 1.1;
const PLAYER_SPEED = 4.8;
const BOOST_SPEED  = 9.0;
const TICK_RATE    = 60;    // Hz — same feel as FootballScene3D
const GAME_DURATION = 120;  // seconds

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

  onJoin(client: Client, options: { shirt?: string; name?: string } = {}) {
    const p = new PlayerState();
    const team = this.state.players.size % 2;
    p.team  = team;
    p.shirt = options.shirt ?? "";
    p.name  = options.name  ?? "Speler";
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
      const spd = inp.boost ? BOOST_SPEED : PLAYER_SPEED;
      p.boosting = inp.boost;

      const vx = inp.x * spd;
      const vz = inp.z * spd;

      p.x = clamp(p.x + vx * dt, -FIELD_HALF + 1, FIELD_HALF - 1);
      p.z = clamp(p.z + vz * dt, -FIELD_HALF + 1, FIELD_HALF - 1);
      p.y = 0;

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

    // Gravity
    if (ball.y > BALL_RADIUS) ball.vy -= 9.82 * dt;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;

    // Ground bounce
    if (ball.y <= BALL_RADIUS) {
      ball.y = BALL_RADIUS;
      if (Math.abs(ball.vy) > 0.6) {
        ball.vy = -ball.vy * 0.48;
      } else {
        ball.vy = 0;
      }
    }

    // Friction — same formula as FootballScene3D
    const onGround = ball.y <= BALL_RADIUS + 0.01;
    const f = onGround
      ? Math.pow(0.91, dt * 60)
      : Math.pow(0.999, dt * 60);
    ball.vx *= f;
    ball.vz *= f;

    // Wall bounces (X)
    const fx = FIELD_HALF - BALL_RADIUS;
    if (Math.abs(ball.x) > fx) {
      ball.x  = Math.sign(ball.x) * fx;
      ball.vx *= -0.5;
    }
    // Wall bounces (Z — non-goal ends)
    const fz = FIELD_HALF - BALL_RADIUS;
    if (Math.abs(ball.z) > fz) {
      ball.z  = Math.sign(ball.z) * fz;
      ball.vz *= -0.5;
    }

    // ── Ball ↔ player collision (exact copy from FootballScene3D) ──────
    this.state.players.forEach((p: PlayerState) => {
      const dx = ball.x - p.x;
      const dz = ball.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < KICK_DIST * KICK_DIST && d2 > 0.001) {
        const spd = Math.abs(Math.hypot(p.vx, p.vz));
        const d   = Math.sqrt(d2);
        const fwdX = Math.sin(p.rotY);
        const fwdZ = Math.cos(p.rotY);
        const toBX = dx / d;
        const toBZ = dz / d;
        if (spd > 0.3) {
          // Lerp between forward and toBall (0.35) — same as FootballScene3D
          const kickX = lerp(fwdX, toBX, 0.35);
          const kickZ = lerp(fwdZ, toBZ, 0.35);
          const len   = Math.hypot(kickX, kickZ) || 1;
          const force = spd * 2.5 + 1;
          ball.vx = (kickX / len) * force;
          ball.vz = (kickZ / len) * force;
          ball.vy = Math.min(force * 0.22, 2.8);
        } else {
          ball.vx = toBX * 0.8;
          ball.vz = toBZ * 0.8;
        }
        // Push out of overlap
        ball.x = p.x + toBX * (KICK_DIST + 0.01);
        ball.z = p.z + toBZ * (KICK_DIST + 0.01);
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
