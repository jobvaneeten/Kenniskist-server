import { Schema, MapSchema, type } from "@colyseus/schema";

export class KartPlayer extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;
  @type("float32") vel: number = 0;      // huidige snelheid (voor wiel-spin op remotes)
  @type("number")  grid: number = 0;     // startpositie-index (join-volgorde)
  @type("number")  lap: number = 1;      // huidige ronde
  @type("boolean") finished: boolean = false;
  @type("number")  place: number = 0;    // eindklassering (0 = nog niet binnen)
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = ""; // JSON: { broek, sokken, schoenen }
  @type("string")  name: string = "Speler";
}

export class KartRoomState extends Schema {
  @type({ map: KartPlayer }) players = new MapSchema<KartPlayer>();
  @type("string")  phase: string = "lobby";   // lobby | countdown | racing | finished
  @type("number")  countdown: number = 0;
  @type("number")  laps: number = 3;           // aantal ronden
  @type("number")  finishedCount: number = 0;  // hoeveel karts binnen zijn
}
