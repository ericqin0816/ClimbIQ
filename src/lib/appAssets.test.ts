import { describe, expect, it } from "vitest";
import { resolveAppAssetUrl } from "./appAssets";

describe("bundled asset URLs", () => {
  it("loads the pose model under Capacitor's custom scheme with an opaque origin", () => {
    const documentUrl = "capacitor://localhost/index.html";
    expect(new URL(documentUrl).origin).toBe("null");
    expect(resolveAppAssetUrl("models/pose_landmarker_full.task", "/", documentUrl))
      .toBe("capacitor://localhost/models/pose_landmarker_full.task");
  });

  it("loads the WASM directory from the native root even with a nested page URL", () => {
    expect(resolveAppAssetUrl("mediapipe/wasm", "/", "capacitor://localhost/review/attempt?tab=pose"))
      .toBe("capacitor://localhost/mediapipe/wasm");
  });

  it("preserves an HTTPS deployment base path", () => {
    expect(resolveAppAssetUrl("/models/pose_landmarker_full.task", "/climbiq", "https://example.com/climbiq/"))
      .toBe("https://example.com/climbiq/models/pose_landmarker_full.task");
  });

  it.each(["./", ""])("supports a relative Vite base (%s) using the document's directory", (base) => {
    expect(resolveAppAssetUrl("mediapipe/wasm", base, "https://example.com/climbiq/index.html?source=home#analysis"))
      .toBe("https://example.com/climbiq/mediapipe/wasm");
  });

  it("keeps a root-hosted browser build working", () => {
    expect(resolveAppAssetUrl("models/pose_landmarker_full.task", "/", "http://localhost:5173/"))
      .toBe("http://localhost:5173/models/pose_landmarker_full.task");
  });
});
