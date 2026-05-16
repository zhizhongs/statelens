// Batch CLI demo — process a screenshot directory and print the timeline.

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { observe, getTimeline } from '../src/pipeline/index.js';

export async function processDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const screenshots = entries
    .filter((f) => ['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase()))
    .sort();

  if (screenshots.length === 0) {
    console.error(`No PNG/JPEG files found in ${dir}`);
    process.exit(1);
  }

  const sessionId = `cli_${Date.now()}`;
  console.log(`Processing ${screenshots.length} screenshots from ${dir}...`);
  console.log('');

  for (const file of screenshots) {
    const buffer = await readFile(join(dir, file));
    const result = await observe(buffer, sessionId);
    const marker = result.changed
      ? result.keyframe ? '★' : '·'
      : ' ';
    console.log(`${marker} ${file}  ${result.event_type}: ${result.event_summary}`);
  }

  console.log('');
  console.log('--- Timeline ---');
  console.log(JSON.stringify(getTimeline(sessionId), null, 2));
}
