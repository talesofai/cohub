import { Hono } from "hono";
import internalGatewayRouter from "./gateway.route.js";
import internalRealtimeVoiceRouter from "./realtime-voice.route.js";
import internalSpaceEventsRouter from "./space-events.route.js";
import internalSpacesRouter from "./spaces.route.js";

const router = new Hono();

router.route("/gateway", internalGatewayRouter);
router.route("/realtime-voice", internalRealtimeVoiceRouter);
router.route("/space-events", internalSpaceEventsRouter);
router.route("/spaces", internalSpacesRouter);

export default router;
