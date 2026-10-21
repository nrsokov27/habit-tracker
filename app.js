'use strict';

const STORAGE_KEY = 'habit-tracker-v2';
const OLD_STORAGE_KEY = 'habit-tracker-v1';
const CATEGORIES = ['Здоровье', 'Спорт', 'Разум', 'Учёба', 'Дом', 'Другое'];
const MILESTONES = [7, 14, 21, 30, 50, 100, 200, 365, 500, 1000];
const MILESTONE_STEP_AFTER = 500;
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const STATS_WINDOW_DAYS = 30;
const STATS_MIN_WINDOW_DAYS = 7;
const GOOD_RATE = 0.8;
const MID_RATE = 0.5;
const CHART_WEEKS = 8;
const HEAT_DAYS = 35;
const NOTIFY_CHECK_MS = 30 * 60 * 1000;
const TOAST_MS = 3500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_HABITS = [
  { emoji: '💧', name: 'Выпить 2 л воды', category: 'Здоровье', weekly: false },
  { emoji: '🏋️', name: 'Тренировка', category: 'Спорт', weekly: true, target: 3 },
  { emoji: '📖', name: 'Читать 20 минут', category: 'Разум', weekly: false },
  { emoji: '😴', name: 'Лечь спать до 23:00', category: 'Здоровье', weekly: false },
  { emoji: '🧘', name: 'Медитация 10 минут', category: 'Разум', weekly: false },
  { emoji: '🧹', name: 'Уборка дома', category: 'Дом', weekly: true, target: 2 },
];

/* ---------- даты ---------- */

const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
const todayKey = () => dateKey(new Date());
const weekdayIndex = d => (d.getDay() + 6) % 7; // Пн = 0
const mondayOf = d => addDays(d, -weekdayIndex(d));
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
const fmtShort = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

/* ---------- состояние ---------- */

const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function normalizeHabit(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.done)) return null;
  const done = [...new Set(raw.done.filter(k => typeof k === 'string' && DATE_RE.test(k)))];
  const earliest = [...done].sort()[0];
  return {
    id: raw.id,
    emoji: String(raw.emoji || '').slice(0, 4),
    name: raw.name.slice(0, 60),
    category: CATEGORIES.includes(raw.category) ? raw.category : 'Другое',
    weekly: raw.weekly === true,
    target: clamp(parseInt(raw.target, 10) || 3, 1, 7),
    created: typeof raw.created === 'string' && DATE_RE.test(raw.created) ? raw.created : (earliest || todayKey()),
    done,
  };
}

const makeDefaults = () => DEFAULT_HABITS.map(h => normalizeHabit({ ...h, id: makeId(), done: [] }));
const freshState = () => ({ v: 2, habits: makeDefaults(), unlocked: [], lastNotify: '' });

function stateFromHabits(list, extra = {}) {
  const habits = list.map(normalizeHabit).filter(Boolean);
  return habits.length ? { v: 2, habits, unlocked: [], lastNotify: '', ...extra } : null;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const loaded = s && Array.isArray(s.habits) ? stateFromHabits(s.habits, {
        unlocked: Array.isArray(s.unlocked) ? s.unlocked.filter(x => typeof x === 'string') : [],
        lastNotify: typeof s.lastNotify === 'string' ? s.lastNotify : '',
      }) : null;
      if (loaded) return loaded;
    }
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (old) {
      const arr = JSON.parse(old);
      const migrated = Array.isArray(arr) ? stateFromHabits(arr) : null;
      if (migrated) return migrated;
    }
  } catch (e) { /* хранилище недоступно или повреждено — начнём заново */ }
  return freshState();
}

let state = loadState();
let weekOffset = 0;
let activeTab = 'habits';
let activeCategory = 'Все';
let editingId = null;

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { showToast('⚠️ Не удалось сохранить данные в браузере'); }
}

const updateHabits = habits => { state = { ...state, habits }; };

/* ---------- расчёты ---------- */

const weekKeys = monday => Array.from({ length: 7 }, (_, i) => dateKey(addDays(monday, i)));
const countInWeek = (habit, monday) => {
  const keys = new Set(weekKeys(monday));
  return habit.done.filter(k => keys.has(k)).length;
};

function streakOfDays(doneSet) {
  let day = new Date();
  if (!doneSet.has(dateKey(day))) day = addDays(day, -1); // сегодня ещё можно успеть
  let n = 0;
  while (doneSet.has(dateKey(day))) { n++; day = addDays(day, -1); }
  return n;
}

