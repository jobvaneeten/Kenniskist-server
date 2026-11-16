import assert from "assert";
import { testServer, wacht, tot } from "./hulp.js";

describe("RocketRoom (voetbal)", () => {
  let colyseus: Awaited<ReturnType<typeof testServer>>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("teams om en om, aftellen, lopen, bal wegschieten en binnen het veld blijven", async () => {
    const room = await colyseus.createRoom<any>("rocket", { joinCode: "11111" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    const b = await colyseus.connectTo(room, { name: "Bram" });
    await room.waitForNextPatch();
    const pa = room.state.players.get(a.sessionId), pb = room.state.players.get(b.sessionId);
    assert.strictEqual(pa.team, 0);
    assert.strictEqual(pb.team, 1);
    assert.strictEqual(pa.name, "Sanne");

    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");
    assert.strictEqual(Math.round(room.state.timeLeft), 120);

    // A staat op z=10 en rent naar de bal op het midden (-z)
    a.send("input", { x: 0, z: -1, boost: true, pass: false });
    await tot(() => Math.hypot(room.state.ball.vx, room.state.ball.vz) > 5, 5000, "bal geraakt");
    assert.ok(room.state.ball.vz < 0, "bal gaat van A af");

    // tegen de zijkant aan blijven duwen: nooit buiten de muur (36 − straal 0,6)
    b.send("input", { x: 1, z: 0, boost: true, pass: false });
    await wacht(1500);
    assert.ok(pb.x <= 35.41 && pb.x > 5, `B binnen het veld, x=${pb.x}`);
    assert.ok(Math.abs(room.state.ball.x) <= 36 && Math.abs(room.state.ball.z) <= 37.6);
  }).timeout(20000);

  it("bots erbij en eraf alleen in de wachtkamer", async () => {
    const room = await colyseus.createRoom<any>("rocket", { joinCode: "22222" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    a.send("addBot", "makkelijk"); a.send("addBot", "moeilijk");
    await tot(() => room.state.players.size === 3, 2000, "twee bots");
    a.send("removeBot");
    await tot(() => room.state.players.size === 2, 2000, "bot eraf");
    const bot = [...room.state.players.values()].find((p: any) => p.isBot) as any;
    assert.ok(bot.name.includes("makkelijk"));
  });
});
