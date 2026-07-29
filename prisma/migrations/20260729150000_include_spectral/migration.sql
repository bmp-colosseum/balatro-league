-- Per-match toggle for whether the Spectral+ stake is in a BMP-style pool.
-- Defaults to TRUE (included, at 0.5 weight); only affects bmpStyle matches.
ALTER TABLE "MatchSession" ADD COLUMN "includeSpectral" BOOLEAN NOT NULL DEFAULT true;
