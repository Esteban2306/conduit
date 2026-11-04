import type { Request } from 'express';

export interface ResolvedSignatureSecret {
  secret: string;
  context: Record<string, unknown>;
}

export interface SignatureSecretResolver {
  resolve(
    integrationId: string,
    request: Request,
  ): Promise<ResolvedSignatureSecret | null>;

  onVerified?(
    integrationId: string,
    context: Record<string, unknown>,
  ): Promise<void>;
}
