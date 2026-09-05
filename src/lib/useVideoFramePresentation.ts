import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { observeVideoFramePresentation, type FramePresentation } from "./videoFramePresentation";

const PENDING: FramePresentation = { status: "pending" };

/** Observe native presentation only during manual review, never automatic seeks. */
export function useVideoFramePresentation(videoRef: RefObject<HTMLVideoElement | null>, source: string | null, reviewing: boolean): FramePresentation {
  const latest = useRef<FramePresentation>(PENDING);
  const reviewingRef = useRef(reviewing);
  const [presentation, setPresentation] = useState<FramePresentation>(PENDING);

  useEffect(() => {
    reviewingRef.current = reviewing;
    if (reviewing) setPresentation(latest.current);
  }, [reviewing]);

  useLayoutEffect(() => {
    latest.current = PENDING;
    if (reviewingRef.current) setPresentation(PENDING);
    const video = videoRef.current;
    if (!video || !source || !reviewing) return;
    const publishPausedFrame = () => { if (reviewingRef.current) setPresentation(latest.current); };
    video.addEventListener("pause", publishPausedFrame);
    const stop = observeVideoFramePresentation(video, next => {
      latest.current = next;
      // Keep playback metadata in a ref; a whole-app React render on every
      // presented frame is unnecessary while acceptance is disabled.
      if (reviewingRef.current && (video.paused || next.status !== "available")) setPresentation(next);
    });
    return () => { stop(); video.removeEventListener("pause", publishPausedFrame); };
  }, [source, videoRef, reviewing]);

  return presentation;
}
