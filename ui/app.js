// HiveNote dashboard: a live, read-only view of one hive.
// Everything shown comes from POST /v1/call. Note text is always inserted as text,
// never as HTML, because notes are written by agents.

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 10000;
const FEED_LIMIT = 60;
const GAP = 16;
const MIN_CARD = 250;
const TOKEN_KEY = 'hivenote-token';
const ORDER_KEY = `hivenote-order:${location.host}`;

const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  token: '',
  cursor: 0,
  entries: [],          // brief entries for every note and task
  full: new Map(),      // note id -> full note (content, attribution), cached by updated_at
  names: new Map(),     // note id -> name, so the feed can name deleted notes
  order: [],            // this viewer's arrangement of note ids
  filter: null,         // Set of note ids matching the search, or null
};

// ---------- Small helpers ----------

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function ago(timestamp) {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function shorten(text, length) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
}

function hash(text) {
  let value = 0;
  for (const char of String(text)) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage can be blocked; the page still works without it */ }
  return null;
}

// ---------- Bees ----------

let beeCount = 0;

/** A clean vector bee: round striped body, see-through wings, a small face that stays inside. */
function bee(className = '') {
  const id = `bee-${++beeCount}`;
  const template = document.createElement('template');
  template.innerHTML = `
    <svg class="bee ${className}" viewBox="0 0 64 64" aria-hidden="true">
      <defs><clipPath id="${id}"><ellipse cx="32" cy="38" rx="20" ry="17.5"/></clipPath></defs>
      <g class="whole">
        <g transform="rotate(-22 25 21)"><ellipse class="wing back" cx="25" cy="15" rx="8" ry="12"/></g>
        <path class="ink" d="M12.8 37 L6.5 39 L12.8 41.2 Z"/>
        <ellipse class="body-fill" cx="32" cy="38" rx="20" ry="17.5"/>
        <g clip-path="url(#${id})"><rect class="ink" x="18.5" y="18" width="4.5" height="42" rx="2"/><rect class="ink" x="26.5" y="18" width="4.5" height="42" rx="2"/></g>
        <ellipse cx="32" cy="38" rx="20" ry="17.5" fill="none" class="line" stroke-width="2.5"/>
        <g transform="rotate(16 36 21)"><ellipse class="wing" cx="36" cy="14" rx="8.5" ry="12.5"/></g>
        <path d="M41 24 C42 18.5 44.5 15 47.5 13.5" fill="none" class="line" stroke-width="2" stroke-linecap="round"/>
        <circle class="ink" cx="48" cy="13" r="2.2"/>
        <path d="M37 22.5 C37 17 38 13.5 40 11" fill="none" class="line" stroke-width="2" stroke-linecap="round"/>
        <circle class="ink" cx="40.4" cy="10.5" r="2.2"/>
        <circle class="ink" cx="39.5" cy="35.5" r="2.6"/>
        <circle cx="40.4" cy="34.5" r="0.85" fill="#fff"/>
        <circle class="ink" cx="46" cy="35.5" r="2.4"/>
        <circle cx="46.8" cy="34.6" r="0.8" fill="#fff"/>
        <path d="M40.6 40.8 q2.3 2.2 4.6 0" fill="none" class="line" stroke-width="1.9" stroke-linecap="round"/>
        <ellipse cx="36.8" cy="40.4" rx="2.2" ry="1.5" fill="#ff8fa3" opacity="0.7"/>
        <ellipse cx="48.2" cy="40.4" rx="1.8" ry="1.4" fill="#ff8fa3" opacity="0.7"/>
        <g class="crown" transform="rotate(17 41 22)">
          <path d="M35 24.6 L34.4 16.8 L38.3 20.2 L41 15 L43.7 20.2 L47.6 16.8 L47 24.6 Z" stroke-width="1.8" stroke-linejoin="round"/>
          <circle cx="41" cy="21.9" r="1.15" fill="#ff8fa3"/>
        </g>
      </g>
    </svg>`;
  return template.content.firstElementChild;
}

