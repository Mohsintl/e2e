/**
 * Nested documents on the BiDi driver: the frame chain a locate resolves,
 * the expression a frame's document answers, and boxes placed in the
 * top-level viewport.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from 'e2e/engine';
import { FrameRegistry, inViewport, resolveFrames, withinFrame } from '../../src/bidi/frames.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const text = (value: string) => ({ kind: 'string' as const, value, exact: true });
const note: LocatorExpression = { kind: 'query', query: { kind: 'label', value: text('Note') } };

/** Scripts `locateNodes` per context and each iframe's `contentWindow`. */
function frames(iframes: Record<string, string[]>, windows: Record<string, string>): FakeBidi {
  return new FakeBidi()
    .on('browsingContext.locateNodes', (params) => ({
      result: { nodes: (iframes[String(params['context'])] ?? []).map((sharedId) => ({ type: 'node', sharedId, value: { localName: 'iframe', nodeType: 1 } })) },
    }))
    .on('script.callFunction', (params) => {
      const element = (params['arguments'] as { sharedId: string }[])[0]!;
      return { result: { type: 'success', realm: 'r', result: { type: 'window', value: { context: windows[element.sharedId] } } } };
    });
}

describe('resolveFrames', () => {
  it('walks each selector into the document of the frame before it and records the chain', async () => {
    const fake = frames({ top: ['outer'], 'outer-doc': ['inner'] }, { outer: 'outer-doc', inner: 'inner-doc' });
    const registry = new FrameRegistry();
    await expect(resolveFrames(fake.connection, 'top', ['#outer', '#inner'], registry)).resolves.toBe('inner-doc');
    expect(registry.chain('inner-doc')).toEqual([
      { element: { sharedId: 'outer' }, context: 'top' },
      { element: { sharedId: 'inner' }, context: 'outer-doc' },
    ]);
    expect(registry.chain('top')).toEqual([]);
  });

  it('is retryable FRAME_NOT_FOUND for no match and FRAME_AMBIGUOUS for two', async () => {
    await expect(resolveFrames(frames({}, {}).connection, 'top', ['#editor'], new FrameRegistry())).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', retryable: true });
    await expect(resolveFrames(frames({ top: ['a', 'b'] }, {}).connection, 'top', ['iframe'], new FrameRegistry())).rejects.toMatchObject({ code: 'FRAME_AMBIGUOUS' });
  });
});

describe('FrameRegistry.viewportBox', () => {
  it('nests each holding frame’s content box into the top-level viewport', async () => {
    const boxes: Record<string, unknown> = {
      outer: { border: { x: 100, y: 50, width: 400, height: 300 }, inset: { x: 2, y: 2, width: 396, height: 296 } },
      inner: { border: { x: 10, y: 20, width: 100, height: 100 }, inset: { x: 0, y: 0, width: 100, height: 100 } },
    };
    const fake = new FakeBidi().on('script.callFunction', (params) => {
      const element = (params['arguments'] as { sharedId: string }[])[0]!;
      const box = boxes[element.sharedId] as { border: Record<string, number>; inset: Record<string, number> };
      const rect = (values: Record<string, number>) => ({ type: 'object', value: Object.entries(values).map(([key, value]) => [key, { type: 'number', value }]) });
      return { result: { type: 'success', realm: 'r', result: { type: 'object', value: [['border', rect(box.border)], ['inset', rect(box.inset)]] } } };
    });
    const registry = new FrameRegistry();
    registry.enter('outer-doc', { element: { sharedId: 'outer' }, context: 'top' });
    registry.enter('inner-doc', { element: { sharedId: 'inner' }, context: 'outer-doc' });
    await expect(registry.viewportBox(fake.connection, 'inner-doc')).resolves.toEqual({ x: 112, y: 72, width: 100, height: 100 });
    await expect(registry.viewportBox(fake.connection, 'top')).resolves.toBeUndefined();
  });
});

describe('withinFrame', () => {
  it('drops the frame steps wherever they sit in the expression', () => {
    const framed: LocatorExpression = { kind: 'frame', selector: '#editor', source: note };
    expect(withinFrame(framed)).toEqual(note);
    expect(withinFrame({ kind: 'index', index: 'first', source: framed })).toEqual({ kind: 'index', index: 'first', source: note });
    expect(withinFrame({ kind: 'filter', source: framed, has: framed })).toEqual({ kind: 'filter', source: note, has: note });
  });
});

describe('inViewport', () => {
  const node: SemanticNode = { ref: { id: 'n1', revision: '' }, states: {}, attributes: {}, inputPurpose: 'none', rect: { x: 10, y: 10, width: 50, height: 20 } };

  it('shifts a box into the frame, clips it, and sets the frame path', () => {
    expect(inViewport(node, { x: 100, y: 200, width: 40, height: 400 }, ['#editor'])).toMatchObject({
      rect: { x: 110, y: 210, width: 30, height: 20 },
      framePath: ['#editor'],
    });
  });

  it('drops the box of a node outside its frame or in a frame with no box', () => {
    expect(inViewport(node, { x: 0, y: 0, width: 5, height: 5 }, ['#f']).rect).toBeUndefined();
    expect(inViewport(node, null, ['#f']).rect).toBeUndefined();
    expect(inViewport(node, undefined, [])).toBe(node);
  });
});
