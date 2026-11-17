import assert from "assert";
import { testServer, wacht, tot } from "./hulp.js";
import { maakVragen } from "../src/rooms/VloerRoom.js";
import { vakVan, vakMidden, punten } from "../src/gedeeld/vloerArena.js";

const VRAGEN = [
  { vraag: "Wat is 7 x 8?", goed: "56", fout: ["54", "48", "63"] },
  { vraag: "Hoofdstad van Frankrijk?", goed: "Parijs", fout: ["Lyon"] },
];

describe("VloerRoom (vloerquiz)", () => {
  let colyseus: Awaited<ReturnType<typeof testServer>>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("vragen controleren: dubbele en lege keuzes weg, zonder foute keuze geen vraag", () => {
    const v = maakVragen([
      { vraag: "a", goed: "1", fout: ["1", "2", "2", "", "3", "4", "5"] },
      { vraag: "b", goed: "x", fout: [] },
      { vraag: "", goed: "y", fout: ["z"] },
    ]);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].opties.length, 4);
    assert.strictEqual(v[0].opties[v[0].goed], "1");
    assert.deepStrictEqual([...v[0].opties].sort(), ["1", "2", "3", "4"]);
  });

  it("vlakken en punten", () => {
    assert.strictEqual(vakVan(0, 0), -1);
    assert.strictEqual(vakVan(-6, 6), 0);
    assert.strictEqual(vakVan(6, 6), 1);
    assert.strictEqual(vakVan(-6, -6), 2);
    assert.strictEqual(vakVan(6, -6), 3);
    assert.strictEqual(vakVan(6, -6, 3), -1);
    assert.strictEqual(vakVan(-6, 6, 2), 0);
    for (let i = 0; i < 4; i++) { const m = vakMidden(i); assert.strictEqual(vakVan(m.x, m.z), i); }
    assert.strictEqual(punten(0, 20), 1000);
    assert.strictEqual(punten(20, 20), 500);
  });

  it("leerkracht start, kind loopt naar het goede vlak, fout vlak valt, eindstand", async () => {
    const room = await colyseus.createRoom<any>("vloer", { joinCode: "8001", host: true, vragen: VRAGEN, tijd: 10 });
    const juf = await colyseus.connectTo(room, { host: true });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    const b = await colyseus.connectTo(room, { name: "Bram" });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.size, 2, "de leerkracht staat niet op de vloer");
    assert.strictEqual(room.state.aantal, 2);

    a.send("start");   // een kind mag niet starten
    await wacht(150);
    assert.strictEqual(room.state.phase, "lobby");

    juf.send("start");
    await tot(() => room.state.phase === "vraag", 5000, "eerste vraag");
    assert.strictEqual(room.state.opties.length, 4);
    assert.strictEqual(room.state.goed, -1, "het goede antwoord is nog geheim");
    const goed = room.state.opties.indexOf("56");
    const fout = (goed + 1) % 4;

    // in stapjes naar een vlak lopen (de server remt sprongen af)
    const loop = async (c: any, vak: number) => {
      const p = room.state.players.get(c.sessionId);
      const doel = vakMidden(vak);
      for (let i = 1; i <= 8; i++) {
        c.send("plek", { x: p.x + (doel.x - p.x) * i / 8, z: p.z + (doel.z - p.z) * i / 8, r: 0, l: true, s: p.plekSeq });
        await wacht(120);
      }
    };
    await Promise.all([loop(a, goed), loop(b, fout)]);
    const pa = room.state.players.get(a.sessionId), pb = room.state.players.get(b.sessionId);
    assert.strictEqual(vakVan(pa.x, pa.z), goed, "Sanne staat op het goede vlak");

    juf.send("klaar");
    await tot(() => room.state.phase === "uitslag", 2000, "uitslag");
    assert.strictEqual(room.state.goed, goed);
    assert.strictEqual(pa.goed, 1);
    assert.ok(pa.laatste > 800 && pa.laatste <= 1000, `snel goed: ${pa.laatste}`);
    assert.strictEqual(pb.goed, 0);
    assert.strictEqual(pb.valSeq, 1, "Bram valt");
    assert.strictEqual(pb.score, 0);

    // tijdens het vallen telt een plek niet
    b.send("plek", { x: 0, z: 0, s: pb.plekSeq });
    await tot(() => Math.hypot(pb.x, pb.z) < 3.2, 4000, "Bram weer op het startvlak");

    juf.send("volgende");
    await tot(() => room.state.phase === "vraag" && room.state.nr === 2, 2000, "tweede vraag");
    assert.strictEqual(room.state.opties.length, 2);
    assert.ok(Math.hypot(pa.x, pa.z) < 3.2, "iedereen begint weer in het midden");

    await tot(() => room.state.phase === "uitslag", 12000, "tijd is om");
    assert.strictEqual(pa.goed, -1, "op het startvlak blijven = niets gekozen");
    juf.send("volgende");
    await tot(() => room.state.phase === "einde", 2000, "einde");
    assert.ok(Math.hypot(pa.x, pa.z - 0.6) < 0.01, "de winnaar staat bovenaan het podium");

    juf.send("opnieuw");
    await tot(() => room.state.phase === "lobby", 2000, "weer in de wachtkamer");
    assert.strictEqual(pa.score, 0);
  }).timeout(30000);

  it("te grote sprong wordt afgeremd en het kind krijgt de plek van de server", async () => {
    const room = await colyseus.createRoom<any>("vloer", { joinCode: "8002", host: true, vragen: VRAGEN });
    await colyseus.connectTo(room, { host: true });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    await room.waitForNextPatch();
    const p = room.state.players.get(a.sessionId);
    await wacht(1100);
    const seq = p.plekSeq;
    a.send("plek", { x: 12, z: 12, s: seq });
    a.send("plek", { x: -12, z: -12, s: seq });
    await wacht(150);
    assert.strictEqual(p.plekSeq, seq + 1);
    assert.ok(Math.hypot(p.x - 12, p.z - 12) > 1 && p.x > 0, "niet in één keer naar de hoek, en de tweede (oude) plek telt niet");
    a.send("plek", { x: 99, z: 99, s: p.plekSeq });   // buiten de vloer
    await wacht(150);
    assert.ok(p.x <= 12.4 && p.z <= 12.4);
  });

  it("bots kiezen een vlak, alleen de leerkracht zet ze erbij", async () => {
    const room = await colyseus.createRoom<any>("vloer", { joinCode: "8003", host: true, vragen: VRAGEN, tijd: 10 });
    const juf = await colyseus.connectTo(room, { host: true });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    a.send("addBot", "normaal");
    await wacht(150);
    assert.strictEqual(room.state.players.size, 1);
    juf.send("addBot", "moeilijk"); juf.send("addBot", "makkelijk");
    await tot(() => room.state.players.size === 3, 2000, "twee bots");
    juf.send("removeBot");
    await tot(() => room.state.players.size === 2, 2000, "bot eraf");
    juf.send("start");
    await tot(() => room.state.phase === "vraag", 5000, "vraag");
    const bot = [...room.state.players.values()].find((p: any) => p.isBot) as any;
    await tot(() => vakVan(bot.x, bot.z) >= 0, 9000, "bot staat op een vlak");
  }).timeout(20000);

  it("de leerkracht weg: het potje stopt", async () => {
    const room = await colyseus.createRoom<any>("vloer", { joinCode: "8004", host: true, vragen: VRAGEN });
    const juf = await colyseus.connectTo(room, { host: true });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    let gestopt = false, weg = false;
    a.onMessage("gestopt", () => { gestopt = true; });
    a.onLeave(() => { weg = true; });
    await juf.leave();
    await tot(() => gestopt, 2000, "bericht dat de quiz stopt");
    await tot(() => weg, 5000, "kind eruit (de server ruimt op)");
  });
});
