// Kept free of Node modules: Studio's browser bundle validates requests with it.

/** Every Work request action the server function accepts. */
export const WORK_REQUEST_ACTIONS = [
  "capture",
  "refresh",
  "share-preview",
  "share",
  "claim",
  "release",
  "start-manual",
  "dispatch",
  "park",
  "move-to-later",
] as const;
