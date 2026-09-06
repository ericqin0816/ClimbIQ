import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {detectStartSignal} from "./detectStartSignal";
import {detectFinishSignal} from "./detectFinishSignal";

const mocks=vi.hoisted(()=>({scan:vi.fn()}));
vi.mock("./sourceFrameScan",()=>({scanSourceFrames:mocks.scan}));
vi.mock("./videoFrameSampler",async importOriginal=>{
  const actual=await importOriginal<typeof import("./videoFrameSampler")>();
  return {...actual,sampleZoneOpponentColors:vi.fn(async(_video:HTMLVideoElement,time:number)=>({time,
    averageRgb:time<5?{r:20,g:90,b:220}:{r:20,g:150,b:24},
    directionalRgb:time<5?{r:20,g:90,b:220}:{r:20,g:150,b:24},pixelZone:{x:0,y:0,width:4,height:4}}))};
});
const calibration={beforeStartRGB:{r:20,g:150,b:24},afterStartRGB:{r:20,g:90,b:220},colorDelta:205};
const zone={id:"startLight" as const,label:"Test sensor",x1:.1,x2:.2,y1:.7,y2:.8};
beforeEach(()=>{mocks.scan.mockReset();vi.stubGlobal("VideoFrame",undefined);});
afterEach(()=>vi.unstubAllGlobals());
describe("incomplete source refinement",()=>{
  it("marks failed Start sampling explicitly instead of publishing a detection",async()=>{
    mocks.scan.mockRejectedValue(new Error("Source-frame refinement exceeded its bounded frame budget."));
    const result=await detectStartSignal({video:{duration:8} as HTMLVideoElement,zone,searchStart:.3,searchEnd:2.8,
      fps:30,sensitivity:"medium",profile:"calibrated",calibration});
    expect(result.detected).toBe(false);
    expect(result.confidence).toBe("None");
    expect(result.debug.sourceFrameSamplingFailed).toBe(true);
  });
  it("propagates cancellation rather than converting it into a coarse Start fallback",async()=>{
    const error=new Error("cancelled");error.name="AbortError";
    mocks.scan.mockRejectedValue(error);
    await expect(detectStartSignal({video:{duration:8} as HTMLVideoElement,zone,searchStart:.3,searchEnd:2.8,
      fps:30,sensitivity:"medium",profile:"calibrated",calibration})).rejects.toThrow("cancelled");
  });
  it("cannot leave a coarse Finish authoritative when the dense sampling pass fails",async()=>{
    mocks.scan.mockRejectedValue(new Error("Source-frame timing became unavailable during refinement."));
    await expect(detectFinishSignal({video:{duration:8} as HTMLVideoElement,zone,startSignalRawTime:0,calibration})).rejects.toThrow("became unavailable");
    expect(mocks.scan).toHaveBeenCalledOnce();
  });
});
