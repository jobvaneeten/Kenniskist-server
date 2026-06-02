import { Schema, MapSchema, type } from "@colyseus/schema";

export class PBPlayer extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;       // facing / aim yaw
  @type("number")  team: number = 0;        // 0 = rood, 1 = blauw
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = "";    // JSON: { broek, sokken, schoenen }
  @type("string")  name: string = "Speler";
  @type("number")  hp: number = 100;
  @type("number")  score: number = 0;       // eliminaties
  @type("boolean") alive: boolean = true;
  @type("boolean") moving: boolean = false;
  @type("number")  shootSeq: number = 0;    // bumps elke keer dat de speler schiet
  @type("number")  hitSeq: number = 0;      // bumps elke keer dat de speler geraakt wordt
  @type("number")  respawnIn: number = 0;   // seconden tot respawn (0 = leeft)
}

export class PBShot extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
  @type("float32") vx: number = 0;
  @type("float32") vy: number = 0;
  @type("float32") vz: number = 0;
  @type("number")  team: number = 0;        // kleur van de verf
}

export class PaintballState extends Schema {
  @type({ map: PBPlayer }) players = new MapSchema<PBPlayer>();
  @type({ map: PBShot })   shots   = new MapSchema<PBShot>();
  @type("number")  scoreA: number = 0;       // team rood
  @type("number")  scoreB: number = 0;       // team blauw
  @type("string")  phase: string = "lobby";  // lobby | countdown | playing | gameover
  @type("number")  countdown: number = 0;
  @type("number")  timeLeft: number = 120;
}
