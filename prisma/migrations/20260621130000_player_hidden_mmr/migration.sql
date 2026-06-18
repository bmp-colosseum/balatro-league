-- Secret "Elowen" MMR per player (2200 scale) + the volatility counter the
-- Elowen formula uses. Set once at onboarding (seeded from BMP), then updated
-- per match. Additive + safe.
ALTER TABLE "Player" ADD COLUMN "hiddenMmr" INTEGER;
ALTER TABLE "Player" ADD COLUMN "mmrVolatility" INTEGER NOT NULL DEFAULT 0;