function weekStreak(habit) {
  let monday = mondayOf(new Date());
  let n = 0;
  for (let i = 0; i < 520; i++) {
    if (countInWeek(habit, monday) >= habit.target) n++;
    else if (i > 0) break; // текущая неделя ещё может быть выполнена
    monday = addDays(monday, -7);
  }
  return n;
}

function milestoneRange(total) {
  const next = MILESTONES.find(m => m > total)
    ?? (Math.floor(total / MILESTONE_STEP_AFTER) + 1) * MILESTONE_STEP_AFTER;
  const prev = [0, ...MILESTONES].filter(m => m <= total).pop();
  return { prev: total >= MILESTONES[MILESTONES.length - 1] ? Math.floor(total / MILESTONE_STEP_AFTER) * MILESTONE_STEP_AFTER : prev, next };
}

function getReminders() {
  const today = new Date();
  const daysLeft = 7 - weekdayIndex(today); // включая сегодня
  const monday = mondayOf(today);
  return state.habits
    .filter(h => h.weekly)
    .map(h => ({ habit: h, need: h.target - countInWeek(h, monday), daysLeft }))
    .filter(r => r.need > 0 && r.daysLeft <= r.need + 1);
}

function completionRate(habit) {
  const window = clamp(daysBetween(habit.created, todayKey()) + 1, STATS_MIN_WINDOW_DAYS, STATS_WINDOW_DAYS);
  const from = dateKey(addDays(new Date(), -(window - 1)));
  const count = habit.done.filter(k => k >= from && k <= todayKey()).length;
  const expected = habit.weekly ? habit.target * window / 7 : window;
  return Math.min(1, count / expected);
}

const rateClass = r => (r >= GOOD_RATE ? 'good' : r >= MID_RATE ? 'mid' : 'bad');
const totalChecks = () => state.habits.reduce((s, h) => s + h.done.length, 0);
const activitySet = () => new Set(state.habits.flatMap(h => h.done));

/* ---------- достижения ---------- */

const ACHIEVEMENTS = [
  { id: 'first', icon: '🌱', title: 'Первый шаг', desc: 'Первая отметка', test: () => totalChecks() >= 1 },
  { id: 'c10', icon: '🔟', title: '10 отметок', desc: 'Всего 10 выполнений', test: () => totalChecks() >= 10 },
  { id: 'c50', icon: '💪', title: '50 отметок', desc: 'Всего 50 выполнений', test: () => totalChecks() >= 50 },
  { id: 'c100', icon: '💯', title: '100 отметок', desc: 'Всего 100 выполнений', test: () => totalChecks() >= 100 },
  { id: 'c500', icon: '🏆', title: '500 отметок', desc: 'Всего 500 выполнений', test: () => totalChecks() >= 500 },
  { id: 's7', icon: '🔥', title: 'Неделя подряд', desc: '7 дней подряд с отметками', test: () => streakOfDays(activitySet()) >= 7 },
  { id: 's30', icon: '🚀', title: 'Месяц подряд', desc: '30 дней подряд с отметками', test: () => streakOfDays(activitySet()) >= 30 },
  { id: 's100', icon: '👑', title: '100 дней подряд', desc: '100 дней подряд с отметками', test: () => streakOfDays(activitySet()) >= 100 },
  {
    id: 'weekgoal', icon: '🎯', title: 'Цель недели', desc: 'Выполнить недельное задание',
    test: () => state.habits.some(h => h.weekly && countInWeek(h, mondayOf(new Date())) >= h.target),
  },
  {
    id: 'perfect', icon: '⭐', title: 'Идеальный день', desc: 'Все ежедневные привычки за один день',
    test: () => {
      const daily = state.habits.filter(h => !h.weekly);
      if (!daily.length) return false;
      const sets = daily.map(h => new Set(h.done));
      return Array.from({ length: 14 }, (_, i) => dateKey(addDays(new Date(), -i)))
        .some(k => sets.every(s => s.has(k)));
    },
  },
];

function checkAchievements() {
  const fresh = ACHIEVEMENTS.filter(a => !state.unlocked.includes(a.id) && a.test());
  if (!fresh.length) return;
  state = { ...state, unlocked: [...state.unlocked, ...fresh.map(a => a.id)] };
  showToast(`${fresh[0].icon} Достижение: ${fresh[0].title}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`);
}