/** Fly a bee from one element to another, then make the target glow. */
function fly(from, to) {
  if (!to) return;
  const glow = () => { to.classList.add('pollinated'); setTimeout(() => to.classList.remove('pollinated'), 1400); };
  if (reduceMotion || !from) return glow();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const start = { x: a.left + 8, y: a.top + a.height / 2 - 19 };
  const end = { x: b.right - 34, y: b.top - 16 };
  const mid = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 100 };
  const facing = end.x < start.x ? -1 : 1;
  const flyer = el('div', { class: 'flyer' }, bee());
  $('sky').append(flyer);
  flyer.animate([
    { transform: `translate(${start.x}px, ${start.y}px) scaleX(${facing})` },
    { transform: `translate(${mid.x}px, ${mid.y}px) scaleX(${facing}) rotate(-10deg)`, offset: 0.55 },
    { transform: `translate(${end.x}px, ${end.y}px) scaleX(${facing}) rotate(6deg)` },
  ], { duration: 1300, easing: 'cubic-bezier(.45,.05,.3,1)' }).onfinish = () => {
    glow();
    flyer.animate([
      { transform: `translate(${end.x}px, ${end.y}px) scaleX(${facing})`, opacity: 1 },
      { transform: `translate(${end.x + 40 * facing}px, ${end.y - 40}px) scaleX(${facing})`, opacity: 0 },
    ], { duration: 600, fill: 'forwards' }).onfinish = () => flyer.remove();
  };
}

// ---------- Talking to the hive ----------

class Unauthorized extends Error {}

