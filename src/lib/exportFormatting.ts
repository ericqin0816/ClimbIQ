/** JSON string syntax is valid YAML 1.2 and safely escapes line/control characters. */
export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function yamlNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
