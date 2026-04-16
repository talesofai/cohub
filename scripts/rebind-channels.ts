import { bindSpaceChannelsToGateway } from "../apps/api/src/channels.js";

async function main() {
  const spaceId = process.argv[2];
  if (!spaceId) {
    console.error("Usage: npx tsx rebind-channels.ts <spaceId>");
    process.exit(1);
  }
  console.log(`Rebinding channels for space ${spaceId}...`);
  await bindSpaceChannelsToGateway(spaceId);
  console.log("Done!");
}

main().catch(console.error);
