import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

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
  // ── Item-systeem (opgepakt uit een box, 3 gebruiken per keer) ──
  @type("string")  item: string = "";     // "" | schild | bom | vuurtje
  @type("number")  itemCount: number = 0; // resterende gebruiken van het huidige item
}

// Item-box op de arena (vaste positie; active=false tijdens respawn)
export class BotsenBox extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("boolean") active: boolean = true;
}

// Schild-projectiel (vooruit vanaf de kart)
export class BotsenShell extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("string")  kind: string = "schild";  // schild | vuurtje (voor de client-visual)
}

// Bom: neergezet, ontploft na een lont-tijd
export class BotsenBomb extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") fuse: number = 0;   // seconden tot ontploffing
}

export class BotsenRoomState extends Schema {
  @type({ map: BotsenPlayer }) players = new MapSchema<BotsenPlayer>();
  @type({ map: BotsenShell })  shells  = new MapSchema<BotsenShell>();
  @type({ map: BotsenBomb })   bombs   = new MapSchema<BotsenBomb>();
  @type([BotsenBox])           boxes   = new ArraySchema<BotsenBox>();
  @type("string")  phase: string = "lobby";   // lobby | countdown | playing | gameover
  @type("number")  countdown: number = 0;
  @type("number")  timeLeft: number = 150;    // seconden voor de klok afloopt
  @type("string")  winnerName: string = "";
}
