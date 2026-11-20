import { collectFeeds, type CollectDeps, type CollectSummary } from './collect.ts';
import { deliverPending, type DeliverDeps, type DeliverSummary } from './deliver.ts';

export type RunDeps = CollectDeps & DeliverDeps;

export interface RunSummary {
  collect: CollectSummary;
  deliver: DeliverSummary | null;
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const collect = await collectFeeds(deps);
  const deliver = deps.config.discordDeliveryDisabled && !deps.dryRun ? null : await deliverPending(deps);
  return { collect, deliver };
}
