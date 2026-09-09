import {describe, expect, it} from "vitest";
import type {BiomechanicsFrame, BiomechanicsResult} from "../types";
import {describeSpeedTrace, WALL_PLOT, wallPlotX, wallPlotY} from "./biomechanicsPresentation";

const frame = (rawTime:number):BiomechanicsFrame => ({rawTime,climbTime:rawTime,valid:true,
  poseDetected:true,poseSelected:true,landmarks:[],massCoverage:1,meanVisibility:1,
  smoothedWallCom:{xMeters:1,yMeters:rawTime},speedMps:1});
const result = (frames:BiomechanicsFrame[],startRawTime=0,endRawTime=1) => ({frames,startRawTime,endRawTime} as BiomechanicsResult);

describe("metric chart presentation",()=>{
  it("uses the same scale per metre on both axes",()=>{
    expect(wallPlotX(2)-wallPlotX(1)).toBe(wallPlotY(1)-wallPlotY(2));
    expect(WALL_PLOT.width/WALL_PLOT.height).toBe(3/15);
    expect(wallPlotX(3)-wallPlotX(0)).toBe(WALL_PLOT.width);
    expect(wallPlotY(0)-wallPlotY(15)).toBe(WALL_PLOT.height);
  });
  it("shows leading, internal and trailing missing time without filling it",()=>{
    const data=result([frame(.1),frame(.3),{...frame(.4),valid:false},frame(.6),frame(.8)]);
    const before=JSON.stringify(data);
    const view=describeSpeedTrace(data);
    expect(view.gaps).toEqual([
      {startRawTime:0,endRawTime:.1},{startRawTime:.3,endRawTime:.6},{startRawTime:.8,endRawTime:1},
    ]);
    expect(view.coverage).toBeCloseTo(.4);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("does not give an isolated estimate continuous time coverage",()=>{
    const view=describeSpeedTrace(result([frame(.3)]));
    expect(view.chunks).toHaveLength(1);
    expect(view.coverage).toBe(0);
    expect(view.gaps).toEqual([{startRawTime:0,endRawTime:1}]);
  });
  it("uses native sample times and clips them to the accepted range",()=>{
    const view=describeSpeedTrace(result([
      {...frame(.11),decodedFrameRawTime:.1,sourceFrameDurationSeconds:.03},
      {...frame(.31),decodedFrameRawTime:.3,sourceFrameDurationSeconds:.03},
    ],.15,.25));
    expect(view.coverage).toBe(1);
    expect(view.gaps).toEqual([]);
  });
  it("does not turn missing speed or a large sampling gap into a connected line",()=>{
    const view=describeSpeedTrace(result([frame(.1),{...frame(.2),speedMps:undefined},frame(.3),frame(.8)]));
    expect(view.coverage).toBe(0);
    expect(view.chunks.every(chunk=>chunk.length===1)).toBe(true);
  });
});
