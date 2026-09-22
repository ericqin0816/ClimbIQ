import type { VideoMetadata } from "../types";
import { validateVideoFile } from "./videoFileSelection";

export interface PreparedVideo {
  file: File;
  /** Certifies the detached decoder; the visible player still needs to load this URL. */
  metadata: VideoMetadata & { metadataLoaded: true };
  objectUrl: string;
  previewDataUrl: string;
  /** Release the URL after rejection, replacement, or unmount. Safe to call twice. */
  dispose(): void;
}

interface PreparationOptions {
  signal?: AbortSignal;
}

interface PreparationDependencies {
  createVideo(): HTMLVideoElement;
  createCanvas(): HTMLCanvasElement;
  createObjectUrl(file: File): string;
  revokeObjectUrl(url: string): void;
  timeoutMs?: number;
}

const DECODE_ERROR = "This recording could not be decoded. Try another video, or export it as an H.264 MP4 and choose that copy.";

function aborted() {
  const error = new Error("Video preparation was cancelled.");
  error.name = "AbortError";
  return error;
}

/** Prepare a candidate without touching the currently open video or its analysis. */
export function createVideoPreparer(dependencies: PreparationDependencies) {
  return async function prepare(file: File, { signal }: PreparationOptions = {}): Promise<PreparedVideo> {
    if (signal?.aborted) throw aborted();
    const validationError = validateVideoFile(file);
    if (validationError) throw new Error(validationError);

    const video = dependencies.createVideo();
    const objectUrl = dependencies.createObjectUrl(file);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      dependencies.revokeObjectUrl(objectUrl);
    };

    return new Promise<PreparedVideo>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const releaseDecoder = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onError);
        // Cleanup must not mask a decode error or prevent the candidate URL being released.
        try { video.pause(); } catch { /* Detached decoder may already be unavailable. */ }
        try { video.removeAttribute("src"); } catch { /* Best effort. */ }
        try { video.load(); } catch { /* Best effort. */ }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        releaseDecoder();
        dispose();
        reject(error);
      };
      const onAbort = () => fail(aborted());
      const onError = () => fail(new Error(DECODE_ERROR));
      function onReady() {
        if (settled) return;
        if (signal?.aborted) return onAbort();
        if (video.error) return onError();
        if (video.readyState < 1) return;
        if (![video.duration, video.videoWidth, video.videoHeight].every(value => Number.isFinite(value) && value > 0)) {
          return fail(new Error("This recording has no usable duration or video dimensions. Choose another copy."));
        }
        // HAVE_CURRENT_DATA is required: metadata alone also loads for some damaged files.
        if (video.readyState < 2) return;
        try {
          const metadata: PreparedVideo["metadata"] = {
            fileName: file.name,
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            metadataLoaded: true,
          };
          const canvas = dependencies.createCanvas();
          const scale = Math.min(1, 240 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Frame canvas unavailable");
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          // Readback proves this decoded frame is available to the analysis canvas too.
          context.getImageData(0, 0, 1, 1);
          const previewDataUrl = canvas.toDataURL("image/jpeg", 0.7);
          if (!previewDataUrl.startsWith("data:image/")) throw new Error("Frame preview unavailable");
          settled = true;
          releaseDecoder();
          resolve({ file, metadata, objectUrl, previewDataUrl, dispose });
        } catch {
          fail(new Error(DECODE_ERROR));
        }
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
      video.addEventListener("error", onError);
      const requestedTimeout = dependencies.timeoutMs ?? 15_000;
      timeout = setTimeout(() => fail(new Error("This recording took too long to open. Try choosing it again, or export it as an H.264 MP4.")), Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 15_000);
      try {
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        video.src = objectUrl;
        video.load();
        onReady();
      } catch {
        fail(new Error(DECODE_ERROR));
      }
    });
  };
}

export const prepareVideo = createVideoPreparer({
  createVideo: () => document.createElement("video"),
  createCanvas: () => document.createElement("canvas"),
  createObjectUrl: file => URL.createObjectURL(file),
  revokeObjectUrl: url => URL.revokeObjectURL(url),
});
