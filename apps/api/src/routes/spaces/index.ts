import { Hono } from "hono";
import spacesRouter from "./spaces.route.js";
import fsRouter from "./fs.route.js";
import membersRouter from "./members.route.js";
import accessRouter from "./access.route.js";
import usageRouter from "./usage.route.js";
import invitationsRouter from "./invitations.route.js";
import labelsRouter, { getResourceLabels, setResourceLabels } from "./labels.route.js";
import modsRouter from "./mods.route.js";
import canvasRouter from "./canvas.route.js";
import voiceLexiconRouter from "./voice-lexicon.route.js";

const router = new Hono();

router.route("/", spacesRouter);
router.route("/:id/fs", fsRouter);
router.route("/:id/members", membersRouter);
router.route("/:id/access", accessRouter);
router.route("/:id/usage", usageRouter);
router.route("/:id/invitations", invitationsRouter);
router.route("/:id/labels", labelsRouter);
router.get("/:id/resources/:resourceType/labels", getResourceLabels);
router.put("/:id/resources/:resourceType/labels", setResourceLabels);
router.route("/:id/mods", modsRouter);
router.route("/:id/canvas", canvasRouter);
router.route("/:id/voice-lexicon", voiceLexiconRouter);

export default router;
