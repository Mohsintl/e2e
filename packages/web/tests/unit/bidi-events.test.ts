/**
 * Browser-wide events routed to the running BiDi attempt: context
 * ownership, user prompts through its dialog router (and never another
 * session's), and its app log.
 */

import { describe, expect, it } from 'vitest';
import type { AppLogEntry } from 'e2e/engine';
import { DialogRouter } from '../../src/dialogs.ts';
import { routeEvents } from '../../src/bidi/events.ts';
import { ContextOwners, type BidiSession } from '../../src/bidi/session.ts';
import { ErrorLatch } from '../../src/support.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

/** The parts of a session the event router reads, owning `userContext`'s contexts. */
function attempt(owners: ContextOwners, userContext: string) {
  const latch = new ErrorLatch();
  const log: AppLogEntry[] = [];
  const added: string[] = [];
  const session = {
    context: 'tab',
    latch,
    dialogs: new DialogRouter(latch),
    attempt: { appLog: (entry: AppLogEntry) => log.push(entry) },
    network: { addContext: async (context: string) => void added.push(context), removeContext: async () => undefined },
    owns: (context: string | null | undefined) => context != null && owners.owner(context) === userContext,
  };
  return { session: session as unknown as BidiSession, log, added, latch };
}

function prompt(context: string, type = 'confirm') {
  return { context, handler: 'ignore', message: 'Really delete everything?', type };
}

describe('routeEvents', () => {
  it('answers a prompt in the attempt’s context through its dialog router', async () => {
    const fake = new FakeBidi();
    const owners = new ContextOwners();
    const { session } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    let seen = '';
    session.dialogs.add(async (dialog) => {
      seen = `${dialog.type}: ${dialog.message}`;
      await dialog.accept();
    });
    fake.emit('browsingContext.userPromptOpened', prompt('tab'));
    await settle();
    expect(seen).toBe('confirm: Really delete everything?');
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: true }]);
  });

  it('leaves a prompt in another session’s context alone', async () => {
    const fake = new FakeBidi();
    const owners = new ContextOwners();
    const { session } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'theirs', userContext: 'other', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.userPromptOpened', prompt('theirs'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt')).toEqual([]);
  });

  it('dismisses an unhandled prompt and fails the next step naming it', async () => {
    const fake = new FakeBidi();
    const owners = new ContextOwners();
    const { session, latch } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.userPromptOpened', prompt('tab', 'alert'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: false }]);
    expect(() => latch.throwPending()).toThrow('unhandled alert dialog: Really delete everything?');
  });

  it('gives a frame its parent’s owner, covers a tab the app opens, and logs only the attempt’s pages', () => {
    const fake = new FakeBidi();
    const owners = new ContextOwners();
    const { session, log, added } = attempt(owners, 'mine');
    const off = routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.contextCreated', { context: 'frame', parent: 'tab', url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.contextCreated', { context: 'popup', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    expect(owners.owner('frame')).toBe('mine');
    expect(added).toEqual(['popup']);
    const entry = (context: string, text: string) => ({ type: 'console', level: 'error', text, timestamp: 0, method: 'error', args: [], source: { realm: 'r', context } });
    fake.emit('log.entryAdded', entry('frame', 'boom'));
    fake.emit('log.entryAdded', entry('elsewhere', 'not mine'));
    fake.emit('log.entryAdded', entry('tab', 'Failed to load resource: 404'));
    off();
    fake.emit('log.entryAdded', entry('tab', 'after unsubscribe'));
    expect(log).toEqual([{ source: 'console', level: 'error', text: 'boom' }]);
  });
});
