import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

function load({ react = {} } = {}) {
  const storage = new Map();
  const listeners = new Map();
  const styleTags = [];
  let entry;
  // `unref` keeps a deliberately-started poll timer from holding the test runner open.
  const unref = handle => { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; };
  const window = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout,
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval,
    addEventListener: (key, value) => listeners.set(key, value),
    removeEventListener: key => listeners.delete(key),
    __ModuleLoader__: { load: value => { entry = value; } },
  };
  // A page-like document: the plugin installs its stylesheet into head on activation.
  const document = {
    visibilityState: 'visible',
    head: { appendChild: node => styleTags.push(node) },
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  const context = createContext({ window, document, console, setTimeout, clearTimeout });
  new Script(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')).runInContext(context);
  assert.equal(entry.id, 'dsh-whale-balance');
  const plugin = entry.factory(name => { assert.equal(name, 'react'); return react; });
  return { plugin, ...plugin.__test, window, document, styleTags, listeners, storage };
}
const ready = (balance = '12.50') => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance }], bonusWallets: [{ currency: 'CNY', balance: '2.00' }] } });
const api = fn => ({ remote: () => ({ account: { getBalance: fn } }), metadata: () => ({ version: 'test', locale: 'zh', timezoneOffsetSeconds: 28800 }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('assets are exactly the two supplied PNGs, not replacement illustrations', () => {
  const { ART, BUBBLE } = load();
  assert.deepEqual(Buffer.from(ART.split(',')[1], 'base64'), readFileSync(new URL('../assets/deepseek-whale-girl.png', import.meta.url)));
  assert.deepEqual(Buffer.from(BUBBLE.split(',')[1], 'base64'), readFileSync(new URL('../assets/good-girl-bubble.png', import.meta.url)));
});
test('money preserves currency, exact decimal sums, exponents and tiny positive balances', () => {
  const { money } = load();
  const result = money([
    { currency: 'CNY', balance: '0.1' }, { currency: 'CNY', balance: '0.2' },
    { currency: 'USD', balance: '5e-6' },
  ]);
  assert.equal(result[0].text, '0.30');
  assert.equal(result[1].text, '< 0.0001');
  assert.equal(money([{ currency: 'CNY', balance: '0E-16' }])[0].text, '0.00');
  assert.equal(money([{ currency: 'CNY', balance: '-1.99999' }])[0].text, '-2.00');
  assert.throws(() => money([{ currency: 'CNY', balance: 'NaN' }]));
});
test('every click advances immediately; polling never overwrites the selected line', async () => {
  const { createController, bubbleContent } = load();
  let calls = 0;
  const c = createController(api(async () => { calls++; return ready('1.23'); }));
  await c.refresh();
  assert.equal(bubbleContent(c.getSnapshot()).label, '¥1.23');
  c.click(); assert.equal(bubbleContent(c.getSnapshot()).label, '好女孩');
  await c.refresh(); assert.equal(bubbleContent(c.getSnapshot()).label, '好女孩');
  c.click(); assert.equal(bubbleContent(c.getSnapshot()).label, '哦鲸鲸');
  c.click(); assert.equal(bubbleContent(c.getSnapshot()).label, '¥1.23');
  assert.equal(c.getSnapshot().clicks, 3);
  await c.refresh(); assert.equal(calls, 3);
  c.dispose();
});
test('repeated refreshes coalesce; returning to balance refreshes the live amount', async () => {
  const { createController } = load();
  let settle; let calls = 0;
  const c = createController(api(() => { calls++; return new Promise(resolve => { settle = resolve; }); }));
  const first = c.refresh();
  assert.equal(c.refresh(), first);
  c.click(); c.click(); c.click();
  assert.equal(c.getSnapshot().mode, 0);
  await tick(); assert.equal(calls, 1);
  settle(ready('42.1234')); await first;
  assert.equal(c.getSnapshot().wallets[0].text, '42.1234');
  assert.equal(c.getSnapshot().bonusWallets[0].text, '2.00');
  c.dispose();
});
test('sign-out cancels a pending display and rejects late balances from the previous account', async () => {
  const { createController, bubbleContent } = load();
  let settle;
  const c = createController(api(() => new Promise(resolve => { settle = resolve; })));
  const pending = c.refresh(); await tick();
  c.clearAccount(); await pending;
  settle(ready('999')); await tick();
  assert.equal(c.getSnapshot().phase, 'signed-out');
  assert.equal(c.getSnapshot().wallets.length, 0);
  assert.equal(bubbleContent(c.getSnapshot()).label, '请先登录');
  c.dispose();
});
test('timeouts settle and allow retry; failure keeps an explicitly stale last success', async () => {
  const { createController, bubbleContent } = load();
  let behavior = () => ready('8.00');
  const c = createController(api(() => behavior()), { timeoutMs: 10 });
  await c.refresh(); behavior = () => new Promise(() => {});
  await c.refresh();
  assert.equal(c.getSnapshot().phase, 'error');
  assert.equal(c.getSnapshot().refreshing, false);
  assert.equal(bubbleContent(c.getSnapshot()).label, '¥8.00');
  assert.match(bubbleContent(c.getSnapshot()).detail, /上次余额/);
  behavior = () => ready('7.00'); await c.refresh();
  assert.equal(c.getSnapshot().phase, 'ready');
  c.dispose();
});
test('null balance means signed out; failed or malformed responses never invent zero', async () => {
  const { createController, bubbleContent } = load();
  const outcomes = [
    { ok: true, value: null }, { ok: false, error: { code: 'ACCOUNT_QUOTA' } },
    { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: 'broken' }] } },
  ];
  const c = createController(api(async () => outcomes.shift()));
  await c.refresh(); assert.equal(c.getSnapshot().phase, 'signed-out');
  await c.refresh(); assert.equal(bubbleContent(c.getSnapshot()).label, '查询失败');
  await c.refresh(); assert.equal(c.getSnapshot().wallets.length, 0);
  c.dispose();
});
test('dispose cancels request deadlines and ignores late success', async () => {
  const { createController } = load();
  let settle; let notifications = 0;
  const c = createController(api(() => new Promise(resolve => { settle = resolve; })));
  c.subscribe(() => notifications++);
  const pending = c.refresh(); await tick(); c.dispose();
  await pending; const count = notifications;
  settle(ready()); await tick();
  assert.equal(notifications, count);
  assert.equal(c.getSnapshot().updatedAt, null);
});
test('account stream clears cached balances on sign-out and accepts each frame', async () => {
  const { createController } = load();
  let push; let accepted = 0; let disposed = 0;
  let next = new Promise(resolve => { push = resolve; });
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const frame = await next;
        if (!frame) return;
        next = new Promise(resolve => { push = resolve; });
        yield frame;
      }
    },
    dispose() { disposed++; push(null); },
  };
  const c = createController({
    remote: () => ({ account: { getBalance: async () => ready(), watch() {} }, $stream: () => stream }),
    metadata: () => ({}),
  });
  const stop = c.start(); await c.refresh();
  push({ value: { status: 'signed-out' }, accept() { accepted++; } }); await tick();
  assert.equal(c.getSnapshot().wallets.length, 0);
  assert.equal(c.getSnapshot().phase, 'signed-out');
  assert.equal(accepted, 1);
  stop(); c.dispose(); assert.equal(disposed, 1);
});
test('position persistence contains only coordinates/collapse state; unload removes timers/listeners', async () => {
  const { createController, storage, listeners } = load();
  const c = createController(api(async () => ready()));
  const stop = c.start(); await c.refresh();
  c.setPosition({ left: -500, top: 9999 }); c.setCollapsed(true);
  const saved = JSON.parse([...storage.values()][0]);
  assert.deepEqual(Object.keys(saved).sort(), ['collapsed', 'position']);
  assert.equal(saved.position.left, 8); assert.ok(saved.position.top <= 692);
  assert.equal(listeners.size, 2);
  stop(); c.dispose(); assert.equal(listeners.size, 0);
});
// Regression: the DSH web boot audit fails the whole page when any entry's fiber is
// not ACTIVE, so `apply` must never let an initialization error escape. Version 0.2.0
// shipped without this guard and blocked startup.
test('apply never throws, whatever the host context looks like', () => {
  const { apply } = load();
  // Each entry mimics one broken host. Any of them may have gotten as far as starting
  // the poll timer, so every real effect disposer is collected and run afterwards.
  const contexts = [
    {},
    { get: () => undefined },
    { locale: {}, effect() { throw new Error('effect refused'); } },
    { locale: { getSnapshot: () => ({ active: 'zh' }) }, effect(inner) { inner(); throw new Error('nested'); } },
    { locale: { getSnapshot: () => ({ active: 'zh' }) }, effect(inner) { inner(); }, slots: {} },
    {
      locale: { getSnapshot: () => ({ active: 'zh' }) },
      effect(inner) { inner(); },
      slots: { inject() { throw new Error('slot undeclared'); } },
    },
  ];
  for (const raw of contexts) {
    const disposers = [];
    const ctx = {
      ...raw,
      effect: (inner, label) => {
        if (typeof raw.effect === 'function') return raw.effect(inner, label);
        const disposer = inner(inner, label);
        if (typeof disposer === 'function') disposers.push(disposer);
        return disposer;
      },
    };
    assert.doesNotThrow(() => apply(ctx), `apply threw for ${JSON.stringify(Object.keys(raw))}`);
    for (const dispose of disposers) dispose();
  }
});

