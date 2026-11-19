import { parseWhen, localDate, addDays } from './time.js';
import { escapeHtml, priorities, UserError } from './ui.js';

const splitRows = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
const todayIn = zone => localDate(Date.now(), zone);

export class Wizard {
  constructor(planner) { this.p = planner; this.store = planner.store; }
  async start(updateId, user, chatId, threadId = 0, replyUser = null) {
    this.store.remember(user, chatId);
    await this.p.syncAdministrators(chatId);
    let draft = this.store.beginDraft(updateId, user, chatId, threadId);
    if (replyUser && !replyUser.is_bot && (chatId < 0 || replyUser.id === user.id) && draft.stage === 'assignee' && draft.revision === 0) {
      this.store.remember(replyUser, chatId);
      draft = this.store.transitionDraft(draft.id, 0, updateId, d => {
        d.assigneeId = replyUser.id;
        d.assigneeName = [replyUser.first_name, replyUser.last_name].filter(Boolean).join(' ') || String(replyUser.id);
        d.stage = 'date';
      });
    }
    return this.render(draft);
  }
  button(draft, text, action, value = '') {
    return { text, callback_data: `w:${draft.id}:${draft.revision}:${action}:${value}` };
  }
  async panel(draft, text, rows) {
    const reply_markup = { inline_keyboard: rows };
    if (draft.panelId) {
      try {
        await this.p.telegram.call('editMessageText', { chat_id: draft.chatId, message_id: draft.panelId, text, parse_mode: 'HTML', reply_markup });
        return;
      } catch (error) { if (error.code !== 400) throw error; }
    }
    const result = await this.p.telegram.send(draft.chatId, text, { reply_markup, ...(draft.threadId ? { message_thread_id: draft.threadId } : {}) });
    this.store.setDraftPanel(draft.id, draft.revision, result.message_id);
  }
  async prompt(draft, text, placeholder) {
    const previous = draft.stage === 'search' ? 'assignee' : 'hour';
    await this.panel(draft, `➕ <b>Нове завдання</b>\n\n${escapeHtml(draft.userName)}, ${text}\nВідповідайте на окремий запит бота нижче.`, [
      [this.button(draft, '⬅️ Назад', 'goto', previous)], [this.button(draft, '✖️ Скасувати', 'cancel')],
    ]);
    if (draft.promptId) return;
    const result = await this.p.telegram.send(draft.chatId,
      `<a href="tg://user?id=${draft.userId}">${escapeHtml(draft.userName)}</a>, ${text}\n\nВідповідайте саме на це повідомлення. /cancel — скасувати чернетку.`, {
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: placeholder },
        ...(draft.threadId ? { message_thread_id: draft.threadId } : {}),
      });
    this.store.setDraftPrompt(draft.id, draft.revision, result.message_id);
  }
  async clearPanel(chatId, panelId) {
    if (!panelId) return;
    try { await this.p.telegram.call('editMessageReplyMarkup', { chat_id: chatId, message_id: panelId, reply_markup: { inline_keyboard: [] } }); }
    catch { /* A deleted or already edited old panel must not block the current step. */ }
  }
  async render(snapshot) {
    const current = this.store.draft(snapshot.id);
    if (!current || current.revision > snapshot.revision) return;
    const d = current;
    const b = (text, action, value) => this.button(d, text, action, value);
    const owner = `<a href="tg://user?id=${d.userId}">${escapeHtml(d.userName)}</a>`;
    const title = `➕ <b>Нове завдання</b> · ${owner}\n\n`;
    const footer = previous => [...(previous ? [[b('⬅️ Назад', 'goto', previous)]] : []), [b('✖️ Скасувати', 'cancel')]];
    switch (d.stage) {
      case 'assignee': {
        const users = d.chatId > 0 ? [{ id: d.userId, name: d.userName }] : this.store.members(d.chatId, d.search || '', d.memberPage || 0);
        const rows = users.slice(0, 8).map(u => [b(`${u.id === d.userId ? '👤 Собі · ' : '👤 '}${u.name.slice(0, 40)}${u.username ? ' @' + u.username : ''}`, 'user', String(u.id))]);
        const navigation = [];
        if (d.memberPage > 0) navigation.push(b('◀️', 'page', String(d.memberPage - 1)));
        if (users.length > 8) navigation.push(b('▶️', 'page', String((d.memberPage || 0) + 1)));
        if (navigation.length) rows.push(navigation);
        if (d.chatId < 0) rows.push([b('🔎 Знайти за іменем', 'search'), b('Усі учасники', 'all')]);
        return this.panel(d, title + '<b>1/7 · Хто виконавець?</b>\n' + (users.length ? 'Оберіть людину кнопкою.' : 'Нікого не знайдено.') + '\nСписок оновлюється автоматично з доступних боту повідомлень і дій учасників. Також можна запустити /task відповіддю на повідомлення виконавця.', [...rows, ...footer()]);
      }
      case 'search': return this.prompt(d, 'напишіть ім’я або username виконавця.', 'Ім’я або username');
      case 'date': {
        const today = todayIn(this.p.config.timezone);
        const month = d.month || today.slice(0, 7);
        const [year, monthNumber] = month.split('-').map(Number);
        const first = new Date(Date.UTC(year, monthNumber - 1, 1, 12));
        const label = new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first);
        const cells = Array.from({ length: (first.getUTCDay() + 6) % 7 }, () => b('·', 'noop'));
        const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
        for (let day = 1; day <= length; day++) {
          const key = `${month}-${String(day).padStart(2, '0')}`;
          cells.push(key < today ? b('·', 'noop') : b(String(day), 'day', key.replaceAll('-', '')));
        }
        while (cells.length % 7) cells.push(b('·', 'noop'));
        return this.panel(d, title + `<b>2/7 · Оберіть дату</b>\n${escapeHtml(label)}\nЧасовий пояс: ${escapeHtml(this.p.config.timezone)}`, [
          [b('Сьогодні', 'day', today.replaceAll('-', '')), b('Завтра', 'day', addDays(today, 1).replaceAll('-', ''))],
          ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].map(day => b(day, 'noop')),
          ...splitRows(cells, 7), [b('◀️ Місяць', 'month', '-1'), b('Місяць ▶️', 'month', '1')], ...footer('assignee'),
        ]);
      }
      case 'hour': return this.panel(d, title + `<b>3/7 · Година · ${d.date}</b>`, [
        ...splitRows(Array.from({ length: 24 }, (_, hour) => b(`${String(hour).padStart(2, '0')}:··`, 'hour', String(hour))), 4),
        [b('⌨️ Ввести час HH:mm', 'custom')], ...footer('date'),
      ]);
      case 'minute': return this.panel(d, title + `<b>3/7 · Хвилини · ${d.date} ${d.hour}:··</b>`, [
        ...splitRows(Array.from({ length: 12 }, (_, i) => b(`${d.hour}:${String(i * 5).padStart(2, '0')}`, 'minute', String(i * 5))), 3),
        [b('⌨️ Ввести точний час', 'custom')], ...footer('hour'),
      ]);
      case 'timeText': return this.prompt(d, `введіть час для ${d.date} у форматі HH:mm.`, 'Наприклад, 18:37');
      case 'description': return this.prompt(d, 'напишіть текст завдання (до 1200 символів).', 'Що потрібно зробити?');
      case 'priority': return this.panel(d, title + '<b>5/7 · Пріоритет завдання</b>', [
        ...Object.entries(priorities).map(([value, label]) => [b(label, 'priority', value)]), ...footer('description'),
      ]);
      case 'reminders': return this.panel(d, title + '<b>6/7 · За скільки нагадати?</b>\nМожна вибрати кілька варіантів.\nУ строк виконання та далі кожні 15 хв — повідомлення про прострочення.', [
        ...splitRows([5,15,30,60].map(m => b(`${d.reminderMinutes.includes(m) ? '✅' : '⬜'} ${m === 60 ? '1 година' : m + ' хв'}`, 'toggle', String(m))), 2),
        [b('Без завчасних нагадувань', 'none')], [b('Далі ➡️', 'next')], ...footer('priority'),
      ]);
      case 'confirm': {
        const task = { ...d, id: 'чернетка', assignee_id: d.assigneeId, assignee_name: d.assigneeName, due_at: d.dueAt, reminder_minutes: JSON.stringify(d.reminderMinutes), status: 'open' };
        let note = '\n\nНагадування: у групу та особисто виконавцю.';
        if (d.chatId < 0 && !this.store.privateEnabled(d.assigneeId)) note += '\n⚠️ Для приватних нагадувань виконавець має відкрити бота й натиснути /start.';
        return this.panel(d, '<b>7/7 · Перевірте завдання</b>\n\n' + this.p.card(task) + note, [
          [b('✅ Створити', 'create')], [b('👤 Виконавець', 'goto', 'assignee'), b('📅 Дата', 'goto', 'date')],
          [b('🕒 Час', 'goto', 'hour'), b('📝 Опис', 'goto', 'description')],
          [b('🚦 Пріоритет', 'goto', 'priority'), b('🔔 Нагадування', 'goto', 'reminders')], ...footer(),
        ]);
      }
      case 'created': return this.panel(d, this.p.card(this.store.task(d.taskId), '✅ Створено завдання'), this.p.taskButtons(this.store.task(d.taskId)).inline_keyboard);
      case 'cancelled': return this.panel(d, 'Чернетку скасовано.', this.p.menuButtons().inline_keyboard);
    }
  }
  async callback(update) {
    const q = update.callback_query;
    const match = /^w:([a-f0-9]{12}):(\d+):([a-z]+):([\w-]*)$/.exec(q.data || '');
    if (!match) return false;
    const [, id, revText, action, value] = match;
    const d = this.store.draft(id);
    if (!d || d.chatId !== q.message.chat.id || d.threadId !== (q.message.message_thread_id || 0)) throw new UserError('Чернетка застаріла. Відкрийте /menu → Нове завдання.');
    if (d.userId !== q.from.id) throw new UserError('Цю чернетку створює інша людина. Відкрийте власну через /menu.');
    const receipt = this.store.draftReceipt(update.update_id);
    if (receipt) { await this.p.answer(q.id); await this.render(receipt); return true; }
    if (d.revision !== Number(revText) || ['created','cancelled'].includes(d.stage)) {
      await this.p.answer(q.id, d.stage === 'created' ? 'Завдання вже створене.' : d.stage === 'cancelled' ? 'Чернетку вже скасовано.' : 'Показую актуальний крок. Попередню дію не повторено.');
      await this.render(d);
      return true;
    }
    if (action === 'noop') { await this.p.answer(q.id); return true; }
    const next = this.store.transitionDraft(id, Number(revText), update.update_id, draft => {
      const requireStage = (...stages) => { if (!stages.includes(draft.stage)) throw new UserError('Поверніться до поточного кроку.'); };
      if (action === 'cancel') { draft.stage = 'cancelled'; return; }
      if (action === 'goto') {
        if (!['assignee','date','hour','description','priority','reminders'].includes(value)) throw new UserError('Невідомий крок.');
        if (value !== 'assignee' && !draft.assigneeId) throw new UserError('Спочатку оберіть виконавця.');
        if (['hour','description','priority','reminders'].includes(value) && !draft.date) throw new UserError('Спочатку оберіть дату.');
        draft.stage = value; return;
      }
      switch (action) {
        case 'user': {
          requireStage('assignee');
          const user = draft.chatId > 0 ? (Number(value) === draft.userId ? { id: draft.userId, name: draft.userName } : null) : this.store.member(draft.chatId, Number(value));
          if (!user) throw new UserError('Учасника більше немає у списку. Оберіть іншу людину або створіть завдання відповіддю на повідомлення.');
          draft.assigneeId = user.id; draft.assigneeName = user.name; draft.stage = 'date'; break;
        }
        case 'page': requireStage('assignee'); if (!/^\d{1,4}$/.test(value)) throw new UserError('Некоректна сторінка.'); draft.memberPage = Number(value); break;
        case 'search': requireStage('assignee'); draft.stage = 'search'; break;
        case 'all': requireStage('assignee'); draft.search = ''; draft.memberPage = 0; break;
        case 'month': {
          requireStage('date');
          if (!['-1','1'].includes(value)) throw new UserError('Некоректний місяць.');
          const today = todayIn(this.p.config.timezone);
          const [year, month] = (draft.month || today.slice(0,7)).split('-').map(Number);
          const next = new Date(Date.UTC(year, month - 1 + Number(value), 1, 12)).toISOString().slice(0,7);
          if (next < today.slice(0,7) || next > addDays(today, 730).slice(0,7)) throw new UserError('Оберіть місяць у межах наступних двох років.');
          draft.month = next; break;
        }
        case 'day': {
          requireStage('date');
          if (!/^\d{8}$/.test(value)) throw new UserError('Некоректна дата.');
          const date = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
          if (date < todayIn(this.p.config.timezone)) throw new UserError('Ця дата вже минула.');
          try { parseWhen(`${date} 23:59`, this.p.config.timezone); } catch (error) { throw new UserError(error.message); }
          draft.date = date; draft.stage = 'hour'; break;
        }
        case 'hour': requireStage('hour'); if (!/^\d{1,2}$/.test(value) || Number(value) > 23) throw new UserError('Некоректна година.'); draft.hour = value.padStart(2,'0'); draft.stage = 'minute'; break;
        case 'minute':
          requireStage('minute');
          if (!/^\d{1,2}$/.test(value) || Number(value) > 59) throw new UserError('Некоректна хвилина.');
          try { draft.dueAt = parseWhen(`${draft.date} ${draft.hour}:${value.padStart(2,'0')}`, this.p.config.timezone); } catch (error) { throw new UserError(error.message); }
          draft.stage = 'description'; break;
        case 'custom': requireStage('hour','minute'); draft.stage = 'timeText'; break;
        case 'priority': requireStage('priority'); if (!priorities[value]) throw new UserError('Невідомий пріоритет.'); draft.priority = value; draft.stage = 'reminders'; break;
        case 'toggle': {
          requireStage('reminders'); const minutes = Number(value);
          if (![5,15,30,60].includes(minutes)) throw new UserError('Невідомий інтервал.');
          draft.reminderMinutes = draft.reminderMinutes.includes(minutes) ? draft.reminderMinutes.filter(m => m !== minutes) : [...draft.reminderMinutes, minutes].sort((a,b) => a-b); break;
        }
        case 'none': requireStage('reminders'); draft.reminderMinutes = []; break;
        case 'next': requireStage('reminders'); draft.stage = 'confirm'; break;
        case 'create': {
          requireStage('confirm');
          if (!draft.assigneeId || !draft.description || !draft.dueAt || draft.dueAt <= Date.now()) throw new UserError('Перевірте виконавця, опис та час: строк має бути в майбутньому.');
          const task = this.store.createTask({ updateId: update.update_id, chatId: draft.chatId, threadId: draft.threadId || undefined,
            creatorId: draft.userId, assigneeId: draft.assigneeId, description: draft.description, dueAt: draft.dueAt,
            priority: draft.priority, reminderMinutes: draft.reminderMinutes });
          draft.taskId = task.id; draft.stage = 'created'; break;
        }
        default: throw new UserError('Невідома кнопка.');
      }
    });
    if (!next) throw new UserError('Крок уже змінився. Використайте останні кнопки.');
    await this.p.answer(q.id);
    await this.render(next);
    return true;
  }
  async text(update, message) {
    const previous = this.store.draftReceipt(update.update_id);
    if (previous && previous.userId === message.from.id && previous.chatId === message.chat.id) { await this.render(previous); return; }
    const d = this.store.replyDraft(message.chat.id, message.from.id, message.message_thread_id || 0, message.reply_to_message?.message_id);
    if (!d || !['search','timeText','description'].includes(d.stage)) return;
    const text = message.text.trim();
    const next = this.store.transitionDraft(d.id, d.revision, update.update_id, draft => {
      if (draft.stage === 'description') {
        if (!text || text.length > 1200) throw new UserError('Опис має містити від 1 до 1200 символів. Спробуйте ще раз відповіддю на запит бота.');
        draft.description = text; draft.stage = 'priority';
      } else if (draft.stage === 'timeText') {
        try { draft.dueAt = parseWhen(`${draft.date} ${text}`, this.p.config.timezone); } catch (error) { throw new UserError(error.message + ' Спробуйте ще раз відповіддю на запит бота.'); }
        draft.hour = text.slice(0,2); draft.stage = 'description';
      } else {
        if (text.length > 80) throw new UserError('Для пошуку введіть до 80 символів.');
        draft.search = text.replace(/^@/, ''); draft.memberPage = 0; draft.stage = 'assignee';
      }
      delete draft.panelId;
    });
    if (next) {
      await this.clearPanel(d.chatId, d.panelId);
      await this.render(next);
    }
  }
  async cancel(updateId, userId, chatId, threadId = 0) {
    const draft = this.store.activeDraft(chatId, userId, threadId);
    if (!draft || ['created','cancelled'].includes(draft.stage)) throw new UserError('Активної чернетки немає. Для завдання використайте /cancel ID.');
    return this.render(this.store.transitionDraft(draft.id, draft.revision, updateId, d => { d.stage = 'cancelled'; }));
  }
}
