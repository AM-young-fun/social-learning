import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';

const dir = mkdtempSync(join(tmpdir(), 'social-learning-'));

try {
  const db = openDatabase(join(dir, 'test.sqlite'));
  const repository = new Repository(db);

  repository.recordProfile({
    handle: 'openai',
    displayName: 'OpenAI',
    profileUrl: 'https://x.com/openai',
    pageUrl: 'https://x.com/openai'
  });

  const result = repository.recordTimelineBatch({
    profileHandle: 'openai',
    items: [
      {
        itemKey: '123',
        itemUrl: 'https://x.com/openai/status/123',
        authorHandle: 'openai',
        authoredAt: '2026-10-20T12:00:00.000Z',
        kind: 'status',
        textContent: 'Learning from public activity patterns.',
        replyCount: 2,
        repostCount: 3,
        likeCount: 5
      }
    ]
  });

  assert.equal(result.observedItems, 1);
  assert.equal(repository.listProfiles().length, 1);
  assert.equal(repository.getProfileSummary('openai').recentItems.length, 1);
  assert.equal(repository.getProfileSummary('openai').recentItems[0].text_content, 'Learning from public activity patterns.');
  assert.equal(repository.listEvents().length, 1);

  console.log('Smoke test passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
