/**
 * The browser-wide events of one BiDi session routed to the running attempt:
 * which user context each browsing context belongs to, user prompts for its
 * dialog router, and the console, errors, and failed requests of its app log.
 */

import type { AppLogEntry } from 'e2e/engine';
import type { NativeDialog } from '../dialogs.ts';
import type { BidiConnection } from './connection.ts';
import type { BidiSession, ContextOwners } from './session.ts';

/** The events every session subscribes to for as long as the browser runs. */
export const SESSION_EVENTS = [
  'log.entryAdded',
  'network.responseCompleted',
  'network.fetchError',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'browsingContext.userPromptOpened',
  'browsingContext.downloadWillBegin',
  'browsingContext.downloadEnd',
  'input.fileDialogOpened',
] as const;

/** Chromium's and Firefox's codes for a request the page itself abandoned, which is no app failure. */
const ABORTED = new Set(['net::ERR_ABORTED', 'NS_BINDING_ABORTED']);

/**
 * Routes `connection`'s events to the attempt `current` returns; returns the
 * unsubscribe. A prompt in a context of another session (a browser shared
 * over CDP) is left for that session to answer.
 */
export function routeEvents(connection: BidiConnection, owners: ContextOwners, current: () => BidiSession | undefined): () => void {
  const report = (entry: AppLogEntry): void => {
    try {
      current()?.attempt.appLog(entry);
    } catch {
      return;
    }
  };
  const ours = (context: string | null | undefined): BidiSession | undefined => {
    const session = current();
    return session?.owns(context) === true ? session : undefined;
  };
  const offs = [
    connection.on('browsingContext.contextCreated', (info) => {
      owners.created(info.context, info.userContext, info.parent);
      const session = ours(info.context);
      if (info.parent == null && session !== undefined && info.context !== session.context) void session.network.addContext(info.context).catch((cause: unknown) => session.latch.latch(asError(cause)));
    }),
    connection.on('browsingContext.contextDestroyed', (info) => {
      const session = ours(info.context);
      if (info.parent == null && session !== undefined) void session.network.removeContext(info.context).catch((cause: unknown) => session.latch.latch(asError(cause)));
      owners.destroyed(info.context);
    }),
    connection.on('browsingContext.userPromptOpened', (prompt) => {
      const session = ours(prompt.context);
      if (session === undefined) return;
      const answer = async (accept: boolean, userText?: string): Promise<void> => {
        await connection.send('browsingContext.handleUserPrompt', { context: prompt.context, accept, ...(userText === undefined ? {} : { userText }) });
      };
      const dialog: NativeDialog = {
        type: () => prompt.type,
        message: () => prompt.message,
        accept: (text) => answer(true, text),
        dismiss: () => answer(false),
      };
      void session.dialogs.dispatch(dialog);
    }),
    connection.on('log.entryAdded', (entry) => {
      if (ours(entry.source.context) === undefined || entry.text === null) return;
      if (entry.type === 'javascript') report({ source: 'error', level: 'error', text: entry.text });
      else if (entry.level !== 'debug' && !entry.text.startsWith('Failed to load resource:')) {
        report({ source: 'console', level: entry.level === 'warn' ? 'warning' : entry.level, text: entry.text });
      }
    }),
    connection.on('network.responseCompleted', (event) => {
      const { status, statusText } = event.response;
      if (ours(event.context) === undefined || status < 400 || isMissingFavicon(event.request.url, status)) return;
      report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: `${event.request.method} ${event.request.url} ${status}${statusText === '' ? '' : ` ${statusText}`}` });
    }),
    connection.on('network.fetchError', (event) => {
      if (ours(event.context) === undefined || ABORTED.has(event.errorText)) return;
      report({ source: 'network', level: 'error', text: `${event.request.method} ${event.request.url} ${event.errorText}` });
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** A browser's own request for a site icon the app never served, which the Playwright app log leaves out too. */
function isMissingFavicon(url: string, status: number): boolean {
  return status === 404 && URL.canParse(url) && new URL(url).pathname === '/favicon.ico';
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
