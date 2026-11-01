/**
 * The attempt's recording on the BiDi driver, one segment per tab the
 * attempt shows, as the Playwright surface records it. Firefox records
 * natively (`browsingContext.startScreencast`, a webm). Chromium's mapper
 * does not implement that command, so its segment is the CDP screencast
 * reached through the mapper's `goog:cdp` passthrough, its JPEG frames
 * encoded to VP9 webm by the ffmpeg Playwright installs, as Playwright's own
 * recorder does.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EngineError, type VideoFile } from 'e2e/engine';
import { ffmpegExecutable } from '../install.ts';
import type { BidiConnection } from './connection.ts';
import type { BidiBrowserName } from './launch.ts';

/** Frames a second of the encoded video. */
const FPS = 25;

export interface VideoOptions {
  readonly size?: { readonly width: number; readonly height: number };
  readonly quality?: number;
}

/** One segment being recorded, and how to finish it. */
interface Segment {
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
  finish(): Promise<void>;
}

export class BidiVideo {
  private armed = false;
  private current: Segment | undefined;
  private count = 0;
  private finished: VideoFile[] = [];

  constructor(
    private readonly connection: BidiConnection,
    private readonly browser: BidiBrowserName,
    private readonly artifactsDir: string,
    private readonly options: VideoOptions,
  ) {}

  /** True between `arm` and `stop`: a tab the attempt opens then starts a segment. */
  get isArmed(): boolean {
    return this.armed;
  }

  /** Starts recording `context`, unless a segment already records, and arms the recorder. */
  async arm(context: string | undefined, viewport: { width: number; height: number }): Promise<void> {
    this.armed = true;
    if (this.current === undefined && context !== undefined) await this.begin(context, viewport);
  }

  /** A tab the attempt opened: the next segment, when armed. */
  async contextOpened(context: string, viewport: { width: number; height: number }): Promise<void> {
    if (this.armed) await this.begin(context, viewport);
  }

  /** The recorded tab is about to close: its segment ends while it can still flush. */
  contextClosing(): Promise<void> {
    return this.end();
  }

  /** Ends the recording and returns every segment written, in order. */
  async stop(): Promise<readonly VideoFile[]> {
    this.armed = false;
    await this.end();
    return this.finished.splice(0);
  }

  private async begin(context: string, viewport: { width: number; height: number }): Promise<void> {
    await this.end();
    this.count += 1;
    const name = this.count === 1 ? 'video' : `video-part${String(this.count)}`;
    const relative = path.posix.join('video', `${name}.webm`);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const size = this.options.size ?? viewport;
    const startedAt = new Date().toISOString();
    const finish = this.browser === 'firefox'
      ? await this.firefoxSegment(context, size, absolute)
      : await this.chromiumSegment(context, size, absolute);
    this.current = { relative, absolute, startedAt, finish };
  }

  private async end(): Promise<void> {
    const segment = this.current;
    this.current = undefined;
    if (segment === undefined) return;
    await segment.finish();
    if (existsSync(segment.absolute)) this.finished.push({ path: segment.relative, startedAt: segment.startedAt });
  }

  /** Firefox's own screencast; the file it writes is moved into the attempt directory when it stops. */
  private async firefoxSegment(context: string, size: { width: number; height: number }, absolute: string): Promise<() => Promise<void>> {
    const { screencast } = await this.connection.send('browsingContext.startScreencast', {
      context,
      mimeType: 'video/webm',
      video: { width: size.width, height: size.height, frameRate: FPS },
    });
    return async () => {
      const stopped = await this.connection.send('browsingContext.stopScreencast', { screencast }).catch(() => undefined);
      if (stopped === undefined || !existsSync(stopped.path)) return;
      try {
        renameSync(stopped.path, absolute);
      } catch {
        // A rename across volumes fails; the file is copied instead.
        copyFileSync(stopped.path, absolute);
        rmSync(stopped.path, { force: true });
      }
    };
  }

  /**
   * Chromium's CDP screencast through the mapper: each JPEG frame is
   * acknowledged and piped to ffmpeg, which stamps it with the time it
   * arrived and writes a constant-frame-rate VP9 webm.
   */
  private async chromiumSegment(context: string, size: { width: number; height: number }, absolute: string): Promise<() => Promise<void>> {
    const ffmpeg = ffmpegExecutable();
    if (ffmpeg === undefined) {
      throw new EngineError('ENGINE_FAILURE', 'recording video needs the ffmpeg Playwright installs: run e2e-web install chromium', { retryable: false });
    }
    const connection = this.connection;
    const { session } = (await connection.sendExtension('goog:cdp.getSession', { context })) as { session: string };
    const encoder = startEncoder(ffmpeg, size, absolute);
    let last: Buffer | undefined;
    const off = connection.onExtension('goog:cdp.Page.screencastFrame', (event) => {
      if (event['session'] !== session) return;
      const params = event['params'] as { data: string; sessionId: number };
      last = Buffer.from(params.data, 'base64');
      if (encoder.stdin?.writable === true) encoder.stdin.write(last);
      void connection.sendExtension('goog:cdp.sendCommand', { method: 'Page.screencastFrameAck', params: { sessionId: params.sessionId }, session }).catch(() => undefined);
    });
    // An extension event the spec's event names do not list.
    const extensionEvent = 'goog:cdp.Page.screencastFrame' as 'browsingContext.load';
    const { subscription } = await connection.send('session.subscribe', { events: [extensionEvent], contexts: [context] });
    await connection.sendExtension('goog:cdp.sendCommand', {
      method: 'Page.startScreencast',
      params: { format: 'jpeg', quality: this.options.quality ?? 90, maxWidth: size.width, maxHeight: size.height },
      session,
    });
    return async () => {
      off();
      await connection.sendExtension('goog:cdp.sendCommand', { method: 'Page.stopScreencast', params: {}, session }).catch(() => undefined);
      await connection.send('session.unsubscribe', { subscriptions: [subscription] }).catch(() => undefined);
      // The last frame holds until the stop, so the video lasts as long as the segment did.
      if (last !== undefined && encoder.stdin?.writable === true) encoder.stdin.write(last);
      await closeEncoder(encoder);
    };
  }
}

/** ffmpeg reading JPEGs from stdin, each stamped with the wall clock as it arrives, writing VP9 webm at `FPS`. */
function startEncoder(ffmpeg: string, size: { width: number; height: number }, output: string): ChildProcess {
  const { width, height } = size;
  const args = [
    '-loglevel', 'error',
    '-f', 'image2pipe', '-use_wallclock_as_timestamps', '1', '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-y', '-an', '-fps_mode', 'cfr', '-r', String(FPS),
    '-c:v', 'libvpx-vp9', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-cpu-used', '8',
    '-b:v', '1M', '-row-mt', '1',
    '-vf', `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
    output,
  ];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => undefined);
  return child;
}

/** Closes the encoder's input and resolves once it has written the file. */
function closeEncoder(encoder: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (encoder.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      encoder.kill('SIGKILL');
      resolve();
    }, 10_000);
    encoder.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    encoder.stdin?.end();
  });
}
