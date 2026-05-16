import { Buffer } from 'node:buffer';
import type { ExtractedImageBlock } from './types.js';

type JsonRecord = Record<string, unknown>;

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Image(raw: string): Buffer | null {
  const commaIdx = raw.indexOf(',');
  const payload =
    raw.startsWith('data:') && commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw;
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned || !BASE64_RE.test(cleaned)) return null;
  const bytes = Buffer.from(cleaned, 'base64');
  return bytes.length > 0 ? bytes : null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function extractLatestAnthropicImageBlock(
  body: unknown
): ExtractedImageBlock | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;

  let messageIndex = -1;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (isRecord(message) && message.role === 'user' && Array.isArray(message.content)) {
      messageIndex = i;
      break;
    }
  }

  if (messageIndex < 0) return null;
  const message = body.messages[messageIndex];
  if (!isRecord(message) || !Array.isArray(message.content)) return null;

  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) {
      continue;
    }

    const { source } = block;
    if (source.type !== 'base64') continue;
    if (typeof source.media_type !== 'string' || !SUPPORTED_MEDIA_TYPES.has(source.media_type)) {
      continue;
    }
    if (typeof source.data !== 'string') continue;

    const bytes = decodeBase64Image(source.data);
    if (!bytes) continue;

    return {
      messageIndex,
      contentIndex: i,
      mediaType: source.media_type as 'image/png' | 'image/jpeg',
      data: source.data,
      bytes,
    };
  }

  return null;
}

export function replaceAnthropicImageBlockWithText(
  body: unknown,
  image: ExtractedImageBlock,
  text: string
): unknown {
  const next = cloneJson(body);
  if (!isRecord(next) || !Array.isArray(next.messages)) {
    throw new Error('Anthropic request body is not an object with messages[]');
  }

  const message = next.messages[image.messageIndex];
  if (!isRecord(message) || !Array.isArray(message.content)) {
    throw new Error('Selected Anthropic message does not contain content[]');
  }

  if (image.contentIndex < 0 || image.contentIndex >= message.content.length) {
    throw new Error('Selected Anthropic image block index is out of bounds');
  }

  message.content[image.contentIndex] = { type: 'text', text };
  return next;
}

