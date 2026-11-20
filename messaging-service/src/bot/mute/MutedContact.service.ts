import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { normalizeWhatsAppAddress } from 'src/channels/whatsapp/utils/whatsapp-address.util';

const LID_ADDRESS = /^(\d{5,25})@lid$/;

export function normalizeMutedAddress(raw: string): string | null {
  const trimmed = raw.trim();
  const lid = LID_ADDRESS.exec(trimmed);
  if (lid) return `${lid[1]}@lid`;
  return normalizeWhatsAppAddress(trimmed);
}

@Injectable()
export class MutedContactService {
  constructor(private readonly prisma: PrismaService) {}

  async isMuted(
    botConfigId: string,
    address: string,
    connectionId?: string | null,
  ): Promise<boolean> {
    const candidates = new Set([address]);
    const lid = LID_ADDRESS.exec(address);
    const contact = await this.prisma.whatsAppContact.findFirst({
      where: {
        ...(connectionId ? { connectionId } : {}),
        ...(lid ? { lid: lid[1] } : { address }),
      },
      select: { address: true, lid: true },
    });
    if (contact?.address) candidates.add(contact.address);
    if (contact?.lid) candidates.add(`${contact.lid}@lid`);

    const found = await this.prisma.mutedContact.findFirst({
      where: { botConfigId, address: { in: [...candidates] } },
      select: { id: true },
    });
    return found !== null;
  }

  async mutedAddresses(
    botConfigId: string,
    addresses: readonly string[],
  ): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const rows = await this.prisma.mutedContact.findMany({
      where: { botConfigId, address: { in: [...addresses] } },
      select: { address: true },
    });
    return new Set(rows.map((row) => row.address));
  }

  list(botConfigId: string) {
    return this.prisma.mutedContact.findMany({
      where: { botConfigId },
      orderBy: { createdAt: 'desc' },
      select: { address: true, reason: true, createdAt: true },
    });
  }

  mute(
    tenantId: string,
    botConfigId: string,
    address: string,
    reason: string | null,
  ) {
    return this.prisma.mutedContact.upsert({
      where: { botConfigId_address: { botConfigId, address } },
      create: { tenantId, botConfigId, address, reason },
      update: { reason },
      select: { address: true, reason: true, createdAt: true },
    });
  }

  async unmute(botConfigId: string, address: string): Promise<boolean> {
    const { count } = await this.prisma.mutedContact.deleteMany({
      where: { botConfigId, address },
    });
    return count > 0;
  }
}
