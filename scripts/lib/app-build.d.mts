import type { AppBuildIdentity } from "../../src/lib/buildIdentity";
export function readAppBuild(root: string, git?: (args: string[]) => string): AppBuildIdentity;
