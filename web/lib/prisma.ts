// Shared Prisma client for the Next.js web app.
// Uses the schema at ../prisma/schema.prisma (same DB the Discord bot reads/writes).

import { PrismaClient } from "@prisma/client";

// Avoid creating new client instances on every hot-reload in dev
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
