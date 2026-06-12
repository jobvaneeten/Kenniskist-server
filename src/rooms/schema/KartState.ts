import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class KartPlayer extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;
  @type("float32") vel: number = 0;      // huidige snelheid (voor wiel-spin op remotes)
  @type("number")  grid: number = 0;     // startpositie-index (join-volgorde)
  @type("boolean") isBot: boolean = false;
  @type("number")  lap: number = 1;      // huidige ronde
  @type("boolean") finished: boolean = false;
  @type("number")  place: number = 0;    // eindklassering (0 = nog niet binnen)
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = ""; // JSON: { broek, sokken, schoenen }
  @type("string")  name: string = "Speler";
  // ── Item-systeem (Mario-Kart-style) ──
  @type("string")  item: string = "";    // vastgehouden item: "" | boost | star | banana | shell
  @type("float32") boost: number = 0;    // seconden boost-resterend
  @type("float32") star: number = 0;     // seconden ster-resterend (onkwetsbaar + sneller)
  @type("float32") spin: number = 0;     // seconden tol/afremmen-resterend (geraakt)
}

// Item-box op de baan (vaste posities; active=false tijdens respawn)
export class ItemBox extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("boolean") active: boolean = true;
}

// Achtergelaten banaan
export class Hazard extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
}

// Vooruit-geschoten schild (projectiel langs de baan)
export class Shell extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
}

export class KartRoomState extends Schema {
  @type({ map: KartPlayer }) players = new MapSchema<KartPlayer>();
  @type("string")  phase: string = "lobby";   // lobby | countdown | racing | finished
  @type("number")  countdown: number = 0;
  @type("number")  laps: number = 3;           // aantal ronden
  @type("string")  track: string = "groen";    // gekozen baan
  @type("number")  finishedCount: number = 0;  // hoeveel karts binnen zijn
  // ── Item-systeem ──
  @type([ItemBox])      boxes   = new ArraySchema<ItemBox>();
  @type({ map: Hazard }) hazards = new MapSchema<Hazard>();
  @type({ map: Shell })  shells  = new MapSchema<Shell>();
}
