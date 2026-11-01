/**
 * The attempt's recording on the BiDi driver, one segment per tab the
 * attempt shows, as the Playwright surface records it. Firefox records
 * natively (`browsingContext.startScreencast`, a VP8 webm of the page's
 * repaints, which ends at the last one). Chromium's mapper
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
   * acknowledged and handed to the encoder, which holds the last frame for
   * the time until the next one, so the video plays at the page's own pace.
   */
  private async chromiumSegment(context: string, size: { width: number; height: number }, absolute: string): Promise<() => Promise<void>> {
    const ffmpeg = ffmpegExecutable();
    if (ffmpeg === undefined) {
      throw new EngineError('ENGINE_FAILURE', 'recording video needs the ffmpeg Playwright installs: run e2e-web install chromium', { retryable: false });
    }
    const connection = this.connection;
    const { session } = (await connection.sendExtension('goog:cdp.getSession', { context })) as { session: string };
    const encoder = new FrameEncoder(ffmpeg, size, absolute);
    const off = connection.onExtension('goog:cdp.Page.screencastFrame', (event) => {
      if (event['session'] !== session) return;
      const params = event['params'] as { data: string; sessionId: number };
      encoder.frame(Buffer.from(params.data, 'base64'));
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
      await encoder.close();
    };
  }
}

/**
 * How long a segment with no frame yet waits for one before it ends, and how
 * long the last frame holds past the end, as Playwright's recorder does: a
 * page that just painted may deliver its frame after the paint, and a viewer
 * needs a moment on the final screen.
 */
const FRAME_GRACE_MS = 1_000;

/**
 * Encodes screencast frames to a constant-rate VP9 webm with ffmpeg. A
 * screencast sends a frame only when the page repaints, so each frame is
 * written again for every tick of `FPS` until the next one arrives, and the
 * last one until the segment ends.
 */
class FrameEncoder {
  private readonly process: ChildProcess;
  private last: Buffer | undefined;
  private written = 0;
  private readonly startedAt = performance.now();
  private framed: () => void = () => undefined;
  private readonly firstFrame = new Promise<void>((resolve) => (this.framed = resolve));

  constructor(ffmpeg: string, size: { width: number; height: number }, output: string) {
    const { width, height } = size;
    const args = [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-y', '-an',
      '-c:v', 'libvpx-vp9', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-cpu-used', '8',
      '-b:v', '1M', '-row-mt', '1',
      '-vf', `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
      output,
    ];
    this.process = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    this.process.stdin?.on('error', () => undefined);
  }

  /** Takes the next frame: the one before it is held until now, then this one shows. */
  frame(jpeg: Buffer): void {
    this.fill();
    this.last = jpeg;
    this.write(jpeg);
    this.framed();
  }

  /**
   * Waits a moment for a first frame when none came, holds the last frame
   * until now and a moment past it, then closes the input and resolves once
   * ffmpeg wrote the file. A segment that never got a frame writes none.
   */
  async close(): Promise<void> {
    await Promise.race([this.firstFrame, new Promise((resolve) => setTimeout(resolve, FRAME_GRACE_MS))]);
    this.fill(FRAME_GRACE_MS);
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.process.kill('SIGKILL');
        resolve();
      }, 10_000);
      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.process.stdin?.end();
    });
  }

  /** Writes the last frame again for every tick that passed since the last write, and for `holdMs` more. */
  private fill(holdMs = 0): void {
    if (this.last === undefined) return;
    const due = Math.floor(((performance.now() + holdMs - this.startedAt) / 1000) * FPS);
    while (this.written < due) this.write(this.last);
  }

  private write(jpeg: Buffer): void {
    this.written += 1;
    if (this.process.stdin?.writable === true) this.process.stdin.write(jpeg);
  }
}
