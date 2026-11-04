export interface BatchResult {
  total: number;
  queued: number;
  failed: Array<{
    index: number;
    error: string;
  }>;
}
