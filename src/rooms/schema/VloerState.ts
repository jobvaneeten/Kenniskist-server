import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

// Vloerquiz: de leerkracht (host) zet vragen klaar, de kinderen rennen met hun
// poppetje naar het vlak met het goede antwoord.

export class VloerSpeler extends Schema {
  @type("float32") x: number = 0;
  @type("float32") z: number = 0;
  @type("float32") rotY: number = 0;
  @type("boolean") loopt: boolean = false;
  @type("string")  name: string = "Speler";
  @type("string")  shirt: string = "";
  @type("string")  wearing: string = "";   // JSON, zoals in de Kledingkast
  @type("boolean") isBot: boolean = false;
  @type("number")  score: number = 0;
  @type("number")  laatste: number = 0;    // punten bij de laatste vraag
  @type("number")  goed: number = -1;      // laatste vraag: -1 niets gekozen, 0 fout, 1 goed
  @type("number")  reeks: number = 0;      // zoveel keer achter elkaar goed
  @type("number")  plekSeq: number = 0;    // de server zette de speler ergens neer
  @type("number")  valSeq: number = 0;     // valt van een fout vlak af
  @type("string")  emote: string = "";     // laatste emote (dansje)
  @type("number")  emoteSeq: number = 0;   // telt op bij elke emote
}

export class VloerState extends Schema {
  @type({ map: VloerSpeler }) players = new MapSchema<VloerSpeler>();
  @type("string")  phase: string = "lobby";   // lobby | aftellen | vraag | uitslag | einde
  @type("number")  countdown: number = 0;
  @type("number")  nr: number = 0;            // 1 = eerste vraag
  @type("number")  aantal: number = 0;        // zoveel vragen in dit potje
  @type("string")  vraag: string = "";
  @type(["string"]) opties = new ArraySchema<string>();
  @type("number")  goed: number = -1;         // pas bij de uitslag bekend
  @type("number")  tijd: number = 20;         // seconden per vraag
  @type("float32") timeLeft: number = 0;
  @type("boolean") hostWeg: boolean = false;  // leerkracht even uit beeld (wifi)
  @type("boolean") pauze: boolean = false;    // na de uitslag niet vanzelf door
}