/* ---------- DOM ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
const $ = id => document.getElementById(id);

let toastTimer;
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, TOAST_MS);
}

function renderReminders() {
  const box = $('reminders');
  box.replaceChildren(...getReminders().map(({ habit, need, daysLeft }) =>
    el('div', {
      className: 'card reminder' + (daysLeft <= need ? ' urgent' : ''),
      textContent: `⏰ Сделай: ${habit.emoji} ${habit.name} — ещё ${need} раз(а), дней до конца недели: ${daysLeft}`,
    })));
}

function renderFilters() {
  const box = $('filters');
  const used = new Set(state.habits.map(h => h.category));
  if (activeCategory !== 'Все' && !used.has(activeCategory)) activeCategory = 'Все';
  box.replaceChildren(...['Все', ...CATEGORIES.filter(c => used.has(c))].map(c => {
    const b = el('button', { type: 'button', className: 'chip' + (c === activeCategory ? ' active' : ''), textContent: c });
    b.addEventListener('click', () => { activeCategory = c; renderHabitsTab(); });
    return b;
  }));
}

function renderWeekLabel(monday) {
  $('weekLabel').textContent = weekOffset === 0
    ? 'Эта неделя'
    : `${fmtShort(monday)} – ${fmtShort(addDays(monday, 6))}`;
  $('nextWeek').disabled = weekOffset >= 0;
}

function toggleDay(habitId, key) {
  updateHabits(state.habits.map(h => h.id !== habitId ? h : {
    ...h,
    done: h.done.includes(key) ? h.done.filter(k => k !== key) : [...h.done, key],
  }));
  checkAchievements();
  save();
  render();
}

function deleteHabit(habit) {
  if (!confirm(`Удалить «${habit.name}»?`)) return;
  updateHabits(state.habits.filter(h => h.id !== habit.id));
  save();
  render();
}

function buildDays(habit, monday) {
  const today = todayKey();
  const done = new Set(habit.done);
  const days = el('div', { className: 'days' });
  weekKeys(monday).forEach((key, i) => {
    const on = done.has(key);
    const btn = el('button', { type: 'button', textContent: on ? '✓' : '', className: on ? 'on' : '', disabled: key > today });
    btn.setAttribute('aria-label', `${habit.name}, ${key}`);
    btn.addEventListener('click', () => toggleDay(habit.id, key));
    days.append(el('div', { className: 'day' + (key === today ? ' today' : '') },
      `${WEEKDAYS[i]} ${parseKey(key).getDate()}`, btn));
  });
  return days;
}

function buildStatus(habit, monday) {
  const count = countInWeek(habit, monday);
  if (!habit.weekly) return el('div', { className: 'status', textContent: `На этой неделе: ${count} из 7` });
  if (count >= habit.target) {
    return el('div', { className: 'status ok', textContent: `✅ Задание недели выполнено (${count}/${habit.target})` });
  }
  return el('div', { className: 'status', textContent: `Задание недели: ${count} из ${habit.target}` });
}

function buildEditForm(habit) {
  const emoji = el('input', { type: 'text', className: 'emoji', value: habit.emoji, maxLength: 4 });
  const name = el('input', { type: 'text', value: habit.name, maxLength: 60, required: true });
  const category = el('select', {}, ...CATEGORIES.map(c =>
    el('option', { value: c, textContent: c, selected: c === habit.category })));
  const type = el('select', {},
    el('option', { value: 'daily', textContent: 'Каждый день', selected: !habit.weekly }),
    el('option', { value: 'weekly', textContent: 'N раз в неделю', selected: habit.weekly }));
  const target = el('input', { type: 'number', min: 1, max: 7, value: habit.target, hidden: !habit.weekly });
  type.addEventListener('change', () => { target.hidden = type.value !== 'weekly'; });
  [emoji, name, category, type, target].forEach((f, i) =>
    f.setAttribute('aria-label', ['Эмодзи', 'Название', 'Категория', 'Периодичность', 'Раз в неделю'][i]));

  const cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Отмена' });
  cancel.addEventListener('click', () => { editingId = null; render(); });

  const form = el('form', { className: 'card add-form' }, emoji, name, category, type, target,
    el('button', { type: 'submit', className: 'primary', textContent: 'Сохранить' }), cancel);
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (!name.value.trim()) return;
    const edited = normalizeHabit({
      ...habit, emoji: emoji.value.trim(), name: name.value.trim(), category: category.value,
      weekly: type.value === 'weekly', target: target.value,
    });
    updateHabits(state.habits.map(h => h.id === habit.id ? edited : h));
    editingId = null;
    checkAchievements();
    save();
    render();
  });
  return form;
}

function renderHabit(habit) {
  if (habit.id === editingId) return buildEditForm(habit);
  const monday = addDays(mondayOf(new Date()), weekOffset * 7);
  const total = habit.done.length;
  const { prev, next } = milestoneRange(total);
  const pct = clamp((total - prev) / (next - prev) * 100, 0, 100);
  const streak = habit.weekly ? `Недель подряд: ${weekStreak(habit)} 🔥` : `Серия: ${streakOfDays(new Set(habit.done))} 🔥`;

  const del = el('button', { className: 'icon-btn', title: 'Удалить привычку', textContent: '✕' });
  del.setAttribute('aria-label', `Удалить ${habit.name}`);
  del.addEventListener('click', () => deleteHabit(habit));

  const edit = el('button', { className: 'icon-btn edit', title: 'Изменить привычку', textContent: '✎' });
  edit.setAttribute('aria-label', `Изменить ${habit.name}`);
  edit.addEventListener('click', () => { editingId = habit.id; render(); });

  return el('div', { className: 'card' },
    el('div', { className: 'habit-head' },
      el('span', { textContent: habit.emoji || '✅' }),
      el('span', { className: 'name', textContent: habit.name }),
      el('span', { className: 'tag', textContent: habit.category }),
      el('span', { className: 'tag', textContent: habit.weekly ? `${habit.target} р/нед` : 'каждый день' }),
      edit, del),
    buildDays(habit, monday),
    buildStatus(habit, monday),
    el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })),
    el('div', { className: 'meta', textContent: `Всего выполнено: ${total} · до ${next}: ${next - total} · ${streak}` }));
}

function renderHabitsTab() {
  renderReminders();
  renderFilters();
  renderWeekLabel(addDays(mondayOf(new Date()), weekOffset * 7));
  const shown = state.habits.filter(h => activeCategory === 'Все' || h.category === activeCategory);
  $('list').replaceChildren(...(shown.length
    ? shown.map(renderHabit)
    : [el('div', { className: 'empty', textContent: 'Привычек пока нет — добавьте первую выше.' })]));
}

/* ---------- статистика ---------- */

