import { seekTo } from "./videoFrameSampler";

interface VideoTask<T> {
  video: HTMLVideoElement;
  work(): Promise<T>;
  isCurrent(): boolean;
  onStatus(message: string): void;
  onTime(time: number): void;
  completeMessage: string;
  taskName: string;
}

/** Serializes decoder work and keeps restoration and completion on its source. */
export class AnalysisRunController {
  automatic: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly seek = seekTo) {}

  run<T>(task: VideoTask<T>): Promise<T> {
    const source = task.video.src;
    const current = () => task.isCurrent() && task.video.src === source;
    const execution = this.queue.then(async () => {
      if (!current()) throw new DOMException("The recording changed.", "AbortError");
      const { video } = task;
      const previousTime = video.currentTime;
      const previousPaused = video.paused;
      task.onStatus("");
      video.pause();
      let succeeded = false;
      try {
        const result = await task.work();
        succeeded = true;
        return result;
      } finally {
        if (current()) {
          try {
            await this.seek(video, previousTime);
            if (current()) {
              task.onTime(video.currentTime);
              if (previousPaused) video.pause();
              else await video.play();
              if (current()) task.onStatus(succeeded ? task.completeMessage
                : `Video restored after ${task.taskName.replaceAll("-", " ")} stopped.`);
            }
          } catch (error) {
            if (current()) task.onStatus(error instanceof Error ? `Video restore failed: ${error.message}` : "Video restore failed.");
          }
        }
      }
    });
    this.queue = execution.then(() => undefined, () => undefined);
    return execution;
  }
}
