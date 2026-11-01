/** Runs page functions over WebDriver BiDi `script.callFunction` and converts values across the wire. */

import type { Script } from 'webdriver-bidi-protocol';
import { EngineError } from 'e2e/engine';
import type { BidiConnection } from './connection.ts';

/** A DOM element held by its BiDi shared id, valid for as long as the element lives in its document. */
export interface ElementRef {
  readonly sharedId: string;
}

/** What a page function may take: JSON values and element references. */
export type PageArgument = string | number | boolean | null | ElementRef | readonly PageArgument[] | { readonly [key: string]: PageArgument };

/** What a page function hands back: JSON values, with each DOM node as its reference and each window as its browsing context. */
export type PageValue = string | number | boolean | null | undefined | ElementRef | PageValue[] | { [key: string]: PageValue };

export interface CallOptions {
  readonly awaitPromise?: boolean;
  /** Object depth serialized back, `null` for all of it; the default reads two levels, which an array of elements needs. */
  readonly maxObjectDepth?: number | null;
}

/**
 * Calls `declaration` (a function's source) in the context's main world with
 * `args`, and resolves with its return value. A page exception rejects as a
 * script error the caller classifies.
 */
export async function callFunction(
  connection: BidiConnection,
  context: string,
  declaration: string,
  args: readonly PageArgument[] = [],
  options: CallOptions = {},
): Promise<PageValue> {
  const result = await connection.send('script.callFunction', {
    functionDeclaration: declaration,
    target: { context },
    arguments: args.map(toLocalValue),
    awaitPromise: options.awaitPromise ?? false,
    resultOwnership: 'none',
    serializationOptions: { maxDomDepth: 0, maxObjectDepth: options.maxObjectDepth === undefined ? 2 : options.maxObjectDepth, includeShadowTree: 'none' },
  });
  if (result.type === 'exception') throw new ScriptError(result.exceptionDetails.text);
  return fromRemoteValue(result.result);
}

/** A page function that threw; its message is the page's own. */
export class ScriptError extends Error {
  constructor(text: string) {
    super(text);
    this.name = 'ScriptError';
  }
}

function isElementRef(value: unknown): value is ElementRef {
  return typeof value === 'object' && value !== null && 'sharedId' in value && Object.keys(value).length === 1;
}

/** One argument as a BiDi local value. */
function toLocalValue(value: PageArgument): Script.LocalValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'number', value: String(value) as 'NaN' };
  if (Array.isArray(value)) return { type: 'array', value: value.map(toLocalValue) };
  if (isElementRef(value)) return { sharedId: value.sharedId };
  return { type: 'object', value: Object.entries(value).map(([key, entry]) => [key, toLocalValue(entry as PageArgument)]) };
}

/** One serialized result as a plain value; a node becomes its reference, anything else unreadable becomes undefined. */
function fromRemoteValue(value: Script.RemoteValue): PageValue {
  switch (value.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return value.value;
    case 'number':
      return typeof value.value === 'number' ? value.value : Number(value.value);
    case 'array':
      return (value.value ?? []).map(fromRemoteValue);
    case 'object': {
      const out: Record<string, PageValue> = {};
      for (const [key, entry] of value.value ?? []) {
        if (typeof key === 'string') out[key] = fromRemoteValue(entry);
      }
      return out;
    }
    case 'window':
      return { context: value.value.context };
    case 'node':
      if (value.sharedId === undefined) throw new EngineError('NODE_STALE', 'a returned node has no shared id', { retryable: true });
      return { sharedId: value.sharedId };
    default:
      return undefined;
  }
}
