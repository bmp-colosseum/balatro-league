-- DropForeignKey
ALTER TABLE "Shootout" DROP CONSTRAINT "Shootout_divisionId_fkey";

-- DropForeignKey
ALTER TABLE "Pairing" DROP CONSTRAINT "Pairing_divisionId_fkey";

-- DropForeignKey
ALTER TABLE "Pairing" DROP CONSTRAINT "Pairing_playerAId_fkey";

-- DropForeignKey
ALTER TABLE "Pairing" DROP CONSTRAINT "Pairing_playerBId_fkey";

-- DropForeignKey
ALTER TABLE "Pairing" DROP CONSTRAINT "Pairing_reporterId_fkey";

-- DropForeignKey
ALTER TABLE "Pairing" DROP CONSTRAINT "Pairing_disputedById_fkey";

-- DropTable
DROP TABLE "Shootout";

-- DropTable
DROP TABLE "Pairing";

