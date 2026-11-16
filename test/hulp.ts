import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../src/app.config.js";

export const wacht = (ms: number) => new Promise(r => setTimeout(r, ms));

// Wacht tot `test()` waar is (elke 25 ms kijken), of gooi na `maxMs`.
export async function tot(test: () => boolean, maxMs = 6000, wat = "voorwaarde") {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > maxMs) throw new Error(`te lang gewacht op: ${wat}`);
    await wacht(25);
  }
}

// Eén testserver voor alle testbestanden.
let server: ColyseusTestServer<typeof appConfig> | null = null;
export async function testServer() {
  if (!server) server = await boot(appConfig);
  return server;
}
export async function stopTestServer() {
  if (server) { await server.shutdown(); server = null; }
}

// De SDK waarschuwt bij elk bericht waar de test niet naar luistert; dat hoort
// niet tussen de testuitslag.
export function luisterStil(client: any, ...types: string[]) {
  for (const t of types) client.onMessage(t, () => {});
}
