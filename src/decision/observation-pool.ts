import type { RouteName } from '../config/types.js';

export interface ObservedEpisode {
  id: string;
  route: RouteName;
  score: number;
  completeness: number;
  evidenceFreshness: number;
  active: boolean;
}
export interface Admission {
  admitted: boolean;
  demotedId?: string;
}

export class ObservationPool {
  #episodes = new Map<string, ObservedEpisode>();
  constructor(
    readonly capacity = 60,
    readonly softRouteTarget = 20
  ) {}
  get active(): ObservedEpisode[] {
    return [...this.#episodes.values()].filter((episode) => episode.active);
  }
  admit(candidate: ObservedEpisode): Admission {
    const existing = this.#episodes.get(candidate.id);
    if (existing) {
      if (!existing.active && candidate.active && this.active.length >= this.capacity)
        return { admitted: false };
      this.#episodes.set(candidate.id, candidate);
      return { admitted: true };
    }
    const active = this.active;
    if (active.length < this.capacity) {
      this.#episodes.set(candidate.id, candidate);
      return { admitted: true };
    }
    const lowest = [...active].sort(
      (left, right) => this.quality(left) - this.quality(right) || left.id.localeCompare(right.id)
    )[0];
    if (!lowest || this.quality(candidate) <= this.quality(lowest)) return { admitted: false };
    this.#episodes.set(lowest.id, { ...lowest, active: false });
    this.#episodes.set(candidate.id, candidate);
    return { admitted: true, demotedId: lowest.id };
  }
  private quality(episode: ObservedEpisode): number {
    const sameRouteCount = this.active.filter((item) => item.route === episode.route).length;
    const softTargetBias = sameRouteCount > this.softRouteTarget ? -0.001 : 0;
    return (
      episode.score * 1_000 +
      episode.completeness * 100 +
      episode.evidenceFreshness +
      softTargetBias
    );
  }
}
