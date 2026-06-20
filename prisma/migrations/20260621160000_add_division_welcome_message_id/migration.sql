-- Remember each division's welcome/onboarding message so an admin can refresh its
-- content in place (edit, not re-post — so nobody gets re-pinged). Additive + safe.
ALTER TABLE "Division" ADD COLUMN "welcomeMessageId" TEXT;
