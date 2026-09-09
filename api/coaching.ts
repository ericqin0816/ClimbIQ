import { createCoachingHandler } from "../server/coachingHandler";

export default { fetch: createCoachingHandler(process.env) };
