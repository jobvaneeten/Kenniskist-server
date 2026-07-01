import { Schema, MapSchema, type } from "@colyseus/schema";

export class BotsenPlayer extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;
  @type("float32") vel: number = 0;       // huidige snelheid (wiel-spin op remotes)
  @type("number")  grid: number = 0;      // spawn-index (join-volgorde) → kart-kleur
  @type("boolean") isBot: boolean = false;
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = ""; // JSON: { broek, sokken, schoenen }
  @type("string")  name: string = "Speler";
  @type("number")  balloons: number = 3;  // 3 → 0, bij 0 uitgeschakeld
  @type("boolean") alive: boolean = true;
  @type("number")  hitSeq: number = 0;    // bumpt elke keer dat een ballon knapt
  @type("number")  place: number = 0;     // eliminatie-volgorde (voor rangschikking), 0 = nog actief/winnaar
}

// Schild-projectiel (vooruit vanaf de kart, zelfde look als Karten)
export class BotsenShell extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
}

export class BotsenRoomState extends Schema {
  @type({ map: BotsenPlayer }) players = new MapSchema<BotsenPlayer>();
  @type({ map: BotsenShell })  shells  = new MapSchema<BotsenShell>();
  @type("string")  phase: string = "lobby";   // lobby | countdown | playing | gameover
  @type("number")  countdown: number = 0;
  @type("number")  timeLeft: number = 150;    // seconden voor de klok afloopt
  @type("string")  winnerName: string = "";
}
