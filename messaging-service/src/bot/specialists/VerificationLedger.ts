import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import { Verdict } from './contracts';
import { ImageHash, NORMALIZED_HASH_VERSION } from './image-hash';

const MINUTE_MS = 60_000;
const DEFAULT_PASSPORT_TTL_MINUTES = 60;
const MAX_ROWS = 25;
const CLAIMING_VERDICTS = ['VALID', 'INVALID', 'NEEDS_REVIEW'] as const;

export interface PriorRecord {
  id: string;
  conversationId: string;
  verdict: Verdict;
  confidence: number;
  fields: unknown;
  reasonCodes: string[];
  fingerprint: string | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export type ReuseFinding =
  | { kind: 'NONE' }
  | {
      kind: 'CACHED' | 'ALREADY_USED' | 'OTHER_CONTACT' | 'RESENT';
      record: PriorRecord;
    };

export interface AcceptableRecord {
  id: string;
  verdict: Verdict;
  confidence: number;
  fields: unknown;
  reasonCodes: string[];
  subjectHash: string;
  createdAt: Date;
}

interface ReuseQuery {
  tenantId: string;
  capability: string;
  conversationId: string;
}

@Injectable()
export class VerificationLedger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  passportTtlMs(): number {
    const configured = this.config.get<number>(
      'specialists.passportTtlMinutes',
    );
    const minutes = Number.isFinite(configured)
      ? (configured as number)
      : DEFAULT_PASSPORT_TTL_MINUTES;
    return Math.max(minutes, 1) * MINUTE_MS;
  }

  async checkByHash(
    query: ReuseQuery & { hash: ImageHash },
  ): Promise<ReuseFinding> {
    if (query.hash.version !== NORMALIZED_HASH_VERSION) return { kind: 'NONE' };
    const rows = await this.claimingRecords(query, {
      hashVersion: NORMALIZED_HASH_VERSION,
      subjectHash: query.hash.hash,
    });
    return this.decide(rows, query.conversationId, 'CACHED', true);
  }

  async checkByFingerprint(
    query: ReuseQuery & { fingerprint: string },
  ): Promise<ReuseFinding> {
    const rows = await this.claimingRecords(query, {
      fingerprint: query.fingerprint,
    });
    return this.decide(rows, query.conversationId, 'RESENT', false);
  }

  async findAcceptable(query: {
    tenantId: string;
    conversationId: string;
    capability: string;
    hash: string;
    acceptedVerdicts: Verdict[];
  }): Promise<AcceptableRecord | null> {
    const row = await this.prisma.verificationRecord.findFirst({
      where: {
        tenantId: query.tenantId,
        conversationId: query.conversationId,
        capability: query.capability,
        hashVersion: NORMALIZED_HASH_VERSION,
        subjectHash: query.hash,
        mode: 'ACTIVE',
        verdict: { in: query.acceptedVerdicts },
        consumedAt: null,
        createdAt: { gte: new Date(Date.now() - this.passportTtlMs()) },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        verdict: true,
        confidence: true,
        fields: true,
        reasonCodes: true,
        subjectHash: true,
        createdAt: true,
      },
    });
    return row;
  }

  async claim(recordId: string, tenantId: string): Promise<boolean> {
    const claimed = await this.prisma.verificationRecord.updateMany({
      where: { id: recordId, tenantId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return claimed.count === 1;
  }

  async release(recordId: string, tenantId: string): Promise<boolean> {
    const released = await this.prisma.verificationRecord.updateMany({
      where: { id: recordId, tenantId, consumedAt: { not: null } },
      data: { consumedAt: null },
    });
    return released.count === 1;
  }

  private async claimingRecords(
    query: ReuseQuery,
    match: Record<string, unknown>,
  ): Promise<PriorRecord[]> {
    const rows = await this.prisma.verificationRecord.findMany({
      where: {
        tenantId: query.tenantId,
        capability: query.capability,
        mode: 'ACTIVE',
        verdict: { in: [...CLAIMING_VERDICTS] },
        expiresAt: { gt: new Date() },
        ...match,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      select: {
        id: true,
        conversationId: true,
        verdict: true,
        confidence: true,
        fields: true,
        reasonCodes: true,
        fingerprint: true,
        consumedAt: true,
        createdAt: true,
      },
    });
    return rows;
  }

  private decide(
    rows: PriorRecord[],
    conversationId: string,
    sameChatKind: 'CACHED' | 'RESENT',
    sameChatNeedsFresh: boolean,
  ): ReuseFinding {
    const consumed = rows.find((row) => row.consumedAt !== null);
    if (consumed) return { kind: 'ALREADY_USED', record: consumed };

    const other = rows.find((row) => row.conversationId !== conversationId);
    if (other) return { kind: 'OTHER_CONTACT', record: other };

    const freshSince = Date.now() - this.passportTtlMs();
    const same = rows.find(
      (row) =>
        row.conversationId === conversationId &&
        (!sameChatNeedsFresh || row.createdAt.getTime() >= freshSince),
    );
    return same ? { kind: sameChatKind, record: same } : { kind: 'NONE' };
  }
}
