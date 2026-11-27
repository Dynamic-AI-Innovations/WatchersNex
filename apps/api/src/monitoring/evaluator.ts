/**
 * Confirmation state machine (Technical Architecture, Section 3; ADR-010).
 *
 * Core-region mode (one probe region, decision DL-008): an incident opens only
 * after CONFIRM_FAILURES consecutive failed checks, each of which already
 * includes a local retry, and resolves after RECOVERY_SUCCESSES consecutive
 * successes. Multi-region quorum replaces the failure count when regional
 * probes arrive; the states and actions stay the same.
 */

export type MonitorState = 'pending' | 'up' | 'suspected' | 'down' | 'recovering' | 'paused';

export interface StateSnapshot {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  firstFailureAt: Date | null;
}

export type Action = 'none' | 'open-incident' | 'resolve-incident';

export interface Evaluation {
  next: StateSnapshot;
  action: Action;
}

export const CONFIRM_FAILURES = 2;
export const RECOVERY_SUCCESSES = 2;

export function evaluate(current: StateSnapshot, outcome: 'up' | 'down', checkedAt: Date): Evaluation {
  if (outcome === 'up') {
    const successes = current.consecutiveSuccesses + 1;
    if (current.state === 'down' || current.state === 'recovering') {
      if (successes >= RECOVERY_SUCCESSES) {
        return { next: cleared(), action: 'resolve-incident' };
      }
      return {
        next: { ...current, state: 'recovering', consecutiveSuccesses: successes, consecutiveFailures: 0 },
        action: 'none',
      };
    }
    return { next: cleared(), action: 'none' };
  }

  const failures = current.consecutiveFailures + 1;
  const firstFailureAt = current.firstFailureAt ?? checkedAt;
  const failing = { consecutiveFailures: failures, consecutiveSuccesses: 0, firstFailureAt };
  if (current.state === 'down' || current.state === 'recovering') {
    return { next: { state: 'down', ...failing }, action: 'none' };
  }
  if (failures >= CONFIRM_FAILURES) {
    return { next: { state: 'down', ...failing }, action: 'open-incident' };
  }
  return { next: { state: 'suspected', ...failing }, action: 'none' };
}

function cleared(): StateSnapshot {
  return { state: 'up', consecutiveFailures: 0, consecutiveSuccesses: 0, firstFailureAt: null };
}

/** Default incident severity from the monitor's criticality (D-07). */
export function severityFor(criticality: string): 'sev1' | 'sev2' | 'sev3' {
  if (criticality === 'critical') return 'sev1';
  if (criticality === 'low') return 'sev3';
  return 'sev2';
}
