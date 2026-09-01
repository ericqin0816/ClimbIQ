export interface VideoUiState {
  hasSelectedVideo: boolean;
  hasLoadedVideo: boolean;
}

/**
 * Keep video selection separate from decoder readiness. The player must mount
 * as soon as a local URL exists so it can emit the metadata event that makes
 * analysis ready.
 */
export function getVideoUiState(videoUrl: string | null, metadataLoaded: boolean): VideoUiState {
  const hasSelectedVideo = Boolean(videoUrl);
  return {
    hasSelectedVideo,
    hasLoadedVideo: hasSelectedVideo && metadataLoaded,
  };
}
