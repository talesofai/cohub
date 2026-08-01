import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";

const loader = createGenerationDeclarationLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
});

export const loadGenerationDeclarations = loader.loadGenerationDeclarations;
export const loadGenerationDeclaration = loader.loadGenerationDeclaration;
export const loadPlatformGenerationDeclaration = loader.loadPlatformGenerationDeclaration;
export const loadPublicGenerationModels = loader.loadPublicGenerationModels;
export const loadPlatformPublicGenerationModels = loader.loadPlatformPublicGenerationModels;
