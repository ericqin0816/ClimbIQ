import type { BiomechanicsFrame, BiomechanicsResult } from "../types";
import { buildMetricChunks, REPEATED_COM_FRAME_WARNING } from "./biomechanics";
import { sourceSampleTime } from "./sourceSampleTiming";

// Forty SVG units per metre on BOTH axes. Plot area is 120 × 600 for 3 × 15 m.
export const WALL_PLOT = { left:40, top:20, width:120, height:600, scale:40 } as const;
export const wallPlotX = (metres: number) => WALL_PLOT.left + Math.max(-0.36,Math.min(3.36,metres))*WALL_PLOT.scale;
export const wallPlotY = (metres: number) => WALL_PLOT.top+WALL_PLOT.height - Math.max(-0.75,Math.min(15.75,metres))*WALL_PLOT.scale;

export function chartMetricChunks(frames: BiomechanicsFrame[], requireSpeed=false) {
  const parts: BiomechanicsFrame[][]=[];
  let current: BiomechanicsFrame[] | undefined;
  for (const frame of frames) {
    if (frame.warning?.includes(REPEATED_COM_FRAME_WARNING)) continue;
    if (!frame.valid || frame.poseSelected===false || !frame.smoothedWallCom ||
        !Number.isFinite(frame.smoothedWallCom.xMeters) || !Number.isFinite(frame.smoothedWallCom.yMeters) ||
        (requireSpeed && !Number.isFinite(frame.speedMps))) { current=undefined; continue; }
    if (!current) { current=[]; parts.push(current); }
    current.push(frame);
  }
  return parts.flatMap(part=>buildMetricChunks(part,requireSpeed));
}

/** Presentation only: never fill tracking gaps, change a speed, or rewrite metrics. */
export function describeSpeedTrace(result: BiomechanicsResult) {
  const start=result.startRawTime, end=result.endRawTime;
  const chunks=chartMetricChunks(result.frames,true);
  const gaps: Array<{startRawTime:number;endRawTime:number}> = [];
  if (![start,end].every(Number.isFinite) || end<=start) return {chunks:[],gaps,coverage:0};
  const intervals=chunks.filter(chunk=>chunk.length>=2).map(chunk=>({
    start:Math.max(start,sourceSampleTime(chunk[0])),
    end:Math.min(end,sourceSampleTime(chunk[chunk.length-1])),
  })).filter(interval=>interval.end>interval.start).sort((a,b)=>a.start-b.start);
  let cursor=start;
  for (const interval of intervals) {
    if (interval.start>cursor) gaps.push({startRawTime:cursor,endRawTime:interval.start});
    cursor=Math.max(cursor,interval.end);
  }
  if (cursor<end) gaps.push({startRawTime:cursor,endRawTime:end});
  const missing=gaps.reduce((sum,gap)=>sum+gap.endRawTime-gap.startRawTime,0);
  return {chunks,gaps,coverage:Math.max(0,Math.min(1,1-missing/(end-start)))};
}
