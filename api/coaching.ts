import { createCoachingHandler } from "../server/coachingHandler.js";

export default { fetch: createCoachingHandler(process.env) };
