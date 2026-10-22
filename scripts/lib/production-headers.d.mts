import type { Plugin } from "vite";
export const productionPreviewHeaders: Record<string, string>;
export function productionHeadersForPath(pathname: string): Record<string, string>;
export function productionHeadersPlugin(): Plugin;
