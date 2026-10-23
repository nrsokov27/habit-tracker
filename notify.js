'use strict';

/*
 * Уведомления. Разрешение и время напоминания хранятся на устройстве:
 * у телефона и у ПК они свои, поэтому в облако не уходят.
 * Напоминание приходит один раз в день, в выбранное время или позже,
 * пока приложение открыто или свёрнуто.
 */

const NOTIFY_SETTINGS_KEY = 'habit-tracker-notify';
const NOTIFY_CHECK_MS = 5 * 60 * 1000;
const NOTIFY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_NOTIFY = { enabled: true, time: '20:00' };
const NOTIFY_TITLE = 'Трекер привычек';

const IOS_HINT = 'Этот браузер не поддерживает уведомления. На iPhone откройте сайт в Safari, нажмите «Поделиться» → «На экран Домой» и запускайте приложение с иконки (нужен iOS 16.4 или новее).';

const notifySupported = () => 'Notification' in window;

function loadNotifySettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFY_SETTINGS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        enabled: raw.enabled !== false,
        time: NOTIFY_TIME_RE.test(raw.time) ? raw.time : DEFAULT_NOTIFY.time,
      };
    }
  } catch (e) { /* повреждено — берём значения по умолчанию */ }
  return { ...DEFAULT_NOTIFY };
}

let notifySettings = loadNotifySettings();

function saveNotifySettings(next) {
  notifySettings = { ...notifySettings, ...next };
  try { localStorage.setItem(NOTIFY_SETTINGS_KEY, JSON.stringify(notifySettings)); }
  catch (e) { showToast('⚠️ Не удалось сохранить настройки уведомлений'); }
}

/* ---------- что напоминать ---------- */

function pendingLines() {
  const today = todayKey();
  const undoneDaily = state.habits.filter(h => !h.weekly && !h.done.includes(today));
  const lines = getReminders().map(r => `${r.habit.emoji} ${r.habit.name}: ещё ${r.need} (дней: ${r.daysLeft})`);
  if (undoneDaily.length) {
    lines.unshift(`Не отмечено сегодня: ${undoneDaily.map(h => `${h.emoji} ${h.name}`.trim()).join(', ')}`);
  }
  return lines;
}

function isReminderTime(now = new Date()) {
  const [h, m] = notifySettings.time.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

function showNotification(body) {
  const options = { body, icon: 'icon-192.png' };
  // На телефоне уведомления работают только через service worker
  if (swRegistration) return swRegistration.showNotification(NOTIFY_TITLE, options);
  return new Notification(NOTIFY_TITLE, options);
}

function maybeNotify() {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  if (!notifySettings.enabled || !isReminderTime() || state.lastNotify === todayKey()) return;
  const lines = pendingLines();
  if (!lines.length) return;
  state = { ...state, lastNotify: todayKey() };
  save();
  showNotification(lines.join('\n'));
}

/* ---------- панель настроек ---------- */

function permissionText() {
  if (!notifySupported()) return IOS_HINT;
  if (Notification.permission === 'denied') {
    return 'Уведомления заблокированы. Разрешите их для этого сайта в настройках браузера или телефона.';
  }
  if (Notification.permission === 'granted') return '✅ Уведомления разрешены на этом устройстве.';
  return 'Уведомления ещё не разрешены на этом устройстве.';
}

function updateNotifyPanel() {
  const canAsk = notifySupported() && Notification.permission === 'default';
  const granted = notifySupported() && Notification.permission === 'granted';
  $('notifyStatus').textContent = permissionText();
  $('notifyAllow').hidden = !canAsk;
  $('notifyOptions').hidden = !granted;
  $('notifyEnabled').checked = notifySettings.enabled;
  $('notifyTime').value = notifySettings.time;
  $('notifyTime').disabled = !notifySettings.enabled;
  $('notifyBtn').classList.toggle('on', granted && notifySettings.enabled);
}

function setPanelOpen(open) {
  $('notifyPanel').hidden = !open;
  $('notifyBtn').setAttribute('aria-expanded', String(open));
  if (open) updateNotifyPanel();
}

async function allowNotifications() {
  try { await Notification.requestPermission(); }
  catch (e) { showToast('⚠️ Не удалось запросить разрешение'); }
  updateNotifyPanel();
  maybeNotify();
}

async function sendTestNotification() {
  try {
    await showNotification('Так будут выглядеть напоминания 👍');
  } catch (e) {
    showToast('⚠️ Не удалось показать уведомление');
  }
}

function initNotify() {
  $('notifyBtn').addEventListener('click', () => setPanelOpen($('notifyPanel').hidden));
  $('notifyAllow').addEventListener('click', allowNotifications);
  $('notifyTest').addEventListener('click', sendTestNotification);
  $('notifyEnabled').addEventListener('change', e => {
    saveNotifySettings({ enabled: e.target.checked });
    updateNotifyPanel();
  });
  $('notifyTime').addEventListener('change', e => {
    if (!NOTIFY_TIME_RE.test(e.target.value)) { updateNotifyPanel(); return; }
    saveNotifySettings({ time: e.target.value });
    maybeNotify();
  });
  document.addEventListener('click', e => {
    if (!$('notifyPanel').hidden && !e.target.closest('.notify-wrap')) setPanelOpen(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setPanelOpen(false); });
  updateNotifyPanel();
  setInterval(maybeNotify, NOTIFY_CHECK_MS);
}

initNotify();
