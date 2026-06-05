import { Room, Client, CloseCode } from "colyseus";
import { KartRoomState, KartPlayer } from "./schema/KartState.js";

// Client-authoritative kart-race: elke client simuleert zijn eigen kart
// (inclusief botsingen met andere karts) en stuurt zijn positie; de server
// relayt alleen + beheert de race-fasen. Zelfde patroon als RocketRoom.
export class KartRoom extends Room {
  maxClients = 8;
  state = new KartRoomState();

  onCreate(options: any) {
    this.setPatchRate(33);   // ~30x/sec broadcast — client interpoleert
    this.state.laps = Math.max(1, Math.min(5, Number(options?.laps) || 3));
    if (typeof options?.track === "string") this.state.track = options.track;

    // Positie-update vanaf de client (zijn eigen kart)
    this.onMessage("state", (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x    = msg.x ?? p.x;
      p.z    = msg.z ?? p.z;
      p.rotY = msg.rotY ?? p.rotY;
      p.vel  = msg.vel ?? 0;
      if (typeof msg.lap === "number") p.lap = msg.lap;
    });

    // Iemand start de race vanuit de lobby
    this.onMessage("start", (_client: Client) => {
      if (this.state.phase === "lobby") this._beginCountdown();
    });

    // Een kart is over de finish
    this.onMessage("finished", (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.finished) return;
      p.finished = true;
      this.state.finishedCount++;
      p.place = this.state.finishedCount;
      // Alle deelnemers binnen → race afgelopen
      if (this.state.finishedCount >= this.state.players.size) {
        this.state.phase = "finished";
      }
    });
  }

  onJoin(client: Client, options: { shirt?: string; wearing?: string; name?: string } = {}) {
    const p = new KartPlayer();
    p.grid    = this.state.players.size;   // join-volgorde = startvak
    p.shirt   = options.shirt   ?? "";
    p.wearing = options.wearing ?? "";
    p.name    = options.name    ?? "Speler";
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
  }

  private _beginCountdown() {
    this.state.phase = "countdown";
    this.state.countdown = 3;
    const tick = setInterval(() => {
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        clearInterval(tick);
        this.state.phase = "racing";
      }
    }, 1000);
  }
}
