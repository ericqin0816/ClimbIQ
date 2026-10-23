import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {detectStartSignal} from "./detectStartSignal";
import {analyzeFinishColorSamples, detectFinishSignal, type FinishColorSample} from "./detectFinishSignal";

const mocks=vi.hoisted(()=>({scan:vi.fn()}));
vi.mock("./sourceFrameScan",()=>({scanSourceFrames:mocks.scan}));
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
    vi.stubGlobal("window", {setTimeout, clearTimeout});
    const video=Object.assign(new EventTarget(), {src:"blob:finish-guard", duration:8,
      videoWidth:40, videoHeight:40, readyState:2, seeking:false}) as unknown as HTMLVideoElement;
    let cursor=0;
    Object.defineProperty(video,"currentTime",{get:()=>cursor,set:(time:number)=>{
      cursor=time;
      queueMicrotask(()=>video.dispatchEvent(new Event("seeked")));
    }});
    const coarseSamples:FinishColorSample[]=[];
    vi.stubGlobal("document",{createElement:()=>({width:0,height:0,getContext:()=>({
      clearRect(){},drawImage(){},getImageData:()=>{
        const color=cursor<5?calibration.afterStartRGB:calibration.beforeStartRGB;
        coarseSamples.push({time:cursor,averageRgb:color,directionalRgb:color});
        return {width:4,height:4,data:new Uint8ClampedArray(Array.from({length:16},()=>[color.r,color.g,color.b,255]).flat())};
      },
    })})});
    const failure=new Error("Source-frame timing became unavailable during refinement.");
    mocks.scan.mockImplementation(async options=>{
      // The real seek/crop/weighted-color coarse path must establish a High
      // candidate before this test injects failure at the dense scan boundary.
      expect(analyzeFinishColorSamples(coarseSamples,calibration)).toMatchObject({detected:true,rawTime:5,confidence:"High"});
      expect(options).toMatchObject({video,fallbackFps:30});
      expect(options.start).toBeLessThan(5);
      expect(options.end).toBeGreaterThan(5);
      throw failure;
    });
    await expect(detectFinishSignal({video,zone,startSignalRawTime:0,calibration})).rejects.toBe(failure);
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(coarseSamples.length).toBeGreaterThan(6);
  });
});
