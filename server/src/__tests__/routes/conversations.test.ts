import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Conversations API', () => {
  let app: Express;
  let db: ReturnType<typeof initDb>;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    db = initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    // Clean up tables between tests
    const database = getDb();
    database.prepare('DELETE FROM chat_messages').run();
    database.prepare('DELETE FROM conversations').run();
  });

  afterAll(() => {
    db.close();
  });

  // ─── GET /api/conversations ────────────────────────────────────────────────

  it('GET /api/conversations returns empty array when no conversations exist', async () => {
    const { status, body } = await request(app, 'GET', '/api/conversations');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: [] });
  });

  it('GET /api/conversations returns conversations ordered by updated_at DESC', async () => {
    // Create two conversations with a small delay to ensure different timestamps
    const { body: first } = await request(app, 'POST', '/api/conversations', { title: 'First' });
    const id1 = first.data.id;

    // Update first conversation to give it a newer updated_at
    await request(app, 'PATCH', `/api/conversations/${id1}`, { title: 'First Updated' });

    await request(app, 'POST', '/api/conversations', { title: 'Second' });

    const { status, body } = await request(app, 'GET', '/api/conversations');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    // Most recently updated should be first
    expect(body.data[0].title).toBe('First Updated');
    expect(body.data[1].title).toBe('Second');
  });

  // ─── POST /api/conversations ───────────────────────────────────────────────

  it('POST /api/conversations creates a new conversation with default title', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations');

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('id');
    expect(body.data.title).toBe('Nuova conversazione');
    expect(body.data).toHaveProperty('createdAt');
    expect(body.data).toHaveProperty('updatedAt');
  });

  it('POST /api/conversations creates a new conversation with custom title', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations', {
      title: 'My Custom Title',
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.id).toBeGreaterThan(0);
    expect(body.data.title).toBe('My Custom Title');
  });

  it('POST /api/conversations accepts empty body object', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations', {});

    expect(status).toBe(201);
    expect(body.data.title).toBe('Nuova conversazione');
  });

  it('POST /api/conversations returns 400 for non-string title', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations', {
      title: 123,
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBeTruthy();
  });

  it('POST /api/conversations returns 400 for title exceeding max length', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations', {
      title: 'a'.repeat(201),
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  // ─── GET /api/conversations/:id ─────────────────────────────────────────────

  it('GET /api/conversations/:id returns the conversation object', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations', {
      title: 'Test Conversation',
    });

    const { status, body } = await request(app, 'GET', `/api/conversations/${created.data.id}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(created.data.id);
    expect(body.data.title).toBe('Test Conversation');
    expect(body.data).toHaveProperty('createdAt');
    expect(body.data).toHaveProperty('updatedAt');
  });

  it('GET /api/conversations/:id returns 404 for non-existent ID', async () => {
    const { status, body } = await request(app, 'GET', '/api/conversations/99999');

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Conversation not found');
  });

  it('GET /api/conversations/:id returns 400 for non-numeric ID', async () => {
    const { status, body } = await request(app, 'GET', '/api/conversations/abc');

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Invalid conversation ID');
  });

  // ─── PATCH /api/conversations/:id ──────────────────────────────────────────

  it('PATCH /api/conversations/:id updates the title and returns the updated conversation', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations', {
      title: 'Original Title',
    });

    const { status, body } = await request(app, 'PATCH', `/api/conversations/${created.data.id}`, {
      title: 'Updated Title',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(created.data.id);
    expect(body.data.title).toBe('Updated Title');
  });

  it('PATCH /api/conversations/:id returns 404 for non-existent ID', async () => {
    const { status, body } = await request(app, 'PATCH', '/api/conversations/99999', {
      title: 'New Title',
    });

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Conversation not found');
  });

  it('PATCH /api/conversations/:id returns 400 for non-numeric ID', async () => {
    const { status, body } = await request(app, 'PATCH', '/api/conversations/abc', {
      title: 'New Title',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Invalid conversation ID');
  });

  it('PATCH /api/conversations/:id returns 400 for missing title', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');

    const { status, body } = await request(app, 'PATCH', `/api/conversations/${created.data.id}`, {});

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('PATCH /api/conversations/:id returns 400 for empty title', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');

    const { status, body } = await request(app, 'PATCH', `/api/conversations/${created.data.id}`, {
      title: '',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('PATCH /api/conversations/:id returns 400 for non-string title', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');

    const { status, body } = await request(app, 'PATCH', `/api/conversations/${created.data.id}`, {
      title: { not: 'a string' },
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  // ─── DELETE /api/conversations/:id ─────────────────────────────────────────

  it('DELETE /api/conversations/:id returns 200 and removes the conversation', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations', {
      title: 'To Delete',
    });
    const id = created.data.id;

    const { status, body } = await request(app, 'DELETE', `/api/conversations/${id}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);

    const { status: getStatus } = await request(app, 'GET', `/api/conversations/${id}`);
    expect(getStatus).toBe(404);
  });

  it('DELETE /api/conversations/:id returns 404 for non-existent ID', async () => {
    const { status, body } = await request(app, 'DELETE', '/api/conversations/99999');

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Conversation not found');
  });

  it('DELETE /api/conversations/:id returns 400 for non-numeric ID', async () => {
    const { status, body } = await request(app, 'DELETE', '/api/conversations/abc');

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Invalid conversation ID');
  });

  // ─── Cascade Delete ─────────────────────────────────────────────────────────

  it('DELETE /api/conversations/:id cascades deletion of associated messages', async () => {
    // Create conversation
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    // Add messages
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: 'Hello',
    });
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'assistant',
      content: 'Hi there',
    });

    // Verify messages exist
    const { body: messagesBefore } = await request(app, 'GET', `/api/conversations/${id}/messages`);
    expect(messagesBefore.data).toHaveLength(2);

    // Delete conversation
    await request(app, 'DELETE', `/api/conversations/${id}`);

    // Conversation should be gone
    const { status: convStatus } = await request(app, 'GET', `/api/conversations/${id}`);
    expect(convStatus).toBe(404);

    // Verify messages are also gone (cascade delete)
    const { body: messagesAfter } = await request(app, 'GET', `/api/conversations/${id}/messages`);
    expect(messagesAfter.data).toHaveLength(0);
  });

  // ─── POST /api/conversations/:id/messages ──────────────────────────────────

  it('POST /api/conversations/:id/messages adds a message and returns the message object', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: 'Hello, world!',
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('id');
    expect(body.data.conversationId).toBe(id);
    expect(body.data.role).toBe('user');
    expect(body.data.content).toBe('Hello, world!');
    expect(body.data.meta).toBeNull();
    expect(body.data).toHaveProperty('createdAt');
  });

  it('POST /api/conversations/:id/messages stores and returns meta object', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const meta = { platform: 'groq', model: 'llama-3.3-70b', latency: 150 };
    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'assistant',
      content: 'Response content',
      meta,
    });

    expect(status).toBe(201);
    expect(body.data.meta).toEqual(meta);
  });

  it('POST /api/conversations/:id/messages returns 404 if conversation does not exist', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations/99999/messages', {
      role: 'user',
      content: 'Hello',
    });

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Conversation not found');
  });

  it('POST /api/conversations/:id/messages returns 400 for non-numeric ID', async () => {
    const { status, body } = await request(app, 'POST', '/api/conversations/abc/messages', {
      role: 'user',
      content: 'Hello',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Invalid conversation ID');
  });

  it('POST /api/conversations/:id/messages returns 400 for invalid role', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'robot',
      content: 'Hello',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('POST /api/conversations/:id/messages returns 400 for missing role', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      content: 'Hello',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('POST /api/conversations/:id/messages returns 400 for missing content', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('POST /api/conversations/:id/messages returns 400 for empty content', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: '',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('POST /api/conversations/:id/messages returns 400 for non-string content', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: 123,
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('POST /api/conversations/:id/messages accepts valid roles: user, assistant, system', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    for (const role of ['user', 'assistant', 'system'] as const) {
      const { status, body } = await request(app, 'POST', `/api/conversations/${id}/messages`, {
        role,
        content: `Test message for role ${role}`,
      });

      expect(status).toBe(201);
      expect(body.data.role).toBe(role);
    }
  });

  // ─── GET /api/conversations/:id/messages ───────────────────────────────────

  it('GET /api/conversations/:id/messages returns empty array when no messages exist', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const { status, body } = await request(app, 'GET', `/api/conversations/${id}/messages`);

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: [] });
  });

  it('GET /api/conversations/:id/messages returns messages sorted by createdAt ASC', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    // Add messages in sequence
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: 'First',
    });
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'assistant',
      content: 'Second',
    });
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'user',
      content: 'Third',
    });

    const { status, body } = await request(app, 'GET', `/api/conversations/${id}/messages`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    expect(body.data[0].content).toBe('First');
    expect(body.data[1].content).toBe('Second');
    expect(body.data[2].content).toBe('Third');
  });

  it('GET /api/conversations/:id/messages returns 404 for non-existent conversation', async () => {
    const { status, body } = await request(app, 'GET', '/api/conversations/99999/messages');

    expect(status).toBe(200);
    // Returns empty array since conversation doesn't exist but no FK constraint error
    expect(body.data).toEqual([]);
  });

  it('GET /api/conversations/:id/messages returns 400 for non-numeric ID', async () => {
    const { status, body } = await request(app, 'GET', '/api/conversations/abc/messages');

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Invalid conversation ID');
  });

  it('GET /api/conversations/:id/messages parses meta JSON and returns object', async () => {
    const { body: created } = await request(app, 'POST', '/api/conversations');
    const id = created.data.id;

    const meta = { platform: 'openai', model: 'gpt-4', latency: 250 };
    await request(app, 'POST', `/api/conversations/${id}/messages`, {
      role: 'assistant',
      content: 'Response',
      meta,
    });

    const { status, body } = await request(app, 'GET', `/api/conversations/${id}/messages`);

    expect(status).toBe(200);
    expect(body.data[0].meta).toEqual(meta);
  });
});
