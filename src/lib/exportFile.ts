import { Capacitor } from "@capacitor/core";
import { createUUID } from "./createUUID";

export type FileExportResult = "shared" | "downloaded" | "cancelled";

/** Native exports go through the system share sheet, including Save to Files. */
export async function exportTextFile(fileName: string, content: string, type: string): Promise<FileExportResult> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.hidden = true;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } finally {
      // Safari may dispatch a download after the initiating task has completed.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return "downloaded";
  }

  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"), import("@capacitor/share"),
  ]);
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "") || "climbiq-export.json";
  const path = `climbiq-exports/${createUUID()}/${safeName}`;
  const file = await Filesystem.writeFile({ path, data: content, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
  try {
    await Share.share({ title: fileName, files: [file.uri], dialogTitle: "Export from ClimbIQ" });
    return "shared";
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String((reason as { message?: string })?.message ?? reason);
    if (/cancel(?:led|ed)/i.test(message)) return "cancelled";
    throw reason;
  } finally {
    // The native promise completes after the receiving activity has finished.
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    await Filesystem.rmdir({ path: path.slice(0, path.lastIndexOf("/")), directory: Directory.Cache }).catch(() => undefined);
  }
}

export function exportResultMessage(result: FileExportResult, fileName: string): string {
  if (result === "cancelled") return "Export cancelled. Your analysis is still available here.";
  return result === "shared" ? `Shared ${fileName}.` : `Download started for ${fileName}.`;
}
