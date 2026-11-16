import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";

/**
 * Import your Room files
 */
import { RocketRoom } from "./rooms/RocketRoom.js";
import { PaintballRoom } from "./rooms/PaintballRoom.js";
import { BotsenRoom } from "./rooms/BotsenRoom.js";

// Rooms are matched by a numeric "joinCode" passed at create/join time,
// so lobby codes are short and digits-only.
const rocketRoom = defineRoom(RocketRoom);
rocketRoom.filterBy(["joinCode"]);

const paintballRoom = defineRoom(PaintballRoom);
paintballRoom.filterBy(["joinCode"]);

const botsenRoom = defineRoom(BotsenRoom);
botsenRoom.filterBy(["joinCode"]);

const server = defineServer({
    /**
     * Define your room handlers:
     */
    rooms: {
        rocket: rocketRoom,
        paintball: paintballRoom,
        botsen: botsenRoom
    },

    /**
     * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
     * 
     * Usage from SDK: 
     *   client.http.get("/api/hello").then((response) => {})
     * 
     */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET", }, async (ctx) => {
            return { message: "Hello World" }
        })
    }),

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        // Health check van Render, en de site roept dit aan om de slapende
        // server alvast te wekken (zie src/games/online/verbinding.js).
        app.get("/hi", (req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            res.send("wakker");
        });

        // Beheerpaneel (potjes bekijken en sluiten) en de speeltuin: alleen bij
        // lokaal ontwikkelen. Online stond /monitor voor iedereen open, zonder
        // wachtwoord, met de namen van de spelers erin.
        if (process.env.NODE_ENV !== "production") {
            app.use("/monitor", monitor());
            app.use("/", playground());
        }
    }

});

export default server;