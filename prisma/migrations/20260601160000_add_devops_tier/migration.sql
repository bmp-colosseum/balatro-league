-- Add DEVOPS to PermissionTier so infra alerts (queue stalls,
-- rate-limit floods) ping a distinct role from ADMIN/HELPER.
ALTER TYPE "PermissionTier" ADD VALUE IF NOT EXISTS 'DEVOPS';
