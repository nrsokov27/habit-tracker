'use strict';

/*
 * Синхронизация через Firebase (вход Google + Firestore).
 * Документ users/{uid}: { data: "<JSON состояния>", updatedAt }.
 * Слияние: для каждой привычки побеждает версия с большим `updated`,
 * удалённые привычки хранятся в state.deleted и не воскресают.
 */

const SYNC_DEBOUNCE_MS = 1500;
const POPUP_FALLBACK_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'];

let fbAuth = null;
let fbDb = null;
let syncUser = null;
let unsubscribeRemote = null;
let pushTimer = null;
let syncStatus = '';

const syncAvailable = () => Boolean(window.FIREBASE_CONFIG && window.firebase);
const userDoc = () => fbDb.collection('users').doc(syncUser.uid);

const syncPayload = () => ({ habits: state.habits, deleted: state.deleted, unlocked: state.unlocked });

// Состояние без привычек, которые пользователь ещё не трогал, — «чистый» телефон/ПК
const isPristine = s => s.habits.every(h => h.done.length === 0 && h.updated === 0) && Object.keys(s.deleted).length === 0;

function fingerprint(s) {
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  return JSON.stringify([
    [...s.habits].sort(byId),
    Object.entries(s.deleted).sort(),
    [...s.unlocked].sort(),
  ]);
}

function mergeStates(local, remote) {
  const deleted = { ...remote.deleted };
  Object.entries(local.deleted).forEach(([id, ts]) => { deleted[id] = Math.max(ts, deleted[id] || 0); });

  const byId = new Map();
  [...local.habits, ...remote.habits].forEach(h => {
    if (deleted[h.id] !== undefined) return;
    const current = byId.get(h.id);
    if (!current || h.updated > current.updated) byId.set(h.id, h);
  });

  return {
    ...local,
    habits: [...byId.values()],
    deleted,
    unlocked: [...new Set([...local.unlocked, ...remote.unlocked])],
  };
}

function parseRemote(docData) {
  try {
    const parsed = JSON.parse(docData.data);
    if (!parsed || !Array.isArray(parsed.habits)) return null;
    return buildState(parsed.habits, parsed);
  } catch (e) {
    return null;
  }
}

/* ---------- обмен с облаком ---------- */

function setSyncStatus(text) {
  syncStatus = text;
  updateSyncButton();
}

async function pushNow() {
  if (!syncUser) return;
  try {
    await userDoc().set({
      data: JSON.stringify(syncPayload()),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSyncStatus('синхронизировано');
  } catch (e) {
    setSyncStatus('ошибка отправки');
    showToast('⚠️ Не удалось отправить данные в облако');
  }
}

function schedulePush() {
  if (!syncUser) return;
  setSyncStatus('отправка…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, SYNC_DEBOUNCE_MS);
}

function handleRemote(snapshot) {
  if (snapshot.metadata.hasPendingWrites) return; // эхо нашей собственной записи
  const remote = snapshot.exists ? parseRemote(snapshot.data()) : null;
  if (!remote) { pushNow(); return; } // в облаке пусто — загружаем локальные данные

  const merged = isPristine(state) ? remote : mergeStates(state, remote);
  if (fingerprint(merged) !== fingerprint(state)) {
    state = { ...state, ...merged, lastNotify: state.lastNotify };
    saveLocal();
    render();
  }
  if (fingerprint(merged) !== fingerprint(remote)) pushNow();
  else setSyncStatus('синхронизировано');
}

/* ---------- вход / выход ---------- */

function onAuthChanged(user) {
  syncUser = user;
  if (unsubscribeRemote) { unsubscribeRemote(); unsubscribeRemote = null; }
  if (user) {
    setSyncStatus('подключение…');
    unsubscribeRemote = userDoc().onSnapshot(handleRemote, () => {
      setSyncStatus('нет связи с облаком');
    });
  } else {
    setSyncStatus('');
  }
}

async function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await fbAuth.signInWithPopup(provider);
  } catch (e) {
    if (POPUP_FALLBACK_CODES.includes(e.code)) fbAuth.signInWithRedirect(provider);
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      showToast(`⚠️ Не удалось войти: ${e.code || e.message}`);
    }
  }
}

function onSyncClick() {
  if (!syncUser) { signIn(); return; }
  if (confirm(`Выйти из ${syncUser.email}? Данные на этом устройстве останутся, но синхронизация остановится.`)) {
    fbAuth.signOut();
  }
}

function updateSyncButton() {
  const b = $('syncBtn');
  b.textContent = syncUser
    ? `☁️ ${syncUser.email}${syncStatus ? ` · ${syncStatus}` : ''}`
    : '☁️ Войти для синхронизации';
}

function initSync() {
  const btn = $('syncBtn');
  if (!syncAvailable()) { btn.hidden = true; return; }
  firebase.initializeApp(window.FIREBASE_CONFIG);
  fbAuth = firebase.auth();
  fbDb = firebase.firestore();
  btn.hidden = false;
  btn.addEventListener('click', onSyncClick);
  onSaved = schedulePush;
  updateSyncButton();
  fbAuth.onAuthStateChanged(onAuthChanged);
}

initSync();
