export function msUntilRefresh(params: {
  expiresAtIso: string;
  refreshSkewSeconds: number;
  nowMs?: number;
}): number {
  const now = params.nowMs ?? Date.now();
  const exp = Date.parse(params.expiresAtIso);
  if (!Number.isFinite(exp)) return 0;
  const refreshAt = exp - params.refreshSkewSeconds * 1000;
  return Math.max(0, refreshAt - now);
}


