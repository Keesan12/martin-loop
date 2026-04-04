import {
  buildExecutiveOverviewViewModel as buildLiveExecutiveOverviewViewModel,
  type OverviewViewModel
} from "../server/control-plane-read-model";

export async function buildExecutiveOverviewViewModel(): Promise<OverviewViewModel> {
  return buildLiveExecutiveOverviewViewModel();
}
