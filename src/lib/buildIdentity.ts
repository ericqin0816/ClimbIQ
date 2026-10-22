import pkg from "../../package.json" with { type: "json" };

export interface AppBuildIdentity {
  schemaVersion: 1;
  appVersion: string;
  commitSha: string | null;
  /** null means source identity/status could not be established, never a clean build. */
  workingTreeDirty: boolean | null;
}
export type BuildIdentity = AppBuildIdentity;

declare const __CLIMBIQ_BUILD__: AppBuildIdentity | undefined;

export function sanitizeAppBuildIdentity(value: unknown): AppBuildIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AppBuildIdentity>;
  if (candidate.schemaVersion !== 1 || typeof candidate.appVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(candidate.appVersion)) return undefined;
  if (candidate.commitSha === null && candidate.workingTreeDirty === null) {
    return { schemaVersion: 1, appVersion: candidate.appVersion, commitSha: null, workingTreeDirty: null };
  }
  if (typeof candidate.commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(candidate.commitSha) ||
      typeof candidate.workingTreeDirty !== "boolean") return undefined;
  return { schemaVersion: 1, appVersion: candidate.appVersion, commitSha: candidate.commitSha.toLowerCase(), workingTreeDirty: candidate.workingTreeDirty };
}

export function resolveAppBuild(value: unknown): AppBuildIdentity {
  return sanitizeAppBuildIdentity(value) ??
    { schemaVersion: 1, appVersion: pkg.version, commitSha: null, workingTreeDirty: null };
}

// Node-based import tools do not run Vite defines. Preserve that distinction honestly.
export const APP_BUILD: Readonly<AppBuildIdentity> = Object.freeze(
  resolveAppBuild(typeof __CLIMBIQ_BUILD__ === "undefined" ? undefined : __CLIMBIQ_BUILD__),
);

export function formatBuildIdentity(build: AppBuildIdentity = APP_BUILD): string {
  return `${build.appVersion} · ${build.commitSha ? build.commitSha.slice(0, 7) + (build.workingTreeDirty ? " (modified source)" : "") : "source identity unknown"}`;
}
