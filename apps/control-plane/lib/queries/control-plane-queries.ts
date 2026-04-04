import { buildEconomicsViewModel } from "../view-models/operator-economics";
import { buildExecutiveOverviewViewModel } from "../view-models/executive-overview";
import {
  buildBillingViewModel,
  buildGovernanceViewModel,
  buildOperationsViewModel,
  buildSettingsViewModel
} from "../server/control-plane-read-model";

export function getNavigationItems() {
  return [
    { label: "Overview", href: "/" },
    { label: "Cost Dashboard", href: "/cost-dashboard" },
    { label: "Operations", href: "/operations" },
    { label: "Economics", href: "/economics" },
    { label: "Governance", href: "/governance" },
    { label: "Billing", href: "/billing" },
    { label: "Admin", href: "/settings" }
  ];
}

export async function getOverviewPageData() {
  return buildExecutiveOverviewViewModel();
}

export async function getOperationsPageData() {
  return buildOperationsViewModel();
}

export async function getEconomicsPageData() {
  return buildEconomicsViewModel();
}

export async function getGovernancePageData() {
  return buildGovernanceViewModel();
}

export async function getBillingPageData() {
  return buildBillingViewModel();
}

export async function getSettingsPageData() {
  return buildSettingsViewModel();
}
