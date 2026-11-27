import { describe, expect, it } from 'vitest';
import { evaluate, severityFor, StateSnapshot } from '../src/monitoring/evaluator.js';

const t0 = new Date('2026-11-27T10:00:00Z');
const t1 = new Date('2026-11-27T10:01:00Z');
const fresh: StateSnapshot = { state: 'pending', consecutiveFailures: 0, consecutiveSuccesses: 0, firstFailureAt: null };

function run(outcomes: Array<'up' | 'down'>, start = fresh) {
  let state = start;
  const actions: string[] = [];
  outcomes.forEach((o, i) => {
    const r = evaluate(state, o, new Date(t0.getTime() + i * 60_000));
    state = r.next;
    actions.push(r.action);
  });
  return { state, actions };
}

describe('confirmation state machine', () => {
  it('goes from pending to up on the first success', () => {
    expect(run(['up']).state.state).toBe('up');
  });

  it('does not open an incident on a single failure', () => {
    const { state, actions } = run(['up', 'down']);
    expect(state.state).toBe('suspected');
    expect(actions).not.toContain('open-incident');
  });

  it('opens exactly one incident on the second consecutive failure', () => {
    const { state, actions } = run(['up', 'down', 'down', 'down', 'down']);
    expect(state.state).toBe('down');
    expect(actions.filter((a) => a === 'open-incident')).toHaveLength(1);
    expect(actions[2]).toBe('open-incident');
  });

  it('dates the outage from the first failing check, not from confirmation', () => {
    const { state } = run(['up', 'down', 'down']);
    expect(state.firstFailureAt).toEqual(t1);
  });

  it('treats a flap (fail, pass, fail) as no incident', () => {
    const { actions } = run(['up', 'down', 'up', 'down', 'up']);
    expect(actions).not.toContain('open-incident');
  });

  it('needs two consecutive successes to resolve', () => {
    const down = run(['down', 'down']).state;
    const once = evaluate(down, 'up', t1);
    expect(once).toMatchObject({ action: 'none', next: { state: 'recovering' } });
    const twice = evaluate(once.next, 'up', t1);
    expect(twice).toMatchObject({ action: 'resolve-incident', next: { state: 'up', firstFailureAt: null } });
  });

  it('returns to down if recovery is interrupted, without opening a second incident', () => {
    const down = run(['down', 'down']).state;
    const { state, actions } = run(['up', 'down', 'up', 'up'], down);
    expect(actions).toEqual(['none', 'none', 'none', 'resolve-incident']);
    expect(state.state).toBe('up');
  });

  it('maps criticality to the default severity', () => {
    expect([severityFor('critical'), severityFor('standard'), severityFor('low')]).toEqual(['sev1', 'sev2', 'sev3']);
  });
});
