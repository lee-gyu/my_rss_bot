import { collectFeeds, type CollectDeps, type CollectSummary } from './collect.ts';
import { deliverPending, type DeliverDeps, type DeliverSummary } from './deliver.ts';

export type RunDeps = CollectDeps & DeliverDeps;

export interface RunSummary {
  collect: CollectSummary;
  deliver: DeliverSummary;
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const collect = await collectFeeds(deps);
  const deliver = await deliverPending(deps);
  return { collect, deliver };
}
