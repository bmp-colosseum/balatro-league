/*
  Warnings:

  - You are about to drop the column `mpMmr` on the `Signup` table. All the data in the column will be lost.
  - You are about to drop the column `mpUsername` on the `Signup` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Signup" DROP COLUMN "mpMmr",
DROP COLUMN "mpUsername";
