// CLI: forcibly registers slash commands with Discord (bypasses the hash
// gate the bot uses at startup). Useful when you want to confirm a
// register happens regardless of cache state.
//
// Run: npm run register

import { registerCommands } from "../commands/register.js";

await registerCommands();
console.log("Done.");
