/**
 * Downloads on the BiDi driver: the attempt's user context saves every
 * download into a directory of its own (`browser.setDownloadBehavior`), and a
 * wait pairs `browsingContext.downloadWillBegin` with `downloadEnd` by the
 * download's id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { raceAbort, TestError } from 'e2e/engine';
import type { BidiConnection } from './connection.ts';

/** One finished download: the name the server suggested and where the browser wrote it. */
export interface FinishedDownload {
  readonly suggestedFilename: string;
  readonly filepath: string;
}

interface Pending {
  readonly suggestedFilename: string;
  readonly done: Promise<FinishedDownload>;
}

export class AttemptDownloads {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-bidi-downloads-'));

  constructor(private readonly connection: BidiConnection) {}

  /** Points the user context's downloads at this attempt's directory. */
  async allow(userContext: string): Promise<void> {
    await this.connection.send('browser.setDownloadBehavior', {
      downloadBehavior: { type: 'allowed', destinationFolder: this.dir },
      userContexts: [userContext],
    });
  }

  /**
   * Runs `trigger` and resolves with the first `count` downloads it starts,
   * in start order, once each has finished. A canceled one fails the wait.
   */
  async collect(count: number, trigger: () => Promise<void>, signal: AbortSignal, ours: (context: string) => boolean): Promise<FinishedDownload[]> {
    const started: Pending[] = [];
    const ends = new Map<string, (end: { status: 'complete'; filepath: string | null } | { status: 'canceled' }) => void>();
    let allStarted: () => void = () => undefined;
    const received = new Promise<void>((resolve) => (allStarted = resolve));
    const offBegin = this.connection.on('browsingContext.downloadWillBegin', (event) => {
      if (!ours(event.context) || started.length === count) return;
      const done = new Promise<FinishedDownload>((resolve, reject) => {
        ends.set(event.download, (end) => {
          if (end.status === 'canceled' || end.filepath === null) {
            reject(new TestError('ACTION_FAILED', `download ${event.suggestedFilename} was canceled`));
            return;
          }
          resolve({ suggestedFilename: event.suggestedFilename, filepath: end.filepath });
        });
      });
      done.catch(() => undefined);
      started.push({ suggestedFilename: event.suggestedFilename, done });
      if (started.length === count) allStarted();
    });
    const offEnd = this.connection.on('browsingContext.downloadEnd', (event) => {
      ends.get(event.download)?.(event.status === 'complete' ? { status: 'complete', filepath: event.filepath } : { status: 'canceled' });
    });
    try {
      await trigger();
      await raceAbort(received, signal, 'download');
      return await raceAbort(Promise.all(started.map((download) => download.done)), signal, 'download');
    } finally {
      offBegin();
      offEnd();
    }
  }

  /** Deletes the attempt's download directory; files a wait saved are already copied out. */
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