function summaryCard(label, value) {
  return el('div', { className: 'card' }, el('span', { className: 'meta', textContent: label }), el('b', { textContent: value }));
}

function statLine(label, rate) {
  return el('div', { className: 'stat-line' },
    el('span', { textContent: label }),
    el('div', { className: `bar ${rateClass(rate)}` }, el('i', { style: `width:${Math.round(rate * 100)}%` })),
    el('span', { className: 'pct', textContent: `${Math.round(rate * 100)}%` }));
}

function renderWeeklyChart() {
  const monday = mondayOf(new Date());
  const weeks = Array.from({ length: CHART_WEEKS }, (_, i) => addDays(monday, -7 * (CHART_WEEKS - 1 - i)));
  const counts = weeks.map(m => state.habits.reduce((s, h) => s + countInWeek(h, m), 0));
  const max = Math.max(1, ...counts);
  return el('div', { className: 'card chart' }, ...weeks.map((m, i) =>
    el('div', {}, el('span', { textContent: counts[i] }),
      el('i', { style: `height:${counts[i] / max * 80}px` }), el('span', { textContent: fmtShort(m) }))));
}

function renderHeatmap() {
  const sets = state.habits.map(h => new Set(h.done));
  const start = addDays(mondayOf(new Date()), -(HEAT_DAYS - 7));
  const cells = Array.from({ length: HEAT_DAYS }, (_, i) => {
    const d = addDays(start, i);
    const key = dateKey(d);
    const n = sets.filter(s => s.has(key)).length;
    const level = key > todayKey() || n === 0 ? '' : n >= 4 ? 'l3' : n >= 2 ? 'l2' : 'l1';
    return el('div', { className: level, textContent: d.getDate(), title: `${key}: ${n}` });
  });
  return el('div', { className: 'card' }, el('div', { className: 'heat' }, ...cells));
}

