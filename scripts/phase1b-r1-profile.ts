export function checkCpuProfile(profile: { nodes: unknown[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }, encodedBytes: number, maxBytes = 8 * 1024 * 1024, maxSamples = 50000) {
  const truncated = encodedBytes > maxBytes || (profile.samples?.length ?? 0) > maxSamples;
  const nodeIds = new Set(profile.nodes.map((node) => (node as { id: number }).id));
  const positiveControl = !!profile.nodes.length && !!profile.samples?.length && profile.timeDeltas?.length === profile.samples.length && profile.endTime > profile.startTime && profile.samples.every((id) => nodeIds.has(id)) && profile.timeDeltas.every((value) => Number.isFinite(value) && value >= 0);
  return { truncated, positiveControl, valid: !truncated && positiveControl };
}
