-- CreateTable
CREATE TABLE "RoleBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discordRoleId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "RoleBinding_discordRoleId_key" ON "RoleBinding"("discordRoleId");

-- CreateIndex
CREATE INDEX "RoleBinding_tier_idx" ON "RoleBinding"("tier");
