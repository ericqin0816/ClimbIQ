const VIDEO_FILE_EXTENSIONS = new Set([
  "3gp",
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "ogv",
  "webm",
]);

interface VideoFileCandidate {
  name: string;
  size: number;
  type: string;
}

export function validateVideoFile(file: VideoFileCandidate): string | null {
  if (file.size <= 0) {
    return "This video file is empty. Choose a different recording.";
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.type.startsWith("video/") && !VIDEO_FILE_EXTENSIONS.has(extension)) {
    return "Choose a video file such as MOV, MP4, M4V, or WebM.";
  }

  return null;
}
