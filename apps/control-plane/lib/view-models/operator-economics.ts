import {
  buildEconomicsViewModel as buildLiveEconomicsViewModel,
  type OverviewViewModel
} from "../server/control-plane-read-model";

export async function buildEconomicsViewModel(): Promise<
  OverviewViewModel & { methodologyNotes: string[] }
> {
  return buildLiveEconomicsViewModel();
}
