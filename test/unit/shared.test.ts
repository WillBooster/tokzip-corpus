import { expect, test } from 'bun:test';

import { chunkDocument } from '../../scripts/corpus/shared.ts';

test('does not split a UTF-16 surrogate pair between chunks', () => {
  const prefix = 'a'.repeat(255);
  const chunks = chunkDocument(`${prefix}😀${'b'.repeat(300)}`);

  expect(chunks[0]?.chunk).toBe(prefix);
  expect(chunks[1]?.chunk.startsWith('😀')).toBe(true);
});
