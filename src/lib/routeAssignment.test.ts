import { describe, expect, it } from "vitest";
import { assignRouteMatches } from "./routeAssignment";

const candidate = (x: number, y: number) => ({ image: { x, y }, silhouetteScore: 1, persistence: 1 });
describe("joint route-number assignment", () => {
  it("does not steal Hold 8's only candidate for a slightly closer Hold 9", () => {
    // Synthetic neighboring-hold regression, not a label for a user's clip.
    const expected = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.47 }];
    const matches = assignRouteMatches(expected, [candidate(0.5, 0.482), candidate(0.5, 0.45)], 0.035);
    expect(matches.map(match => [match.holdIndex, match.candidateIndex])).toEqual([[0, 0], [1, 1]]);
  });
  it("leaves an absent hold unmatched instead of inventing a number", () => {
    const matches = assignRouteMatches([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.4 }], [candidate(0.5, 0.499)], 0.03);
    expect(matches.map(match => match.holdIndex)).toEqual([0]);
  });
  it("keeps one-to-one identities when candidates are reordered", () => {
    const points = [{ x: 0.2, y: 0.7 }, { x: 0.3, y: 0.5 }, { x: 0.2, y: 0.3 }];
    const candidates = points.map(point => candidate(point.x, point.y)).reverse();
    expect(assignRouteMatches(points, candidates, 0.05).map(match => match.candidateIndex)).toEqual([2, 1, 0]);
  });
  it("agrees with exhaustive assignment on small missing/competing-hold cases", () => {
    let seed = 91247;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 80; trial += 1) {
      const expected = Array.from({ length: 4 }, () => ({ x: random() * 0.1, y: random() * 0.1 }));
      const candidates = Array.from({ length: 5 }, () => candidate(random() * 0.1, random() * 0.1));
      const radius = 0.035;
      const matches = assignRouteMatches(expected, candidates, radius);
      const actualCost = expected.length - matches.length + matches.reduce((sum, match) => sum + (match.residual / radius) ** 2, 0);
      const brute = (row: number, used: Set<number>): number => {
        if (row === expected.length) return 0;
        let best = 1 + brute(row + 1, used);
        candidates.forEach((c, index) => {
          const residual = Math.hypot(expected[row].x - c.image.x, expected[row].y - c.image.y);
          if (used.has(index) || residual > radius) return;
          const next = new Set(used); next.add(index);
          best = Math.min(best, (residual / radius) ** 2 + brute(row + 1, next));
        });
        return best;
      };
      expect(actualCost, `trial ${trial}`).toBeCloseTo(brute(0, new Set()), 10);
      expect(new Set(matches.map(match => match.holdIndex)).size).toBe(matches.length);
      expect(new Set(matches.map(match => match.candidateIndex)).size).toBe(matches.length);
    }
  });
  it("rejects unusable bounds and cannot hang on nonfinite coordinates", () => {
    for (const radius of [0, -1, NaN, Infinity]) expect(assignRouteMatches([{ x: 0, y: 0 }], [candidate(0, 0)], radius)).toEqual([]);
    expect(assignRouteMatches([{ x: NaN, y: 0 }, { x: 0, y: 0 }], [candidate(0, 0)], 0.1).map(match => match.holdIndex)).toEqual([1]);
    expect(assignRouteMatches([{ x: 0, y: 0 }], [candidate(Infinity, 0)], 0.1)).toEqual([]);
  });
});
