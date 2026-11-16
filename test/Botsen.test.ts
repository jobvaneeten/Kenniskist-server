import assert from "assert";
import { testServer, wacht, tot, luisterStil } from "./hulp.js";

describe("BotsenRoom (ballonnengevecht)", () => {
  let colyseus: Awaited<ReturnType<typeof testServer>>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("item pakken, schieten, ballon knapt, laatste wint", async () => {
    const room = await colyseus.createRoom<any>("botsen", { joinCode: "5555" });
    const a = await colyseus.connectTo(room, { name: "Sanne", color: "#e63946" });
    const b = await colyseus.connectTo(room, { name: "Bram", color: "geen-kleur" });
    luisterStil(a, "bombBoom"); luisterStil(b, "bombBoom");
    await room.waitForNextPatch();
    const pa = room.state.players.get(a.sessionId), pb = room.state.players.get(b.sessionId);
    assert.strictEqual(pa.color, "#e63946");
    assert.ok(pb.color.startsWith("#"), "onbekende kleur wordt een geldige");
    assert.strictEqual(room.state.boxes.length, 4);

    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");

    // A rijdt op de itembox van het eerste platform
    const box = room.state.boxes[0];
    a.send("state", { x: box.x, z: box.z, rotY: 0, vel: 0 });
    await tot(() => !!pa.item, 2000, "item gepakt");
    assert.strictEqual(pa.itemCount, 3);
    assert.strictEqual(box.active, false);

    // Tot drie keer toe: B recht voor A zetten en raken (bom ontploft om je heen)
    for (let ronde = 0; ronde < 3; ronde++) {
      await tot(() => pb.stunTime === 0, 3000, "B klaar met tollen");
      const voor = pb.balloons;
      (room as any)._cooldowns.clear();
      pa.item = "schild"; pa.itemCount = 3;                    // vast item, zodat de test niet van het toeval afhangt
      a.send("state", { x: 40, z: 40, rotY: 0, vel: 0 });      // open grond, kijkrichting +z
      b.send("state", { x: 40, z: 47, rotY: 0, vel: 0 });
      await tot(() => pa.x === 40 && pb.z === 47, 2000, "posities");
      a.send("useItem");
      await tot(() => pb.balloons === voor - 1, 3000, `ballon ${ronde + 1} knapt`);
    }
    assert.strictEqual(pb.alive, false);
    await tot(() => room.state.phase === "gameover", 2000, "afgelopen");
    assert.strictEqual(room.state.winnerName, "Sanne");
  }).timeout(30000);

  it("bots rijden rond en blijven binnen de arena", async () => {
    const room = await colyseus.createRoom<any>("botsen", { joinCode: "6666" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    luisterStil(a, "bombBoom");
    a.send("addBot"); a.send("addBot"); a.send("addBot");
    await tot(() => room.state.players.size === 4, 2000, "drie bots");
    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");
    const start = [...room.state.players.values()].filter((p: any) => p.isBot).map((p: any) => ({ x: p.x, z: p.z }));
    await wacht(2500);
    const bots = [...room.state.players.values()].filter((p: any) => p.isBot) as any[];
    bots.forEach((p, i) => {
      assert.ok(Math.hypot(p.x - start[i].x, p.z - start[i].z) > 3, "bot is gaan rijden");
      assert.ok(Math.abs(p.x) <= 58 && Math.abs(p.z) <= 58, "bot binnen de arena");
    });
  }).timeout(20000);
});
