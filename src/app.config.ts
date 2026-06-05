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
import { KartRoom } from "./rooms/KartRoom.js";

// Rooms are matched by a numeric "joinCode" passed at create/join time,
// so lobby codes are short and digits-only.
const rocketRoom = defineRoom(RocketRoom);
rocketRoom.filterBy(["joinCode"]);

const paintballRoom = defineRoom(PaintballRoom);
paintballRoom.filterBy(["joinCode"]);

const kartRoom = defineRoom(KartRoom);
kartRoom.filterBy(["joinCode"]);

const server = defineServer({
    /**
     * Define your room handlers:
     */
    rooms: {
        rocket: rocketRoom,
        paintball: paintballRoom,
        kart: kartRoom
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
        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        /**
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;