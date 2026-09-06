export type EvidenceFamily = 'lifecycle' | 'structure' | 'capital' | 'attention';
export type TriggerStrength = 'weak' | 'strong';

export interface Evidence {
  id: string;
  family: EvidenceFamily;
  score: number;
  strength: TriggerStrength;
  createdAtMs: number;
  expiresAtMs: number;
  source: string;
  narrative?: boolean;
  sourceTimeKnown?: boolean;
}

export const defaultEvidenceTtlMs: Record<EvidenceFamily, number> = {
  lifecycle: 600_000,
  structure: 180_000,
  capital: 300_000,
  attention: 600_000
};

export interface EvidenceTtlSeconds {
  lifecycle: number;
  structure: number;
  capital: number;
  attention: number;
  narrative: number;
}

export function evidenceTtlMs(
  family: EvidenceFamily,
  narrative: boolean,
  configured?: EvidenceTtlSeconds
): number {
  if (configured)
    return (
      (family === 'attention' && narrative ? configured.narrative : configured[family]) * 1_000
    );
  return family === 'attention' && narrative ? 1_800_000 : defaultEvidenceTtlMs[family];
}

export class EvidenceBook {
  #byFamily = new Map<EvidenceFamily, Evidence>();

  add(evidence: Evidence): boolean {
    const current = this.#byFamily.get(evidence.family);
    if (
      current &&
      (current.score > evidence.score ||
        (current.score === evidence.score && current.createdAtMs >= evidence.createdAtMs))
    )
      return false;
    this.#byFamily.set(evidence.family, evidence);
    return true;
  }

  invalidate(family: EvidenceFamily): boolean {
    return this.#byFamily.delete(family);
  }

  active(nowMs: number): Evidence[] {
    for (const [family, evidence] of this.#byFamily)
      if (evidence.expiresAtMs <= nowMs) this.#byFamily.delete(family);
    return [...this.#byFamily.values()].sort((left, right) =>
      left.family.localeCompare(right.family)
    );
  }

  hasMinimumEntryEvidence(nowMs: number): boolean {
    const active = this.active(nowMs);
    return (
      active.some((evidence) => evidence.strength === 'strong') ||
      new Set(active.map((evidence) => evidence.family)).size >= 2
    );
  }
}
