export type AssistantNavigationContext = {
  isWorkshop: boolean;
  isAdmin: boolean;
  currentFarmId: string | null;
  hasCurrentFarmRole: boolean;
};

/**
 * Keep Voice Assistant discoverable for farm-side users even when the selected farm's
 * plan is below Complete. The page and every assistant API still enforce the selected
 * farm's entitlement; a locked farm therefore receives the existing upgrade notice.
 */
export function assistantNavigationVisible(context: AssistantNavigationContext): boolean {
  if (context.isWorkshop) return false;
  if (context.isAdmin) return true;
  return Boolean(context.currentFarmId && context.hasCurrentFarmRole);
}
