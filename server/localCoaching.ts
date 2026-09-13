import { coachingConfig, createCoachingHandler } from "./coachingHandler";

// Used only by Vite development middleware, never the deployed API.
export function createLocalCoachingHandler(env: Record<string, string | undefined>) {
  const config = coachingConfig(env);
  const handler = createCoachingHandler(env);
  return async (request: Request, remoteAddress: string | undefined) => {
    const origin = config ? new URL(config.origin) : null;
    const local = !!origin && ["localhost", "127.0.0.1"].includes(origin.hostname)
      && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress ?? "")
      && request.headers.get("host") === origin.host;
    if (request.method === "GET" && new URL(request.url).searchParams.get("status") === "1") {
      const response = await handler(request);
      return Response.json({ ...await response.json(), localAccess: local }, { headers: response.headers });
    }
    // A foreign website cannot supply this header without a CORS preflight.
    // Also require browser same-origin metadata and a literal loopback Host.
    if (local && request.headers.get("x-climbiq-local") === "1"
      && request.headers.get("sec-fetch-site") === "same-origin"
      && (!request.headers.has("origin") || request.headers.get("origin") === config!.origin)
      && !request.headers.has("authorization")) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${config!.token}`);
      request = new Request(request, { headers });
    }
    return handler(request);
  };
}
