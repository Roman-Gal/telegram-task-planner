import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT, name TEXT NOT NULL, private_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS members (
        chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(chat_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, source_update_id INTEGER UNIQUE NOT NULL,
        chat_id INTEGER NOT NULL, thread_id INTEGER, creator_id INTEGER NOT NULL REFERENCES users(id),
        assignee_id INTEGER NOT NULL REFERENCES users(id), description TEXT NOT NULL,
        due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status,due_at);
      CREATE INDEX IF NOT EXISTS tasks_chat ON tasks(chat_id,status);
      CREATE TABLE IF NOT EXISTS deliveries (
        task_id INTEGER NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
        destination TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_code INTEGER,
        PRIMARY KEY(task_id,generation,destination)
      );
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (update_id INTEGER PRIMARY KEY, result TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  remember(user, chatId, privateEnabled = false) {
    if (!user || user.is_bot) return;
    // Usernames can be reassigned. A newly observed owner supersedes stale cached profiles.
    if (user.username) this.db.prepare('UPDATE users SET username=NULL WHERE username=? AND id<>?').run(user.username.toLowerCase(), user.id);
    this.db.prepare(`INSERT INTO users(id,username,name,private_enabled) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,
      private_enabled=MAX(users.private_enabled,excluded.private_enabled)`)
      .run(user.id, user.username?.toLowerCase() || null, [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id), Number(privateEnabled));
    if (chatId < 0) this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(chatId, user.id);
  }
  findMember(chatId, username) {
    return this.db.prepare(`SELECT u.* FROM users u JOIN members m ON u.id=m.user_id WHERE m.chat_id=? AND u.username=?`).get(chatId, username.toLowerCase());
  }
  privateEnabled(userId) { return Boolean(this.db.prepare('SELECT private_enabled FROM users WHERE id=?').get(userId)?.private_enabled); }
  disablePrivate(userId) { this.db.prepare('UPDATE users SET private_enabled=0 WHERE id=?').run(userId); }
  task(id) {
    return this.db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.id=?`).get(id);
  }
  taskByUpdate(updateId) { const row = this.db.prepare('SELECT id FROM tasks WHERE source_update_id=?').get(updateId); return row ? this.task(row.id) : undefined; }
  createTask({ updateId, chatId, threadId, creatorId, assigneeId, description, dueAt }, now = Date.now()) {
    const existing = this.taskByUpdate(updateId);
    if (existing) return existing;
    const result = this.db.prepare(`INSERT INTO tasks(source_update_id,chat_id,thread_id,creator_id,assignee_id,description,due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(updateId, chatId, threadId ?? null, creatorId, assigneeId, description, dueAt, now, now);
    return this.task(Number(result.lastInsertRowid));
  }
  list({ chatId, assigneeId, offset = 0 }) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('chat_id=?'); params.push(chatId); }
    if (assigneeId) { clauses.push('assignee_id=?'); params.push(assigneeId); }
    return this.db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id
      WHERE status='open' AND ${clauses.join(' AND ')} ORDER BY due_at,t.id LIMIT 11 OFFSET ?`).all(...params, offset);
  }
  previousAction(updateId) {
    const row = this.db.prepare('SELECT result FROM actions WHERE update_id=?').get(updateId);
    return row ? JSON.parse(row.result) : undefined;
  }
  changeTask(taskId, action, updateId, now = Date.now()) {
    return this.transaction(() => {
      const previous = this.previousAction(updateId);
      if (previous) return previous;
      const task = this.task(taskId);
      if (!task || task.status !== 'open') return null;
      if (action === 'snooze') {
        this.db.prepare('UPDATE tasks SET due_at=?,generation=generation+1,updated_at=? WHERE id=?').run(now + 15 * 60_000, now, taskId);
      } else {
        this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(action === 'done' ? 'done' : 'cancelled', now, taskId);
      }
      this.db.prepare("DELETE FROM deliveries WHERE task_id=? AND state='pending'").run(taskId);
      const result = this.task(taskId);
      this.db.prepare('INSERT INTO actions VALUES(?,?)').run(updateId, JSON.stringify(result));
      return result;
    });
  }
  prepareDeliveries(now = Date.now()) {
    this.transaction(() => {
      const tasks = this.db.prepare("SELECT t.*,u.private_enabled FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE status='open' AND due_at<=?").all(now);
      const insert = this.db.prepare('INSERT OR IGNORE INTO deliveries(task_id,generation,destination,chat_id,thread_id,next_attempt_at) VALUES(?,?,?,?,?,?)');
      for (const task of tasks) {
        insert.run(task.id, task.generation, 'chat', task.chat_id, task.thread_id, now);
        if (task.chat_id < 0 && task.private_enabled) insert.run(task.id, task.generation, 'private', task.assignee_id, null, now);
      }
    });
  }
  pendingDeliveries(now = Date.now()) {
    return this.db.prepare(`SELECT d.* FROM deliveries d JOIN tasks t ON t.id=d.task_id
      WHERE d.state='pending' AND d.next_attempt_at<=? AND t.status='open' AND d.generation=t.generation ORDER BY d.next_attempt_at LIMIT 50`).all(now);
  }
  deliveryResult(delivery, code = null, retryAfter = 0, now = Date.now()) {
    const attempts = delivery.attempts + 1;
    const terminal = code !== null && ((code >= 400 && code < 500 && code !== 429) || attempts >= 10);
    this.db.prepare(`UPDATE deliveries SET state=?,attempts=?,next_attempt_at=?,last_code=? WHERE task_id=? AND generation=? AND destination=?`)
      .run(code === null ? 'sent' : terminal ? 'failed' : 'pending', attempts,
        now + Math.max(retryAfter * 1000, Math.min(3_600_000, 5000 * 2 ** Math.min(attempts, 10))), code,
        delivery.task_id, delivery.generation, delivery.destination);
  }
  enqueue(update, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO updates(id,payload,received_at) VALUES(?,?,?)').run(update.update_id, JSON.stringify(update), now);
  }
  nextUpdate(now = Date.now()) {
    return this.db.prepare("SELECT * FROM updates WHERE state='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1").get(now);
  }
  finishUpdate(id, code = null, retryAfter = 0, now = Date.now()) {
    const row = this.db.prepare('SELECT attempts FROM updates WHERE id=?').get(id);
    const attempts = row.attempts + 1;
    const terminal = code === null || (code >= 400 && code < 500 && code !== 429) || attempts >= 8;
    this.db.prepare('UPDATE updates SET state=?,payload=CASE WHEN ? THEN ? ELSE payload END,attempts=?,next_attempt_at=? WHERE id=?')
      .run(terminal ? code === null ? 'done' : 'failed' : 'pending', Number(terminal), '{}', attempts,
        now + Math.max(retryAfter * 1000, Math.min(300_000, 1000 * 2 ** attempts)), id);
  }
}
