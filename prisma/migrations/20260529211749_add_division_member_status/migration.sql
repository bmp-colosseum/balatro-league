-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DivisionMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "divisionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "droppedAt" DATETIME,
    "dropoutReason" TEXT,
    CONSTRAINT "DivisionMember_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DivisionMember_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DivisionMember" ("divisionId", "id", "joinedAt", "playerId") SELECT "divisionId", "id", "joinedAt", "playerId" FROM "DivisionMember";
DROP TABLE "DivisionMember";
ALTER TABLE "new_DivisionMember" RENAME TO "DivisionMember";
CREATE INDEX "DivisionMember_playerId_idx" ON "DivisionMember"("playerId");
CREATE INDEX "DivisionMember_divisionId_status_idx" ON "DivisionMember"("divisionId", "status");
CREATE UNIQUE INDEX "DivisionMember_divisionId_playerId_key" ON "DivisionMember"("divisionId", "playerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
