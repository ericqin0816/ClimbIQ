import { useEffect, useRef, useState, type RefObject } from "react";
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

  useEffect(() => {
    latest.current = PENDING;
    if (reviewingRef.current) setPresentation(PENDING);
    const video = videoRef.current;
    if (!video || !source || !reviewing) return;
    return observeVideoFramePresentation(video, next => {
      latest.current = next;
      if (reviewingRef.current) setPresentation(next);
    });
  }, [source, videoRef, reviewing]);

  return presentation;
}
