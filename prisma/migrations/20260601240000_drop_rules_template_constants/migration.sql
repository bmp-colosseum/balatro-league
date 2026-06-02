-- Scoring + ban/pick are no longer configurable; constants live in
-- web/lib/league-settings.ts. Drop the columns from LeagueRulesTemplate
-- so the schema reflects what the UI exposes (just the two timeouts).

ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "pointsFor20Win";
ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "pointsFor11Draw";
ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "pointsForLoss";
ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "firstPlayerBans";
ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "secondPlayerBans";
ALTER TABLE "LeagueRulesTemplate" DROP COLUMN "matchPoolSize";