function renderStatsTab() {
  const root = $('tab-stats');
  if (!state.habits.length) {
    root.replaceChildren(el('div', { className: 'empty', textContent: 'Добавьте привычки, чтобы увидеть статистику.' }));
    return;
  }
  const ranked = state.habits.map(h => ({ h, rate: completionRate(h) })).sort((a, b) => b.rate - a.rate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const activeDaysStreak = streakOfDays(activitySet());

  const byCategory = CATEGORIES
    .map(c => ({ c, items: ranked.filter(r => r.h.category === c) }))
    .filter(g => g.items.length)
    .map(g => ({ c: g.c, rate: g.items.reduce((s, r) => s + r.rate, 0) / g.items.length }))
    .sort((a, b) => b.rate - a.rate);

  const summary = [
    summaryCard('Всего отметок', String(totalChecks())),
    summaryCard('Дней подряд с активностью', `${activeDaysStreak} 🔥`),
    ...(ranked.length > 1 ? [
      summaryCard('🏆 Лучше всего', `${best.h.name} · ${Math.round(best.rate * 100)}%`),
      summaryCard('⚠️ Отстаёт', `${worst.h.name} · ${Math.round(worst.rate * 100)}%`),
    ] : []),
  ];

  root.replaceChildren(
    el('div', { className: 'summary' }, ...summary),
    el('h2', { textContent: `Выполнение за ${STATS_WINDOW_DAYS} дней по привычкам` }),
    el('div', { className: 'card' }, ...ranked.map(r => statLine(`${r.h.emoji} ${r.h.name}`.trim(), r.rate))),
    el('h2', { textContent: 'По категориям' }),
    el('div', { className: 'card' }, ...byCategory.map(g => statLine(g.c, g.rate))),
    el('h2', { textContent: `Отметок по неделям (последние ${CHART_WEEKS})` }),
    renderWeeklyChart(),
    el('h2', { textContent: 'Активность по дням' }),
    renderHeatmap());
}

function renderAwardsTab() {
  const root = $('tab-awards');
  root.replaceChildren(
    el('p', { className: 'sub', textContent: `Открыто: ${state.unlocked.length} из ${ACHIEVEMENTS.length}` }),
    el('div', { className: 'awards' }, ...ACHIEVEMENTS.map(a => el('div',
      { className: 'card award' + (state.unlocked.includes(a.id) ? '' : ' locked') },
      el('div', { className: 'ico', textContent: a.icon }),
      el('b', { textContent: a.title }),
      el('small', { textContent: a.desc })))));
}

function render() {
  const renderers = { habits: renderHabitsTab, stats: renderStatsTab, awards: renderAwardsTab };
  renderers[activeTab]();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
  ['habits', 'stats', 'awards'].forEach(t => { $(`tab-${t}`).hidden = t !== activeTab; });
  updateNotifyButton();
}

/* ---------- уведомления ---------- */

function updateNotifyButton() {
  const b = $('notifyBtn');
  if (!('Notification' in window)) { b.hidden = true; return; }
  b.textContent = Notification.permission === 'granted' ? '🔔 Уведомления включены' : '🔔 Включить уведомления';
}

function maybeNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reminders = getReminders();
  if (!reminders.length || state.lastNotify === todayKey()) return;
  state = { ...state, lastNotify: todayKey() };
  save();
  const title = 'Трекер привычек';
  const options = {
    body: reminders.map(r => `${r.habit.emoji} ${r.habit.name}: ещё ${r.need} (дней: ${r.daysLeft})`).join('\n'),
    icon: 'icon-192.png',
  };
  // На телефоне уведомления работают только через service worker
  const registration = swRegistration;
  if (registration) registration.showNotification(title, options);
  else new Notification(title, options);
}

let swRegistration = null;
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { swRegistration = await navigator.serviceWorker.register('sw.js'); }
  catch (e) { /* file:// или http — работаем без офлайн-режима */ }
}

/* ---------- события ---------- */

function initForm() {
  $('newCategory').replaceChildren(...CATEGORIES.map(c => el('option', { value: c, textContent: c })));
  $('newType').addEventListener('change', e => { $('newTarget').hidden = e.target.value !== 'weekly'; });
  $('addForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('newName').value.trim();
    if (!name) return;
    const habit = normalizeHabit({
      id: makeId(), emoji: $('newEmoji').value.trim(), name,
      category: $('newCategory').value, weekly: $('newType').value === 'weekly',
      target: $('newTarget').value, created: todayKey(), done: [],
    });
    updateHabits([...state.habits, habit]);
    e.target.reset();
    $('newTarget').hidden = true;
    save();
    render();
  });
}

function initControls() {
  $('tabs').addEventListener('click', e => {
    const tab = e.target.closest('button')?.dataset.tab;
    if (!tab) return;
    activeTab = tab;
    render();
  });
  $('prevWeek').addEventListener('click', () => { weekOffset -= 1; render(); });
  $('nextWeek').addEventListener('click', () => { weekOffset = Math.min(0, weekOffset + 1); render(); });
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Заменить все привычки стандартными? Текущий прогресс будет потерян.')) return;
    state = { ...state, habits: makeDefaults() };
    save();
    render();
  });
  $('notifyBtn').addEventListener('click', async () => {
    if (Notification.permission === 'default') await Notification.requestPermission();
    updateNotifyButton();
    maybeNotify();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

initForm();
initControls();
checkAchievements();
save();
render();
registerServiceWorker().then(maybeNotify);
setInterval(maybeNotify, NOTIFY_CHECK_MS);
