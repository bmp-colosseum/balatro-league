-- Bot-managed "League Player — Season N" role: created at season bootstrap,
-- assigned to every player in the season, pinged by the start announcement.
ALTER TABLE "Season" ADD COLUMN "leaguePlayerRoleId" TEXT;
