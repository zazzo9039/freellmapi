import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const conversationsRouter = Router();

// Validation schemas
const createConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const updateTitleSchema = z.object({
  title: z.string().min(1).max(200),
});

const createMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
  meta: z.any().optional(),
});

// GET / - list all conversations ordered by updated_at DESC
conversationsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC'
  ).all() as { id: number; title: string; created_at: string; updated_at: string }[];

  const conversations = rows.map(row => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  res.json({ success: true, data: conversations });
});

// POST / - create new conversation
conversationsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const title = parsed.data.title ?? 'Nuova conversazione';
  const db = getDb();
  const result = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title);
  const newId = result.lastInsertRowid as number;

  const conversation = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?'
  ).get(newId) as { id: number; title: string; created_at: string; updated_at: string };

  res.status(201).json({
    success: true,
    data: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
  });
});

// GET /:id - get single conversation
conversationsRouter.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid conversation ID' } });
    return;
  }

  const db = getDb();
  const conversation = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?'
  ).get(id) as { id: number; title: string; created_at: string; updated_at: string } | undefined;

  if (!conversation) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }

  res.json({
    success: true,
    data: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
  });
});

// PATCH /:id - update title
conversationsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid conversation ID' } });
    return;
  }

  const parsed = updateTitleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { title } = parsed.data;
  const db = getDb();
  const result = db.prepare(
    "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }

  const conversation = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?'
  ).get(id) as { id: number; title: string; created_at: string; updated_at: string };

  res.json({
    success: true,
    data: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
  });
});

// DELETE /:id - delete conversation and cascade messages
conversationsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid conversation ID' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }

  res.json({ success: true, data: { deleted: true } });
});

// GET /:id/messages - get messages for conversation
conversationsRouter.get('/:id/messages', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid conversation ID' } });
    return;
  }

  const db = getDb();
  const messages = db.prepare(
    'SELECT id, conversation_id, role, content, meta, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(id) as { id: number; conversation_id: number; role: string; content: string; meta: string | null; created_at: string }[];

  const parsed = messages.map(m => {
    let meta = null;
    if (m.meta) {
      try {
        meta = JSON.parse(m.meta);
      } catch {
        // Invalid JSON, return null
      }
    }
    return {
      id: m.id,
      conversationId: m.conversation_id,
      role: m.role,
      content: m.content,
      meta,
      createdAt: m.created_at,
    };
  });

  res.json({ success: true, data: parsed });
});

// POST /:id/messages - add a message to conversation
conversationsRouter.post('/:id/messages', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid conversation ID' } });
    return;
  }

  const parsed = createMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { role, content, meta } = parsed.data;
  const db = getDb();

  // Verify conversation exists
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  if (!conversation) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }

  // Update conversation's updated_at
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(id);

  const metaStr = meta !== undefined ? (typeof meta === 'object' && meta !== null ? JSON.stringify(meta) : String(meta)) : null;
  const result = db.prepare(
    'INSERT INTO chat_messages (conversation_id, role, content, meta) VALUES (?, ?, ?, ?)'
  ).run(id, role, content, metaStr);

  const message = db.prepare(
    'SELECT id, conversation_id, role, content, meta, created_at FROM chat_messages WHERE id = ?'
  ).get(result.lastInsertRowid) as { id: number; conversation_id: number; role: string; content: string; meta: string | null; created_at: string };

  let parsedMeta = null;
  if (message.meta) {
    try {
      parsedMeta = JSON.parse(message.meta);
    } catch {
      // Invalid JSON, return null
    }
  }

  res.status(201).json({
    success: true,
    data: {
      id: message.id,
      conversationId: message.conversation_id,
      role: message.role,
      content: message.content,
      meta: parsedMeta,
      createdAt: message.created_at,
    },
  });
});
