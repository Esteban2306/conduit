/*
  Warnings:

  - You are about to drop the column `apiApikey` on the `BotConfig` table. All the data in the column will be lost.
  - Added the required column `aiApikey` to the `BotConfig` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BotConfig" DROP COLUMN "apiApikey",
ADD COLUMN     "aiApikey" TEXT NOT NULL;
