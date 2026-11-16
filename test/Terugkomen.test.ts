import assert from "assert";
import { testServer, wacht, tot, luisterStil } from "./hulp.js";

// Voor alle drie de spellen: terugkomen na wegvallen en "nog een keer".
const SPELLEN = [
  { naam: "rocket", code: "70001" },
  { naam: "paintball", code: "7002" },
  { naam: "botsen", code: "7003" },
];

describe("Terugkomen en nog een keer", () => {
  let colyseus: Awaited<ReturnType<typeof testServer>>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  for (const spel of SPELLEN) {
    it(`${spel.naam}: na wegvallen houdt de server je plek 30 seconden vast`, async () => {
      const room = await colyseus.createRoom<any>(spel.naam, { joinCode: spel.code });
      const a = await colyseus.connectTo(room, { name: "Sanne" });
      luisterStil(a, "splat", "bombBoom");
      await room.waitForNextPatch();
      const sid = a.sessionId;
      assert.ok(room.state.players.get(sid));
      let terugGemeld = false;
      a.onReconnect(() => { terugGemeld = true; });
      (a as any).reconnection.minUptime = 0;   // normaal pas na 5 s: in de test meteen

      // verbinding valt weg zonder afmelden (4010 = mag opnieuw verbinden)
      room.clients.find((c: any) => c.sessionId === sid)!.leave(4010);
      await wacht(30);
      assert.ok(room.state.players.get(sid), "plek blijft bestaan");

      // de SDK verbindt zelf opnieuw, met dezelfde sessie
      await tot(() => terugGemeld && room.clients.length === 1, 5000, "weer verbonden");
      assert.strictEqual(room.clients[0].sessionId, sid);
      assert.strictEqual(room.state.players.size, 1);
      const terug = a;

      // bewust weggaan: plek meteen weg
      await terug.leave();
      await tot(() => !room.state.players.get(sid), 2000, "plek weg na afmelden");
    }).timeout(15000);
  }

  it("voetbal: na afloop 'opnieuw' terug naar de wachtkamer met 0-0", async () => {
    const room = await colyseus.createRoom<any>("rocket", { joinCode: "70004" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");
    room.state.scoreA = 2; room.state.timeLeft = 0.05;
    await tot(() => room.state.phase === "gameover", 2000, "afgelopen");
    a.send("opnieuw");
    await tot(() => room.state.phase === "lobby", 2000, "wachtkamer");
    assert.strictEqual(room.state.scoreA, 0);
    assert.strictEqual(Math.round(room.state.timeLeft), 120);
    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "weer spelen");
  }).timeout(20000);

  it("ballonnengevecht: na afloop 'opnieuw' iedereen weer 3 ballonnen", async () => {
    const room = await colyseus.createRoom<any>("botsen", { joinCode: "7005" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    luisterStil(a, "bombBoom");
    a.send("addBot");
    await tot(() => room.state.players.size === 2, 2000, "bot");
    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");
    const pa = room.state.players.get(a.sessionId);
    pa.balloons = 1;
    room.state.timeLeft = 0.05;
    await tot(() => room.state.phase === "gameover", 2000, "afgelopen");
    a.send("opnieuw");
    await tot(() => room.state.phase === "lobby", 2000, "wachtkamer");
    room.state.players.forEach((p: any) => { assert.strictEqual(p.balloons, 3); assert.ok(p.alive); });
    assert.strictEqual(room.state.winnerName, "");
    assert.ok(room.state.boxes.every((b: any) => b.active));
  }).timeout(20000);

  it("paintball: 'opnieuw' telt alleen na afloop", async () => {
    const room = await colyseus.createRoom<any>("paintball", { joinCode: "7006" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    luisterStil(a, "splat");
    a.send("opnieuw");
    await wacht(150);
    assert.strictEqual(room.state.phase, "lobby");
    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");
    a.send("opnieuw");
    await wacht(150);
    assert.strictEqual(room.state.phase, "playing", "midden in het spel kan niemand het potje resetten");
  }).timeout(20000);
});
