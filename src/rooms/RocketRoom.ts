import { Room, Client, CloseCode } from "colyseus";
import { RocketRoomState, PlayerState } from "./schema/RocketState.js";

// Veld, doelen en rand: gedeeld met de site (src/gedeeld/voetbalVeld.js).
import {
  GOAL_Z, BALL_RADIUS, GAME_DURATION, bewegSpeler, bewegBal, balTegenSpeler, klemBal, doelpunt,
} from "../gedeeld/voetbalVeld.js";

const TICK_RATE    = 60;    // Hz — same feel as FootballScene3D

const BOT_NAMES  = ["Luigi", "Peach", "Bowser", "Yoshi", "Toad", "Daisy", "Wario", "Rosalina"];
const BOT_COLORS = ["rood", "blauw", "groen", "geel", "oranje", "paars"];

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

    // Nog een keer: zelfde spelers en code, terug naar de wachtkamer.
    this.onMessage("opnieuw", (_client: Client) => {
      if (this.state.phase !== "gameover") return;
      this.state.scoreA = 0; this.state.scoreB = 0;
      this.state.timeLeft = GAME_DURATION;
      this._reset();
      this.state.phase = "lobby";
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


  // Wifi even weg (school-iPad, tablet in slaapstand): 30 seconden de plek
  // vasthouden. De SDK in de site probeert zelf opnieuw te verbinden.
  onDrop(client: Client) {
    this.allowReconnection(client, 30);
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

    // ── Spelers, bal, trappen, doelpunt (regels: src/gedeeld/voetbalVeld.js) ──
    this.state.players.forEach((p: PlayerState, sid: string) => {
      this._prevPos.set(sid, { x: p.x, z: p.z });   // positie aan het begin van de tik
      bewegSpeler(p, this._inputs.get(sid) ?? { x: 0, z: 0, boost: false, pass: false }, dt);
    });
    const ball = this.state.ball;
    const balVoor = { x: ball.x, z: ball.z };
    bewegBal(ball, dt);
    this.state.players.forEach((p: PlayerState, sid: string) => {
      balTegenSpeler(ball, balVoor, p, this._prevPos.get(sid) ?? { x: p.x, z: p.z }, !!this._inputs.get(sid)?.pass);
    });
    klemBal(ball);
    const team = doelpunt(ball, balVoor.z);
    if (team) this._goal(team);
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

