// Load .env so the env-validation module graph (env.ts) doesn't throw when a
// test transitively imports it. No DB connection happens — the unit-tested
// logic is pure.
import { config } from "dotenv";

config();