async function call(method, params = {}) {
  const headers = { 'content-type': 'application/json' };
  // On the machine running `hivenote ui` no token is needed; elsewhere one is.
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch('/v1/call', { method: 'POST', headers, body: JSON.stringify({ method, params }) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status})`);
  return data.result;
}

async function listAll() {
  const entries = [];
  for (let offset = 0; ; offset += 100) {
    const page = await call('list', { limit: 100, offset });
    entries.push(...page.notes);
    if (!page.has_more) return entries;
  }
}

/** Fetch full content only for notes that are new or changed since we last read them. */
async function loadContent() {
  const stale = state.entries.filter(entry => entry.kind === 'note' && state.full.get(entry.id)?.updated_at !== entry.updated_at).map(entry => entry.id);
  for (let i = 0; i < stale.length; i += 100) {
    const { notes } = await call('read', { ids: stale.slice(i, i + 100) });
    for (const note of notes) state.full.set(note.id, note);
  }
  const live = new Set(state.entries.map(entry => entry.id));
  for (const id of state.full.keys()) if (!live.has(id)) state.full.delete(id);
}

// ---------- Notes: a masonry you can rearrange ----------

const cards = new Map();   // note id -> card element
const slots = new Map();   // note id -> { x, y, w, h } inside the masonry
let drag = null;
let justDragged = false;

function noteIds() {
  return state.entries.filter(entry => entry.kind === 'note').map(entry => entry.id);
}

/** Saved order first; notes this viewer has not seen yet go to the front, newest first. */
function arrange() {
  const present = new Set(noteIds());
  const saved = state.order.filter(id => present.has(id));
  const known = new Set(saved);
  const fresh = state.entries.filter(entry => entry.kind === 'note' && !known.has(entry.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(entry => entry.id);
  state.order = [...fresh, ...saved];
}

function saveOrder() {
  remember(ORDER_KEY, JSON.stringify(state.order));
}

function fillCard(card, note) {
  const who = note.last_activity_attribution ? actorName(note.last_activity_attribution) : '';
  const content = note.content ?? '';
  card.replaceChildren(
    el('strong', { text: note.name }),
    note.description && el('p', { class: 'description', text: note.description }),
    content && el('div', { class: 'content', text: content.slice(0, 1200) }),
    el('div', { class: 'footer' }, who && avatar(who), el('span', { text: who ? `${who} · ${ago(note.updated_at)}` : ago(note.updated_at) })),
  );
}

function renderNotes() {
  const masonry = $('notes');
  arrange();
  const present = new Set(state.order);
  for (const [id, card] of cards) {
    if (!present.has(id)) { card.remove(); cards.delete(id); slots.delete(id); }
  }
  const firstRender = cards.size === 0;
  for (const id of state.order) {
    const note = state.full.get(id) ?? state.entries.find(entry => entry.id === id);
    let card = cards.get(id);
    if (!card) {
      card = el('button', { class: `note tint-${hash(id) % 6}${firstRender ? '' : ' entering'}`, 'data-id': id });
      card.addEventListener('pointerdown', event => startDrag(event, id));
      card.addEventListener('click', () => { if (!justDragged) openNote(id); });
      cards.set(id, card);
      masonry.append(card);
    }
    const version = note.updated_at + (note.content === undefined ? '' : ':full');
    if (card.dataset.version !== version) {
      fillCard(card, note);
      card.dataset.version = version;
    }
    card.hidden = state.filter !== null && !state.filter.has(id);
  }
  const empty = masonry.querySelector(':scope > .empty');
  const visible = state.order.some(id => !cards.get(id).hidden);
  if (!visible && !empty) masonry.append(emptyState(state.filter ? 'No notes match that search' : 'No notes yet. Agents will fill this in.'));
  if (visible && empty) empty.remove();
  if (firstRender) masonry.classList.add('instant');
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    masonry.classList.remove('instant');
    masonry.querySelectorAll('.note.entering').forEach(card => card.classList.remove('entering'));
  }));
}

/** Place each card in the shortest column. Moving cards glide there via CSS transitions. */
function layout() {
  const masonry = $('notes');
  const width = masonry.clientWidth;
  const columns = Math.max(1, Math.floor((width + GAP) / (MIN_CARD + GAP)));
  const cardWidth = (width - GAP * (columns - 1)) / columns;
  const heights = new Array(columns).fill(0);
  const visible = state.order.map(id => cards.get(id)).filter(card => card && !card.hidden);
  for (const card of visible) card.style.width = `${cardWidth}px`;
  for (const card of visible) {
    const column = heights.indexOf(Math.min(...heights));
    const slot = { x: column * (cardWidth + GAP), y: heights[column], w: cardWidth, h: card.offsetHeight };
    slots.set(card.dataset.id, slot);
    if (!(drag?.active && drag.id === card.dataset.id)) card.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
    heights[column] += slot.h + GAP;
  }
  masonry.style.height = `${Math.max(120, Math.max(...heights) - GAP)}px`;
}

function startDrag(event, id) {
  // Mouse and pen drag to rearrange; on touch, a tap opens the note and scrolling stays normal.
  if (event.button !== 0 || event.pointerType === 'touch') return;
  drag = { id, card: cards.get(id), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
}

addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const box = $('notes').getBoundingClientRect();
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    const slot = slots.get(drag.id);
    drag.active = true;
    drag.grabX = drag.startX - box.left - slot.x;
    drag.grabY = drag.startY - box.top - slot.y;
    drag.card.classList.add('dragging');
    drag.card.setPointerCapture(event.pointerId);
  }
  const x = event.clientX - box.left - drag.grabX;
  const y = event.clientY - box.top - drag.grabY;
  drag.card.style.transform = `translate(${x}px, ${y}px) rotate(1.5deg) scale(1.03)`;
  // Take the place of whichever card is under the pointer.
  const px = event.clientX - box.left, py = event.clientY - box.top;
  for (const [id, slot] of slots) {
    if (id === drag.id || cards.get(id)?.hidden) continue;
    if (px >= slot.x && px <= slot.x + slot.w && py >= slot.y && py <= slot.y + slot.h) {
      const from = state.order.indexOf(drag.id);
      const to = state.order.indexOf(id);
      state.order.splice(from, 1);
      state.order.splice(to, 0, drag.id);
      layout();
      break;
    }
  }
});

addEventListener('pointerup', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const wasDragging = drag.active;
  if (wasDragging) drag.card.classList.remove('dragging');
  drag = null;
  if (wasDragging) {
    layout();
    saveOrder();
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
  }
});

// ---------- Tasks ----------

function taskCard(task) {
  const meta = [
    task.claimed_by && el('span', { text: 'claimed' }),
    task.due_at && el('span', { text: `due ${new Date(task.due_at).toLocaleDateString()}` }),
    task.status === 'cancelled' && el('span', { text: 'cancelled' }),
    el('span', { text: ago(task.updated_at) }),
  ];
  return el('button', { class: `card${task.status === 'cancelled' ? ' cancelled' : ''}`, 'data-id': task.id, onclick: () => openNote(task.id) },
    task.status === 'doing' && el('span', { class: 'worker' }, bee()),
    el('strong', { text: task.name }),
    task.description && el('p', { text: task.description }),
    el('div', { class: 'meta' }, ...meta),
  );
}

function emptyState(message) {
  return el('div', { class: 'empty' }, bee(), el('span', { text: message }));
}

function renderBoard() {
  const tasks = state.entries.filter(entry => entry.kind === 'task').sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const columns = { todo: [], doing: [], done: [] };
  for (const task of tasks) columns[task.status === 'cancelled' ? 'done' : task.status]?.push(task);
  for (const [status, list] of Object.entries(columns)) {
    const stack = document.querySelector(`[data-column="${status}"] .stack`);
    const empty = { todo: 'Nothing waiting', doing: 'No bees busy', done: 'Nothing finished yet' }[status];
    stack.replaceChildren(...(list.length ? list.map(taskCard) : [emptyState(empty)]));
  }
  $('task-count').textContent = `${columns.todo.length + columns.doing.length} open`;
}

function renderStats() {
  const notes = noteIds().length;
  const tasks = state.entries.length - notes;
  $('stats').textContent = `${notes} ${notes === 1 ? 'note' : 'notes'} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`;
}

function setLive(status) {
  const pill = $('live');
  pill.dataset.state = status;
  pill.lastElementChild.textContent = { live: 'Live', offline: 'Reconnecting', connecting: 'Connecting' }[status];
}

// ---------- Buzz feed ----------

const COLORS = ['#ffd66b', '#ffb4a2', '#b5e3a0', '#a8d8f0', '#e3c1f5', '#ffc98b'];

function actorName(attribution) {
  return String(attribution.agent || (attribution.device !== 'local' ? attribution.device : '') || 'an agent');
}

function avatar(name) {
  const node = el('span', { class: 'avatar', text: name.slice(0, 1).toUpperCase() });
  // Set through the style property: the page's content policy blocks inline style attributes.
  node.style.background = COLORS[hash(name) % COLORS.length];
  return node;
}

function describe(event) {
  const note = event.snapshot?.name ?? state.names.get(event.note_id) ?? 'a note';
  const status = { todo: 'To do', doing: 'Doing', done: 'Done', cancelled: 'Cancelled' }[event.snapshot?.status];
  const verbs = {
    create: event.snapshot?.kind === 'task' ? 'added the task' : 'wrote',
    edit: 'edited', replace: 'rewrote', append: 'added progress to', delete: 'deleted', restore: 'restored',
    claim: 'picked up', claim_force: 'took over', release: 'let go of', release_force: 'freed',
    update_task: status ? 'moved' : 'updated',
  };
  const ending = event.kind === 'update_task' && status ? ` to ${status}` : '';
  return { verb: verbs[event.kind] ?? 'changed', note, ending, detail: event.kind === 'append' ? event.body : null };
}

function feedItem(event, fresh) {
  const actor = actorName(event.attribution);
  const { verb, note, ending, detail } = describe(event);
  return el('li', { class: `event${fresh ? ' fresh' : ''}`, 'data-note': event.note_id },
    avatar(actor),
    el('div', {},
      el('p', {}, el('b', { text: actor }), ` ${verb} `, el('b', { text: note }), ending),
      detail && el('p', { class: 'detail', text: shorten(detail, 160) }),
      el('time', { datetime: event.timestamp, text: ago(event.timestamp) }),
    ),
  );
}

function addToFeed(events, fresh) {
  const feed = $('feed');
  for (const event of events) if (event.snapshot?.name) state.names.set(event.note_id, event.snapshot.name);
  const items = events.slice().reverse().map(event => feedItem(event, fresh));
  if (items.length) feed.querySelector(':scope > li:not(.event)')?.remove();
  feed.prepend(...items);
  while (feed.children.length > FEED_LIMIT) feed.lastElementChild.remove();
  if (!feed.children.length) feed.append(el('li', {}, emptyState('Quiet hive. Activity shows up here live.')));
  return items;
}

function celebrate(items) {
  items.slice(0, 3).forEach((item, index) => setTimeout(() => {
    const id = CSS.escape(item.dataset.note);
    fly(item, document.querySelector(`.note[data-id="${id}"]:not([hidden]), .card[data-id="${id}"]`));
  }, index * 450));
}

// ---------- Reading a note ----------

async function openNote(id) {
  const { notes, updates } = await call('read', { ids: [id] });
  const note = notes[0];
  if (!note) return;
  $('reader-kind').textContent = note.kind === 'task' ? `Task · ${note.status}` : 'Note';
  $('reader-name').textContent = note.name;
  $('reader-description').textContent = note.description;
  $('reader-content').textContent = note.content || 'No content yet.';
  const progress = updates.filter(update => update.note_id === id).reverse();
  $('reader-updates-title').hidden = progress.length === 0;
  $('reader-updates').replaceChildren(...progress.map(update => el('li', {},
    el('time', { text: `${actorName(update.attribution)} · ${ago(update.timestamp)}` }),
    update.body,
  )));
  $('reader').showModal();
}

// ---------- Search ----------

let searchTimer = 0;
async function search(query) {
  const text = query.trim();
  if (!text) state.filter = null;
  else {
    try {
      const { notes } = await call('search', { query: text, limit: 100 });
      state.filter = new Set(notes.map(note => note.id));
    } catch {
      // Unbalanced quotes and similar: fall back to a plain name and description match.
      const lower = text.toLowerCase();
      state.filter = new Set(state.entries.filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(lower)).map(entry => entry.id));
    }
  }
  $('notes').querySelector(':scope > .empty')?.remove();
  renderNotes();
}

// ---------- Main loop ----------

async function refresh() {
  state.entries = await listAll();
  for (const entry of state.entries) state.names.set(entry.id, entry.name);
  await loadContent();
  renderNotes();
  renderBoard();
  renderStats();
}

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(poll, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
}

async function poll() {
  try {
    const page = await call('changes', { since: state.cursor, limit: 100 });
    if (page.events.length) {
      state.cursor = page.cursor;
      await refresh();
      if ($('search').value.trim()) await search($('search').value);
      celebrate(addToFeed(page.events, true));
    }
    setLive('live');
  } catch (error) {
    if (error instanceof Unauthorized) return showConnect('That token no longer works. Paste a new one.');
    setLive('offline');
  }
  schedule();
}

async function start() {
  $('connect').hidden = true;
  setLive('connecting');
  try {
    const recent = await call('changes', { tail: 40 });
    state.cursor = recent.cursor;
    $('hive').hidden = false;
    await document.fonts.ready;
    await refresh();
    $('feed').replaceChildren();
    addToFeed(recent.events, false);
    setLive('live');
    schedule();
  } catch (error) {
    if (error instanceof Unauthorized) return showConnect(state.token ? 'That token was not accepted. Check it and try again.' : '');
    setLive('offline');
    setTimeout(start, 3000);
  }
}

function showConnect(reason) {
  clearTimeout(timer);
  if (state.token) remember(TOKEN_KEY, null);
  state.token = '';
  $('hive').hidden = true;
  $('connect').hidden = false;
  if (reason) $('connect-why').textContent = reason;
  setLive('offline');
  $('token').focus();
}

// ---------- Wiring ----------

$('where').textContent = location.host;
$('brand-bee').append(bee());
$('connect-bee').append(bee());
// The machine that serves the hive to the others is the queen, so its bees wear a crown.
fetch('/health').then(response => response.json()).then(health => {
  if (!health.queen) return;
  document.body.classList.add('queen');
  $('where').textContent = `Queen bee · ${location.host}`;
}).catch(() => {});
$('reader-close').addEventListener('click', () => $('reader').close());
$('reader').addEventListener('click', event => { if (event.target === $('reader')) $('reader').close(); });
$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  state.token = $('token').value.trim();
  remember(TOKEN_KEY, state.token);
  start();
});
$('search').addEventListener('input', event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(event.target.value).catch(() => {}), 200);
});
document.addEventListener('visibilitychange', schedule);
new ResizeObserver(() => layout()).observe($('notes'));
setInterval(() => document.querySelectorAll('time[datetime]').forEach(node => { node.textContent = ago(node.getAttribute('datetime')); }), 30000);

try { state.order = JSON.parse(remember(ORDER_KEY) ?? '[]'); } catch { state.order = []; }
state.token = remember(TOKEN_KEY) ?? '';
start();
