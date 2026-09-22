import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportTextFile, exportResultMessage } from "./exportFile";

const mocks = vi.hoisted(() => ({ native: vi.fn(), write: vi.fn(), share: vi.fn(), remove: vi.fn(), rmdir: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native } }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: { writeFile: mocks.write, deleteFile: mocks.remove, rmdir: mocks.rmdir }, Directory: { Cache: "CACHE" }, Encoding: { UTF8: "utf8" } }));
vi.mock("@capacitor/share", () => ({ Share: { share: mocks.share } }));

describe("native file exports", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.native.mockReturnValue(true);
    mocks.write.mockResolvedValue({ uri: "file:///cache/export.json" });
    mocks.share.mockResolvedValue({ activityType: "files" });
    mocks.remove.mockResolvedValue(undefined);
    mocks.rmdir.mockResolvedValue(undefined);
  });
  it("shares a UTF-8 file and cleans it up only after sharing finishes", async () => {
    let finish!: () => void;
    mocks.share.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = exportTextFile("attempt.json", '{"name":"登攀"}', "application/json");
    await vi.waitFor(() => expect(mocks.share).toHaveBeenCalled());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ data: '{"name":"登攀"}', encoding: "utf8", directory: "CACHE" }));
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ files: ["file:///cache/export.json"] }));
    finish();
    await expect(pending).resolves.toBe("shared");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("reports dismissal as cancellation, never success", async () => {
    mocks.share.mockRejectedValue(new Error("Share canceled"));
    await expect(exportTextFile("attempt.json", "{}", "application/json")).resolves.toBe("cancelled");
    expect(exportResultMessage("cancelled", "attempt.json")).toContain("cancelled");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("preserves write and share failures for the interface", async () => {
    mocks.write.mockRejectedValueOnce(new Error("Storage full"));
    await expect(exportTextFile("a.json", "{}", "application/json")).rejects.toThrow("Storage full");
    expect(mocks.share).not.toHaveBeenCalled();
    mocks.share.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(exportTextFile("a.json", "{}", "application/json")).rejects.toThrow("Unavailable");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("contains exported filenames within a unique cache directory", async () => {
    await exportTextFile("../../bad/file.json", "{}", "application/json");
    const path = mocks.write.mock.calls[0][0].path;
    expect(path.split("/")).toHaveLength(3);
    expect(path).not.toContain("/../");
  });
});
