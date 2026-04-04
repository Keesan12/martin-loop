import { buildRunPortfolioViewModel } from "../../../lib/server/control-plane-read-model";
import { requireControlPlaneAuth } from "../../../lib/server/auth";
import { jsonError, jsonResponse } from "../../../lib/server/http";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireControlPlaneAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const portfolio = await buildRunPortfolioViewModel();
  const runs = portfolio.runs;

  if (runs.length === 0) {
    return jsonError("no_runs_yet", "No runs yet.", { status: 404 });
  }

  return jsonResponse({ runs });
}
