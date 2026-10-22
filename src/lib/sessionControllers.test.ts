import { describe, expect, it, vi } from "vitest";
import { VideoSessionController } from "./videoSessionController";
import { AnalysisRunController } from "./analysisRunController";
import type { PreparedVideo } from "./preparedVideo";

describe("video session ownership", () => {
  it("disposes a late decoder result after replacement or a session change", async () => {
    let finish!: (video: PreparedVideo) => void;
    const dispose = vi.fn();
    const decoder = vi.fn(() => new Promise<PreparedVideo>(resolve => { finish = resolve; }));
    const controller = new VideoSessionController(decoder);
    const ticket = controller.beginPreparation();
    const result = controller.prepare({} as File, ticket, () => true);
    const next = controller.beginPreparation();
    finish({ dispose } as unknown as PreparedVideo);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.finishPreparation(ticket)).toBe(false);
    expect(controller.isCurrent(next)).toBe(true);
    const staleContext = controller.prepare({} as File, next, () => false);
    finish({ dispose } as unknown as PreparedVideo);
    await expect(staleContext).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

describe("analysis run ownership", () => {
  const player = () => ({ src: "blob:first", currentTime: 4, paused: true, pause: vi.fn(), play: vi.fn(async () => {}) }) as unknown as HTMLVideoElement;
  it("serializes tasks, restores playback after failure, and permits the next task", async () => {
    const video = player(), seek = vi.fn(async () => {});
    const controller = new AnalysisRunController(seek);
    const events: string[] = [];
    const base = { video, isCurrent: () => true, onTime: vi.fn(), onStatus: vi.fn(), completeMessage: "Done", taskName: "test" };
    const first = controller.run({ ...base, work: async () => { events.push("first"); throw new Error("detector failure"); } });
    const second = controller.run({ ...base, work: async () => { events.push("second"); return 42; } });
    await expect(first).rejects.toThrow("detector failure");
    expect(await second).toBe(42);
    expect(events).toEqual(["first", "second"]);
    expect(seek).toHaveBeenCalledTimes(2);
    expect(base.onStatus).toHaveBeenCalledWith("Video restored after test stopped.");
  });
  it("never restores a replaced source and rejects work queued for its old decoder", async () => {
    const video = player(), seek = vi.fn(async () => {});
    const controller = new AnalysisRunController(seek);
    let finish!: () => void;
    const base = { video, isCurrent: () => true, onTime: vi.fn(), onStatus: vi.fn(), completeMessage: "Done", taskName: "test" };
    const first = controller.run({ ...base, work: () => new Promise<void>(resolve => { finish = resolve; }) });
    const work = vi.fn(async () => 1);
    const queued = controller.run({ ...base, work });
    await Promise.resolve();
    video.src = "blob:replacement";
    finish();
    await first;
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(seek).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
