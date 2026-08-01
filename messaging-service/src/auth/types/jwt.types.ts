export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: string;
  type?: 'access' | 'refresh';
}