test('a working host context still registers the widget (fail-soft must not mean fail-silent)', () => {
  const { apply, window, styleTags } = load();
  const registered = [];
  const effects = [];
  const disposers = [];
  apply({
    locale: { getSnapshot: () => ({ active: 'zh' }) },
    effect(fn, label) {
      effects.push(label);
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return typeof disposer === 'function' ? disposer : () => {};
    },
    slots: {
      inject(key, callback) { assert.equal(key, 'shell.overlay'); return callback(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.id, 'whale-balance');
  assert.equal(registered[0].options.name, 'shell.overlay');
  assert.equal(typeof registered[0].component, 'function');
  assert.ok(effects.includes('whale-balance: styles'));
  assert.ok(effects.includes('whale-balance: account and timers'));
  assert.equal(styleTags.length, 1);
  assert.ok(window !== undefined);
  // Activation starts the poll timer; run the recorded disposers so the test can exit.
  for (const dispose of disposers) dispose();
});
// Regression: cordis resolves every injected path through its context proxy, so a
// nested service path must be declared. Without `remote.account` the first balance read
// threw `cannot get property "remote.account" without inject` and activation aborted
// before the overlay was registered (0.2.1 shipped that way).
test('the account Remote namespace is declared in inject, not merely read', () => {
  const { plugin } = load();
  // The bundle runs in a VM realm, so compare element-wise instead of by prototype.
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote.account']);
  assert.ok(plugin.inject.includes('remote.account'));
  assert.equal(typeof plugin.apply, 'function');
});
test('the controller hands React getters that keep working when detached from it', () => {
  const { createController } = load();
  const c = createController(api(async () => ready()));
  const { subscribe, getSnapshot } = c;
  // React stores whatever it is handed and calls it later with no receiver, so these
  // must not depend on `this`. The widget binds them explicitly for exactly that reason.
  const off = subscribe(() => {});
  assert.equal(typeof off, 'function');
  assert.equal(typeof getSnapshot().phase, 'string');
  off();
  c.dispose();
});
