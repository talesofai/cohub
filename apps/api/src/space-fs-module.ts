import { createSpaceFsModule } from "@cohub/space-fs";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";

export const spaceFsModule = createSpaceFsModule({
  config,
  db,
  redis: redisCommandClient,
  serviceName: "cohub-api",
});
