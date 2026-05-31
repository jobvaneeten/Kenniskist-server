import { Room, Client, CloseCode } from "colyseus";
import { RocketRoomState, PlayerState, BallState } from "./schema/RocketState.js";

// ── Field constants (match FootballScene3D) ───────────────────
const FIELD_HALF   = 38;
const GOAL_Z       = 36;
const GOAL_HALF_W  = 3.65;
const BALL_RADIUS  = 0.22;
const PLAYER_RADIUS = 0.6;
const PLAYER_SPEED  = 7;
const BOOST_SPEED   = 13;
const TICK_RATE     = 20;       // Hz
const GAME_DURATION = 180;      // seconds

export class RocketRoom extends Room {
  maxClients = 6;
  state = new RocketRoomState();

  private _interval: ReturnType<typeof setInterval> | null = null;
  private _lastTick = Date.now();
  private _inputs: Map<string, { x: number; z: number; boost: boolean }> = new Map();

  onCreate(options: any) {

    // Handle player input
    this.onMessage("input", (client, msg: { x: number; z: number; boost: boolean }) => {
      this._inputs.set(client.sessionId, { x: msg.x ?? 0, z: msg.z ?? 0, boost: !!msg.boost });
    });

    // Start countdown when first player joins and host says ready
    this.onMessage("start", (client) => {
      if (this.state.phase === "lobby") this._beginCountdown();
    });

    console.log("RocketRoom created:", this.roomId);
  }

  onJoin(client: Client, options: { shirt?: string; name?: string } = {}) {
    const p = new PlayerState();
    const team = this.state.players.size % 2;   // alternate teams
    p.team  = team;
    p.shirt = options.shirt ?? "";
    p.name  = options.name  ?? "Speler";
    // Spawn on opposite sides
    p.x = 0;
    p.z = team === 0 ? 10 : -10;
    p.rotY = team === 0 ? 0 : Math.PI;
    this.state.players.set(client.sessionId, p);
    this._inputs.set(client.sessionId, { x: 0, z: 0, boost: false });
    console.log(client.sessionId, "joined team", team);
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this._inputs.delete(client.sessionId);
    console.log(client.sessionId, "left");
  }

  onDispose() {
    if (this._interval) clearInterval(this._interval);
    console.log("RocketRoom disposed:", this.roomId);
  }

  // ── Countdown → playing ──────────────────────────────────────
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

  // ── Main physics tick ────────────────────────────────────────
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

    // Move players
    this.state.players.forEach((p: PlayerState, sid: string) => {
      const inp = this._inputs.get(sid) ?? { x: 0, z: 0, boost: false };
      const spd = inp.boost ? BOOST_SPEED : PLAYER_SPEED;
      p.boosting = inp.boost;

      p.vx = inp.x * spd;
      p.vz = inp.z * spd;
      p.x  = clamp(p.x + p.vx * dt, -FIELD_HALF + 1, FIELD_HALF - 1);
      p.z  = clamp(p.z + p.vz * dt, -FIELD_HALF + 1, FIELD_HALF - 1);

      if (Math.abs(inp.x) > 0.05 || Math.abs(inp.z) > 0.05) {
        p.rotY = Math.atan2(inp.x, inp.z);
      }
    });

    // Ball physics
    const ball = this.state.ball;
    ball.vy -= 9.82 * dt;
    ball.x  += ball.vx * dt;
    ball.y  += ball.vy * dt;
    ball.z  += ball.vz * dt;

    // Ground
    if (ball.y <= BALL_RADIUS) {
      ball.y  = BALL_RADIUS;
      ball.vy = Math.abs(ball.vy) > 0.8 ? -ball.vy * 0.55 : 0;
    }

    // Wall bounces
    if (Math.abs(ball.x) > FIELD_HALF - BALL_RADIUS) {
      ball.x  = Math.sign(ball.x) * (FIELD_HALF - BALL_RADIUS);
      ball.vx *= -0.6;
    }
    if (Math.abs(ball.z) > FIELD_HALF - BALL_RADIUS) {
      ball.z  = Math.sign(ball.z) * (FIELD_HALF - BALL_RADIUS);
      ball.vz *= -0.6;
    }

    // Friction
    const f = Math.pow(0.88, dt * 60);
    ball.vx *= f;
    ball.vz *= f;

    // Player ↔ ball collisions
    this.state.players.forEach((p: PlayerState) => {
      const dx = ball.x - p.x;
      const dz = ball.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = PLAYER_RADIUS + BALL_RADIUS;
      if (dist < minDist && dist > 0.001) {
        const nx  = dx / dist;
        const nz  = dz / dist;
        const spd = Math.hypot(p.vx, p.vz);
        const kickSpd = Math.max(spd * 2.2, 3);
        ball.vx = nx * kickSpd;
        ball.vz = nz * kickSpd;
        ball.vy = Math.min(kickSpd * 0.3, 3.5);
        // Push out of overlap
        ball.x = p.x + nx * minDist;
        ball.z = p.z + nz * minDist;
      }
    });

    // Goal detection
    if (Math.abs(ball.x) < GOAL_HALF_W && ball.y < 2.44 + BALL_RADIUS) {
      if (ball.z <= -GOAL_Z) { this._goal("A"); return; }
      if (ball.z >=  GOAL_Z) { this._goal("B"); return; }
    }
  }

  private _goal(team: "A" | "B") {
    this.state.phase = "goal";
    if (team === "A") this.state.scoreA++;
    else              this.state.scoreB++;

    if (this._interval) clearInterval(this._interval);

    setTimeout(() => {
      this._resetPositions();
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

  private _resetPositions() {
    // Reset ball
    const b = this.state.ball;
    b.x = 0; b.y = BALL_RADIUS; b.z = 0;
    b.vx = 0; b.vy = 0; b.vz = 0;

    // Reset players to spawn positions
    let teamA = 0, teamB = 0;
    this.state.players.forEach((p: PlayerState) => {
      if (p.team === 0) { p.x = (teamA++ - 0.5) * 4; p.z =  12; p.rotY = 0; }
      else              { p.x = (teamB++ - 0.5) * 4; p.z = -12; p.rotY = Math.PI; }
      p.vx = 0; p.vz = 0;
    });
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
