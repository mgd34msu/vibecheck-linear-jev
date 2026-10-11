// Every battery behind one interface, so tools can list, calibrate and replay
// them without knowing each battery's input and decision types. Stored inputs
// are validated with the battery's own input schema before a replay.

import {
  asksPermissionBattery,
  blockerTriageBattery,
  briefCarriesRulesBattery,
  briefScopeBattery,
  claimGroundedBattery,
  claimOverlapBattery,
  claimsDoneBattery,
  commitHonestyBattery,
  deferralBattery,
  doneAdmitsUnfinishedBattery,
  fallbackAddedBattery,
  givesUpBattery,
  handoffBattery,
  planCoverageBattery,
  questionAnsweredBattery,
  stalledBattery,
  stopReasonBattery,
  taskDuplicateBattery,
  userPausesBattery,
} from "./batteries.js";
import {
  runBattery,
  runFixtures,
  sampleFixtures,
  type Battery,
  type Decision,
  type FixtureReport,
  type FixtureSample,
  type Questions,
  type RunOptions,
} from "./lib/index.js";

export interface BatteryHandle {
  readonly id: string;
  readonly version: number;
  readonly purpose: string;
  readonly fixtureCount: number;
  readonly thresholds: Readonly<Record<string, number>>;
  runFixtures(options: RunOptions): Promise<FixtureReport>;
  sample(runs: number, options: RunOptions): Promise<FixtureSample[]>;
  /** Re-reads a stored input with the current battery; the decision and whether it stops the work. */
  replay(
    input: unknown,
    options: RunOptions,
  ): Promise<{ readonly decision: unknown; readonly stops: boolean }>;
}

function handle<I, Q extends Questions, K extends string, D extends Decision>(
  battery: Battery<I, Q, K, D>,
): BatteryHandle {
  return {
    id: battery.id,
    version: battery.version,
    purpose: battery.purpose,
    fixtureCount: battery.fixtures.length,
    thresholds: battery.thresholds,
    runFixtures: (options) => runFixtures(battery, options),
    sample: (runs, options) => sampleFixtures(battery, runs, options),
    async replay(input, options) {
      const run = await runBattery(
        battery,
        battery.input.parse(input),
        options,
      );
      return {
        decision: run.decision,
        stops: run.decision.block || run.decision.review === true,
      };
    },
  };
}

export const BATTERIES: readonly BatteryHandle[] = [
  handle(briefScopeBattery),
  handle(briefCarriesRulesBattery),
  handle(deferralBattery),
  handle(stopReasonBattery),
  handle(claimsDoneBattery),
  handle(doneAdmitsUnfinishedBattery),
  handle(questionAnsweredBattery),
  handle(fallbackAddedBattery),
  handle(asksPermissionBattery),
  handle(claimGroundedBattery),
  handle(givesUpBattery),
  handle(userPausesBattery),
  handle(claimOverlapBattery),
  handle(commitHonestyBattery),
  handle(handoffBattery),
  handle(taskDuplicateBattery),
  handle(planCoverageBattery),
  handle(stalledBattery),
  handle(blockerTriageBattery),
];

export function batteryById(id: string): BatteryHandle | undefined {
  return BATTERIES.find((battery) => battery.id === id);
}
