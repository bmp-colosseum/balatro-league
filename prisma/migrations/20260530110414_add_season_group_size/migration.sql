-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Season" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" DATETIME,
    "endedAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "targetGroupSize" INTEGER NOT NULL DEFAULT 5,
    "minGroupSize" INTEGER NOT NULL DEFAULT 3
);
INSERT INTO "new_Season" ("deadline", "endedAt", "id", "isActive", "name", "startedAt") SELECT "deadline", "endedAt", "id", "isActive", "name", "startedAt" FROM "Season";
DROP TABLE "Season";
ALTER TABLE "new_Season" RENAME TO "Season";
CREATE INDEX "Season_isActive_idx" ON "Season"("isActive");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
