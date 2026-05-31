import { Schema, MapSchema, type } from "@colyseus/schema";

export class Vec3 extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
}

export class PlayerState extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;
  @type("float32") vx: number = 0;
  @type("float32") vz: number = 0;
  @type("number")  team: number = 0;   // 0 = A, 1 = B
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = "";   // JSON: { broek, sokken, schoenen }
  @type("string")  name: string = "Speler";
  @type("boolean") boosting: boolean = false;
  @type("float32") stamina: number = 1;   // 1 = full (= 2s sprint)
  @type("string")  emote: string = "";    // current emote name
  @type("number")  emoteSeq: number = 0;  // bumps each time an emote is triggered
}

export class BallState extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0.22;
  @type("float32") z: number = 0;
  @type("float32") vx: number = 0;
  @type("float32") vy: number = 0;
  @type("float32") vz: number = 0;
}

export class RocketRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type(BallState)  ball    = new BallState();
  @type("number")   scoreA: number = 0;
  @type("number")   scoreB: number = 0;
  @type("string")   phase: string = "lobby";   // lobby | countdown | playing | goal | gameover
  @type("number")   countdown: number = 0;
  @type("number")   timeLeft: number = 180;
}
