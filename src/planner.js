import { parseWhen, formatWhen } from './time.js';
import { TelegramError } from './telegram.js';

export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const mention = task => `<a href="tg://user?id=${task.assignee_id}">${escapeHtml(task.assignee_name)}</a>`;
const buttons = task => ({ inline_keyboard: [[
  { text: '✅ Виконано', callback_data: `done:${task.id}` },
  { text: '⏰ +15 хв', callback_data: `snooze:${task.id}` },
], [{ text: '✖️ Скасувати', callback_data: `cancel:${task.id}` }]] });

export class Planner {
  constructor(store, telegram, config, log = console) {
    this.store = store; this.telegram = telegram; this.config = config; this.log = log;
    this.username = ''; this.draining = false; this.reminding = false; this.stopping = false;
  }
  allowed(chatId) { return chatId > 0 || !this.config.allowedChatIds.size || this.config.allowedChatIds.has(chatId); }
  help() {
    return `📋 <b>Планнер завдань</b>\n\n` +
      `1. Кожен учасник пише /join у групі.\n2. Для особистих нагадувань відкрийте бота та натисніть /start.\n\n` +
      `<b>Призначити завдання:</b>\n<code>/task @username | завтра 18:30 | Купити масло, хліб, воду</code>\n\n` +
      `Або відповіддю на повідомлення виконавця:\n<code>/task завтра 18:30 | Сходити в Бедронку</code>\n\n` +
      `Собі: <code>/task me | завтра 18:30 | Купити воду</code>\n` +
      `Дати: <code>YYYY-MM-DD HH:mm</code>, <code>сьогодні HH:mm</code>, <code>завтра HH:mm</code>.\n` +
      `Часовий пояс: <b>${escapeHtml(this.config.timezone)}</b>.\n\n` +
      `/tasks — відкриті завдання чату\n/mine — мої завдання\n/done ID — виконано\n/snooze ID — нагадати через 15 хв\n/cancel ID — скасувати\n/stop — вимкнути особисті нагадування\n` +
      `Для наступної сторінки: <code>/tasks 2</code> або <code>/mine 2</code>.\n\n` +
      `Працюємо у групі або в обговоренні каналу. Анонімні повідомлення не підтримуються.`;
  }
  card(task, heading = '📋 Завдання') {
    const status = { open: 'відкрите', done: 'виконано', cancelled: 'скасовано' }[task.status];
    return `<b>${heading} #${task.id}</b>\n👤 ${mention(task)}\n📝 ${escapeHtml(task.description)}\n` +
      `⏰ ${escapeHtml(formatWhen(task.due_at, this.config.timezone))}\nСтатус: ${status}`;
  }
  async handle(update) {
    if (update.callback_query) return this.callback(update);
    const message = update.message;
    if (!message?.text || !message.from || message.from.is_bot || message.sender_chat ||
      !['private', 'group', 'supergroup'].includes(message.chat.type) || !this.allowed(message.chat.id)) return;
    const match = /^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
    if (!match || (match[2] && match[2].toLowerCase() !== this.username.toLowerCase())) return;
    const command = match[1].toLowerCase();
    const args = match[3]?.trim() || '';
    this.store.remember(message.from, message.chat.id);
    const send = (text, extra = {}) => this.telegram.send(message.chat.id, text, {
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), ...extra,
    });
    try {
      switch (command) {
        case 'start':
          this.store.remember(message.from, message.chat.id, message.chat.type === 'private');
          return send(this.help());
        case 'help': return send(this.help());
        case 'join': return send('✅ Вас зареєстровано в цьому чаті. Можна призначати завдання відповіддю на ваше повідомлення або через @username.');
        case 'stop':
          if (message.chat.type !== 'private') throw new UserError('Напишіть /stop в особистому чаті з ботом.');
          this.store.disablePrivate(message.from.id);
          return send('Особисті нагадування вимкнено. Групові залишаються активними. Увімкнути знову: /start.');
        case 'task': {
          const task = await this.createTask(update, message, args);
          let text = this.card(task, '✅ Створено завдання');
          if (message.chat.id < 0 && !this.store.privateEnabled(task.assignee_id)) {
            text += '\n\nℹ️ Виконавець ще не ввімкнув особисті нагадування. Нагадування буде у групі.';
            if (this.username) text += ` <a href="https://t.me/${this.username}?start=reminders">Увімкнути в боті</a>.`;
          }
          return send(text, { reply_markup: buttons(task) });
        }
        case 'tasks':
        case 'mine': {
          const page = args ? Number(args) : 1;
          if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new UserError('Номер сторінки має бути від 1 до 10000.');
          const personal = message.chat.type === 'private';
          const tasks = this.store.list({ chatId: personal ? undefined : message.chat.id,
            assigneeId: command === 'mine' || personal ? message.from.id : undefined, offset: (page - 1) * 10 });
          if (!tasks.length) return send('Відкритих завдань на цій сторінці немає.');
          const lines = tasks.slice(0, 10).map(t => `<b>#${t.id}</b> ${mention(t)} — ${escapeHtml(t.description.slice(0, 100))}\n⏰ ${escapeHtml(formatWhen(t.due_at, this.config.timezone))}`);
          return send(`<b>📋 Завдання · сторінка ${page}</b>\n\n${lines.join('\n\n')}` + (tasks.length > 10 ? `\n\nДалі: /${command} ${page + 1}` : ''));
        }
        case 'done': case 'cancel': case 'snooze': {
          const task = this.act(Number(args), command, update.update_id, message.from.id, message.chat.id);
          return send(this.card(task, command === 'snooze' ? '⏰ Відкладено на 15 хв' : '📋 Оновлено завдання'),
            task.status === 'open' ? { reply_markup: buttons(task) } : {});
        }
        default: return send('Невідома команда. /help — довідка.');
      }
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (error instanceof UserError) return send(`ℹ️ ${escapeHtml(error.message)}`);
      throw error;
    }
  }
  async createTask(update, message, args) {
    const existing = this.store.taskByUpdate(update.update_id);
    if (existing) return existing;
    const fields = args.split('|').map(x => x.trim());
    let target, when, description;
    if (fields.length === 3) [target, when, description] = fields;
    else if (fields.length === 2 && message.reply_to_message) [when, description] = fields;
    else throw new UserError('Формат: /task @username | завтра 18:30 | Опис. Або відповіддю: /task завтра 18:30 | Опис.');
    if (!description || description.length > 1200) throw new UserError('Опис має містити від 1 до 1200 символів.');
    let assignee;
    if (['me', 'я'].includes(target?.toLowerCase())) assignee = message.from;
    else if (!target) {
      const reply = message.reply_to_message;
      if (reply.sender_chat) throw new UserError('Неможливо призначити завдання анонімному автору.');
      assignee = reply.from;
    } else {
      if (message.chat.type === 'private') throw new UserError('Завдання іншій людині створюйте у спільній групі.');
      if (!/^@[a-zA-Z0-9_]{1,32}$/.test(target)) throw new UserError('Вкажіть @username, me або створіть завдання відповіддю на повідомлення.');
      const member = this.store.findMember(message.chat.id, target.slice(1));
      if (!member) throw new UserError('Нехай виконавець напише /join у цій групі. Або створіть завдання відповіддю на його повідомлення.');
      let current;
      try { current = await this.telegram.call('getChatMember', { chat_id: message.chat.id, user_id: member.id }); }
      catch (error) {
        if (error.code === 400 || error.code === 403) throw new UserError('Не вдалося перевірити учасника. Дайте боту права адміністратора або використайте відповідь на повідомлення.');
        throw error;
      }
      if (['left', 'kicked'].includes(current.status) || (current.status === 'restricted' && !current.is_member) || current.user.username?.toLowerCase() !== target.slice(1).toLowerCase()) {
        throw new UserError('Виконавець змінив username або вийшов із групи. Попросіть його знову написати /join.');
      }
      assignee = current.user;
    }
    if (!assignee || assignee.is_bot) throw new UserError('Виконавцем має бути людина з видимим профілем.');
    if (message.chat.type === 'private' && assignee.id !== message.from.id) throw new UserError('У приватному чаті можна створювати завдання лише собі.');
    let dueAt;
    try { dueAt = parseWhen(when, this.config.timezone); } catch (error) { throw new UserError(error.message); }
    this.store.remember(assignee, message.chat.id);
    return this.store.createTask({ updateId: update.update_id, chatId: message.chat.id,
      threadId: message.message_thread_id, creatorId: message.from.id, assigneeId: assignee.id, description, dueAt });
  }
  act(id, action, updateId, userId, chatId) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('Вкажіть числовий ID завдання: /done 1.');
    const task = this.store.task(id);
    if (!task || !this.allowed(task.chat_id) || (chatId < 0 && task.chat_id !== chatId) ||
      (task.creator_id !== userId && task.assignee_id !== userId)) throw new UserError('Завдання не знайдено або у вас немає доступу.');
    const previous = this.store.previousAction(updateId);
    if (previous) return previous;
    if (task.status !== 'open') throw new UserError('Це завдання вже завершене або скасоване.');
    return this.store.changeTask(id, action, updateId);
  }
  async callback(update) {
    const q = update.callback_query;
    if (!q.from || q.from.is_bot || !q.message?.chat || !this.allowed(q.message.chat.id)) return;
    const match = /^(done|cancel|snooze):(\d+)$/.exec(q.data || '');
    if (!match) return;
    let task;
    try { task = this.act(Number(match[2]), match[1], update.update_id, q.from.id, q.message.chat.id); }
    catch (error) {
      if (!(error instanceof UserError)) throw error;
      try { await this.telegram.call('answerCallbackQuery', { callback_query_id: q.id, text: error.message, show_alert: true }); } catch { /* expired callback */ }
      return;
    }
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Збережено ✅' }); } catch { /* expired callback */ }
    return this.telegram.send(q.message.chat.id, this.card(task, match[1] === 'snooze' ? '⏰ Відкладено на 15 хв' : '📋 Оновлено завдання'), {
      ...(q.message.message_thread_id ? { message_thread_id: q.message.message_thread_id } : {}),
      ...(task.status === 'open' ? { reply_markup: buttons(task) } : {}),
    });
  }
  async drain() {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      for (let count = 0; count < 50 && !this.stopping; count++) {
        const row = this.store.nextUpdate();
        if (!row) break;
        try { await this.handle(JSON.parse(row.payload)); this.store.finishUpdate(row.id); }
        catch (error) {
          const code = error instanceof TelegramError ? error.code : 500;
          this.store.finishUpdate(row.id, code, error.retryAfter);
          this.log.warn(`Update ${row.id}: failure code ${code}; retry policy applied.`);
        }
      }
    } finally { this.draining = false; }
  }
  async remind(now = Date.now()) {
    if (this.reminding || this.stopping) return;
    this.reminding = true;
    try {
      this.store.prepareDeliveries(now);
      for (const delivery of this.store.pendingDeliveries(now)) {
        if (this.stopping) break;
        const task = this.store.task(delivery.task_id);
        if (!task || task.status !== 'open' || task.generation !== delivery.generation || !this.allowed(task.chat_id)) continue;
        if (delivery.destination === 'private' && !this.store.privateEnabled(task.assignee_id)) {
          this.store.deliveryResult(delivery, 403); continue;
        }
        try {
          await this.telegram.send(delivery.chat_id, this.card(task, '🔔 Нагадування'), {
            ...(delivery.thread_id ? { message_thread_id: delivery.thread_id } : {}), reply_markup: buttons(task),
          });
          this.store.deliveryResult(delivery);
        } catch (error) {
          const code = error instanceof TelegramError ? error.code : 500;
          this.store.deliveryResult(delivery, code, error.retryAfter);
          if (delivery.destination === 'private' && code === 403) this.store.disablePrivate(task.assignee_id);
          this.log.warn(`Reminder ${task.id}/${delivery.destination}: failure code ${code}; retry policy applied.`);
        }
      }
    } finally { this.reminding = false; }
  }
}

class UserError extends Error {}
