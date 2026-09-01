import { describe, expect, it } from "vitest";
import { getVideoUiState } from "./videoUiState";

describe("getVideoUiState", () => {
  it("mounts the workspace while a selected video is still loading metadata", () => {
    expect(getVideoUiState("blob:http://localhost/sample", false)).toEqual({
      hasSelectedVideo: true,
      hasLoadedVideo: false,
    });
  });

  it("only marks analysis ready after metadata has loaded", () => {
    expect(getVideoUiState(null, false)).toEqual({ hasSelectedVideo: false, hasLoadedVideo: false });
    expect(getVideoUiState("blob:http://localhost/sample", true)).toEqual({
      hasSelectedVideo: true,
      hasLoadedVideo: true,
    });
  });
});
