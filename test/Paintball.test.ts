import assert from "assert";
import { testServer, wacht, tot, luisterStil } from "./hulp.js";

describe("PaintballRoom", () => {
  let colyseus: Awaited<ReturnType<typeof testServer>>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("positie doorgeven binnen de kaart, schieten, raak = punt, herladen", async () => {
    const room = await colyseus.createRoom<any>("paintball", { joinCode: "3333", map: "stad" });
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    const b = await colyseus.connectTo(room, { name: "Bram" });
    luisterStil(a, "splat"); luisterStil(b, "splat");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.map, "stad");
    const pa = room.state.players.get(a.sessionId), pb = room.state.players.get(b.sessionId);
    assert.notStrictEqual(pa.team, pb.team);

    a.send("start");
    await tot(() => room.state.phase === "playing", 5000, "spelen");

    // buiten de kaart (stad: 25 × 50) wordt teruggezet op de rand
    a.send("state", { x: 999, y: 0, z: -999, rotY: 1, moving: true });
    await tot(() => pa.x === 25 && pa.z === -50, 2000, "begrensd");

    // A en B tegenover elkaar, A schiet recht op B
    a.send("state", { x: 0, y: 0, z: 0, rotY: 0, moving: false });
    b.send("state", { x: 0, y: 0, z: 8, rotY: 3.14, moving: false });
    await tot(() => pa.z === 0 && pb.z === 8, 2000, "posities");
    a.send("shoot", { dx: 0, dy: 0, dz: 1, range: 60 });
    await tot(() => !pb.alive, 3000, "B geraakt");
    assert.strictEqual(pa.score, 1);
    assert.strictEqual(room.state.scoreA + room.state.scoreB, 1);
    assert.strictEqual(pa.ammo, 9);

    // twee schoten vlak na elkaar: alleen het eerste telt (cooldown); herladen vult bij
    await wacht(350);   // de cooldown van het eerste schot voorbij
    a.send("shoot", { dx: 0, dy: 0, dz: 1, range: 60 });
    a.send("shoot", { dx: 0, dy: 0, dz: 1, range: 60 });
    await wacht(150);
    assert.strictEqual(pa.ammo, 8, "9 na het eerste schot, daarna telt er nog maar één");
    a.send("reload");
    await tot(() => pa.reloading, 1000, "herladen begint");
    await tot(() => !pa.reloading && pa.ammo === 10, 3000, "herladen klaar");
  }).timeout(20000);

  it("neemt de obstakels van de kaart van de eerste speler over, één keer", async () => {
    const room = await colyseus.createRoom<any>("paintball", { joinCode: "4444" }) as any;
    const a = await colyseus.connectTo(room, { name: "Sanne" });
    a.send("mapObstacles", [1, 2, 3, 4, 5, 10, 20, 0, 4, 5]);     // tweede box heeft hw 0: overslaan
    a.send("mapObstacles", [9, 9, 9, 9, 9]);
    await wacht(150);
    assert.deepStrictEqual(room._obstacles, [{ x: 1, z: 2, hw: 3, hd: 4, top: 5 }]);
  });
});
