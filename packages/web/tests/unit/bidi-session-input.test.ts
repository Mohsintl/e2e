/** Input on a BiDi session: a modifier `keyboard.down` holds stays held through chords and modifier clicks until its `keyboard.up`. */

import { describe, expect, it } from 'vitest';
import { clickSources, fixtureKeySource } from '../../src/bidi/input.ts';
import { BidiSession, ContextOwners } from '../../src/bidi/session.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const SHIFT = '';

/** A session on `fake` with its tab open. */
function session(fake: FakeBidi): BidiSession {
  const settings = { siteHeaders: () => undefined, holdRequests: false, media: {}, viewport: null };
  const attempt = { credentials: undefined };
  const created = new BidiSession({ connection: fake.connection, exclusive: true } as never, settings as never, attempt as never, new ContextOwners());
  created.context = 'tab';
  return created;
}

describe('BidiSession.sendInput', () => {
  it('neither presses nor releases a modifier the test holds, and lets its own up release it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = session(fake);
    await held.sendInput([fixtureKeySource('Shift', 'keyDown', false)]);
    await held.sendInput([fixtureKeySource('Shift+ArrowRight', 'press', true)]);
    await held.sendInput(clickSources(5, 5, { modifiers: ['Shift'] }));
    await held.sendInput([fixtureKeySource('Shift', 'keyUp', true)]);
    const keys = fake.commands('input.performActions').map((command) =>
      (command.params['actions'] as { type: string; actions: { type: string; value?: string }[] }[]).filter((source) => source.type === 'key').flatMap((source) => source.actions));
    expect(keys[0]).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(keys[1]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[2]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[3]).toEqual([{ type: 'keyUp', value: SHIFT }]);
  });
});
