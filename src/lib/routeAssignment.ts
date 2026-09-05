import type { NormalizedPoint } from "../types";

export interface RouteAssignmentMatch { holdIndex: number; candidateIndex: number; residual: number }
export interface RouteAssignmentCandidate { image: NormalizedPoint; silhouetteScore: number; persistence: number }

/** Minimum-cost rectangular assignment with explicit unmatched columns.
 * Minimizes total squared spatial residual, not the number of displayed labels.
 * An unmatched hold costs one radius squared; out-of-radius matches are forbidden.
 * This avoids a locally nearest Hold 9 stealing Hold 8's sole usable silhouette.
 */
export function assignRouteMatches(expected: NormalizedPoint[], candidates: RouteAssignmentCandidate[], radius: number): RouteAssignmentMatch[] {
  const rows = expected.length;
  if (!rows || !candidates.length || rows > 32 || candidates.length > 128 || !Number.isFinite(radius) || radius <= 0) return [];
  const columns = candidates.length + rows;
  const residuals = expected.map(point => candidates.map(candidate => Math.hypot(point.x - candidate.image.x, point.y - candidate.image.y)));
  const cost = (row: number, column: number) => {
    if (column >= candidates.length) return 1;
    const residual = residuals[row][column];
    if (!Number.isFinite(residual) || residual > radius) return rows + 2;
    const quality = Number.isFinite(candidates[column].silhouetteScore) ? Math.max(0, Math.min(1, candidates[column].silhouetteScore)) : 0;
    return (residual / radius) ** 2 + (1 - quality) * 1e-9;
  };
  const u = new Float64Array(rows + 1);
  const v = new Float64Array(columns + 1);
  const owner = new Int32Array(columns + 1);
  const previousColumn = new Int32Array(columns + 1);
  for (let row = 1; row <= rows; row += 1) {
    owner[0] = row;
    let column = 0;
    const minimum = new Float64Array(columns + 1).fill(Infinity);
    const visited = new Uint8Array(columns + 1);
    do {
      visited[column] = 1;
      const currentRow = owner[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= columns; candidateColumn += 1) {
        if (visited[candidateColumn]) continue;
        const reduced = cost(currentRow - 1, candidateColumn - 1) - u[currentRow] - v[candidateColumn];
        if (reduced < minimum[candidateColumn]) {
          minimum[candidateColumn] = reduced;
          previousColumn[candidateColumn] = column;
        }
        if (minimum[candidateColumn] < delta) { delta = minimum[candidateColumn]; nextColumn = candidateColumn; }
      }
      for (let candidateColumn = 0; candidateColumn <= columns; candidateColumn += 1) {
        if (visited[candidateColumn]) { u[owner[candidateColumn]] += delta; v[candidateColumn] -= delta; }
        else minimum[candidateColumn] -= delta;
      }
      column = nextColumn;
    } while (owner[column] !== 0);
    do {
      const prior = previousColumn[column];
      owner[column] = owner[prior];
      column = prior;
    } while (column !== 0);
  }
  const matches: RouteAssignmentMatch[] = [];
  for (let column = 1; column <= candidates.length; column += 1) {
    const row = owner[column] - 1;
    if (row >= 0 && residuals[row][column - 1] <= radius) matches.push({ holdIndex: row, candidateIndex: column - 1, residual: residuals[row][column - 1] });
  }
  return matches.sort((a, b) => a.holdIndex - b.holdIndex);
}
