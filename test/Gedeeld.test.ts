import assert from "assert";
import fs from "fs";
import path from "path";
import { heightAt, clampHeightStep, collideBoxes, BOXES_GROND, BOXES_BOVEN, PLAT_H, DEK_Y, QUADRANTS, rampFoot } from "../src/gedeeld/botsenArena.js";
import { resolveBoundary, GOAL_HALF_W, GOAL_BACK, BOUND } from "../src/gedeeld/voetbalVeld.js";

const KOP = "// KOPIE uit kenniskist-server/src/gedeeld/ (npm run gedeeld). Pas het daar aan, niet hier.\n";
const bron = path.join(process.cwd(), "src", "gedeeld");
const site = path.join(process.cwd(), "..", "kenniskist", "src", "games", "online", "gedeeld");

describe("Gedeelde arena-data (server en site)", () => {
  it("de kopie in de site is gelijk aan de bron (anders: npm run gedeeld)", function () {
    if (!fs.existsSync(site)) return this.skip();   // site staat niet naast de server (bv. op Render)
    for (const f of fs.readdirSync(bron).filter(f => f.endsWith(".js"))) {
      const verwacht = KOP + fs.readFileSync(path.join(bron, f), "utf8").replace(/\r\n/g, "\n");
      const echt = fs.existsSync(path.join(site, f)) ? fs.readFileSync(path.join(site, f), "utf8").replace(/\r\n/g, "\n") : "(ontbreekt)";
      assert.strictEqual(echt, verwacht, `${f} in de site wijkt af: draai npm run gedeeld`);
    }
  });

  it("ballonnengevecht: platform hoog, grond laag, helling ertussen, niet omhoog springen", () => {
    const q = QUADRANTS[0];
    assert.strictEqual(heightAt(q.x, q.z), PLAT_H);
    assert.strictEqual(heightAt(0, 0), 0);
    const voet = rampFoot(q), halverwege = heightAt((voet.x + q.x) / 2 + q.rampDir * 3, q.z);
    assert.ok(halverwege > 0 && halverwege < PLAT_H, "helling");
    assert.strictEqual(clampHeightStep(PLAT_H, 0), 0, "vanaf de grond niet op een brug");
    assert.strictEqual(clampHeightStep(PLAT_H, PLAT_H - 0.1), PLAT_H, "van platform naar brug wel");
    assert.ok(DEK_Y < PLAT_H);
    // op de grond kun je een platform niet in; bovenop wel rondrijden
    const p = { x: q.x, z: q.z };
    collideBoxes(p, 1.5, BOXES_GROND);
    assert.ok(Math.abs(p.x - q.x) > 10 || Math.abs(p.z - q.z) > 10, "uit het blok geduwd");
    const b = { x: q.x, z: q.z };
    collideBoxes(b, 1.5, BOXES_BOVEN);
    assert.deepStrictEqual(b, { x: q.x, z: q.z }, "bovenop vrij");
  });

  it("voetbal: rand houdt je binnen, doelmond is open tot het achternet", () => {
    const zij = resolveBoundary(50, 0, 0.6);
    assert.strictEqual(zij.x, BOUND - 0.6);
    assert.strictEqual(zij.nx, -1);
    const doel = resolveBoundary(0, 40, 0.22);
    assert.ok(Math.abs(doel.z - (GOAL_BACK - 0.22)) < 1e-9, "tot het achternet");
    const naastDoel = resolveBoundary(GOAL_HALF_W + 2, 40, 0.22);
    assert.ok(naastDoel.z <= BOUND - 0.22 + 1e-9, "naast het doel is de lijn dicht");
  });
});
