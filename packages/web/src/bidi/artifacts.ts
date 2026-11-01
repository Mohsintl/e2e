/** Evidence on the BiDi driver: masked screenshots and the attempt's video. */

import { writeFileSync } from 'node:fs';
import type { VideoFile } from 'e2e/engine';
import { capturePixels } from './observe.ts';
import type { BidiSession } from './session.ts';
import { BidiVideo } from './video.ts';

/** The viewport a video starts at before any tab exists: the configured one, else Playwright's default. */
const DEFAULT_VIDEO_SIZE = { width: 1280, height: 720 };

/** Writes a masked viewport screenshot under the attempt directory and returns its relative path. */
export async function screenshot(session: BidiSession, label: string | undefined): Promise<string> {
  const { relative, absolute } = session.artifactPath('screenshots', label, '.png');
  const { pixels } = await capturePixels(session, await session.viewportSize());
  writeFileSync(absolute, pixels.data);
  return relative;
}

/** Starts the attempt's video: the open tab now, and every tab the attempt opens until it stops. */
export async function startVideo(session: BidiSession): Promise<void> {
  session.video ??= new BidiVideo(session.connection, session.settings.browser, session.attempt.artifactsDir, session.settings.screencast);
  const size = session.context === undefined ? (session.settings.viewport ?? DEFAULT_VIDEO_SIZE) : await session.viewportSize();
  await session.video.arm(session.context, size);
}

/** Finishes the attempt's recording and returns its segments. */
export async function stopVideo(session: BidiSession): Promise<readonly VideoFile[]> {
  return (await session.video?.stop()) ?? [];
}
