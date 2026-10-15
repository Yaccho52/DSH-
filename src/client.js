window.__ModuleLoader__.load({
  id: 'dsh-whale-balance',
  factory(require) {
    'use strict';
    const React = require('react');
    const W = window;
    const ART = '__WHALE_GIRL_DATA_URL__';
    const BUBBLE = '__BUBBLE_DATA_URL__';
    const STORAGE = 'dsh-whale-balance/meme-v2';
    const POLL_MS = 30_000;
    const TIMEOUT_MS = 35_000;
    const SIZE = { width: 270, height: 274 };

    // Decimal addition is exact; monetary strings never pass through Number.
    function decimal(value) {
      const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(String(value));
      if (!match) return null;
      const exponent = Number(match[5] ?? 0);
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
      const fraction = match[3] ?? match[4] ?? '';
      const digits = (match[2] ?? '0') + fraction;
      if (digits.length > 200) return null;
      let units = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
      let scale = fraction.length - exponent;
      if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
      return { units, scale };
    }
    function money(rows) {
      const groups = new Map();
      for (const row of rows ?? []) {
        const amount = decimal(row?.balance);
        if (!amount || !['CNY', 'USD'].includes(row.currency)) throw new Error('Invalid balance');
        const previous = groups.get(row.currency) ?? { units: 0n, scale: 0 };
        const scale = Math.max(previous.scale, amount.scale);
        groups.set(row.currency, {
          scale,
          units: previous.units * 10n ** BigInt(scale - previous.scale) + amount.units * 10n ** BigInt(scale - amount.scale),
        });
      }
      return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => {
        // Keep up to four decimals, rounding half away from zero.
        const negative = value.units < 0n;
        let units = negative ? -value.units : value.units;
        let scale = value.scale;
        if (scale > 4) {
          const divisor = 10n ** BigInt(scale - 4);
          units = (units + divisor / 2n) / divisor;
          scale = 4;
        }
        if (scale < 2) { units *= 10n ** BigInt(2 - scale); scale = 2; }
        const text = units.toString().padStart(scale + 1, '0');
        const whole = text.slice(0, -scale);
        let fraction = text.slice(-scale);
        while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
        const sign = negative && units !== 0n ? '-' : '';
        const tiny = units === 0n && value.units !== 0n;
        return { currency, text: tiny ? (negative ? '> -0.0001' : '< 0.0001') : `${sign}${whole}.${fraction}` };
      });
    }
    function readStored() {
      try {
        const data = JSON.parse(W.localStorage.getItem(STORAGE) ?? '{}');
        return data && typeof data === 'object' ? data : {};
      } catch { return {}; }
    }
    function clampPosition(position, width = W.innerWidth, height = W.innerHeight, collapsed = false) {
      const scale = Math.min(1, Math.max(0.1, (width - 16) / SIZE.width), Math.max(0.1, (height - 72) / SIZE.height));
      const w = (collapsed ? 100 : SIZE.width) * scale;
      const h = (collapsed ? 100 : SIZE.height) * scale;
      return {
        left: Math.max(8, Math.min(Number.isFinite(position?.left) ? position.left : width - w - 20, width - w - 8)),
        top: Math.max(48, Math.min(Number.isFinite(position?.top) ? position.top : height - h - 28, height - h - 8)),
      };
    }
    function createController(api, options = {}) {
      const timers = options.timers ?? W;
      const stored = options.stored ?? readStored();
      const listeners = new Set();
      let state = {
        mode: 0, clicks: 0, phase: 'idle', refreshing: false,
        wallets: [], bonusWallets: [], updatedAt: null, error: null,
        collapsed: stored.collapsed === true,
        position: clampPosition(stored.position, undefined, undefined, stored.collapsed === true),
      };
      let disposed = false;
      let epoch = 0;
      let pending = null;
      let pendingCancel = null;
      let stream = null;
      function emit(patch) {
        if (disposed) return;
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
      }
      function persist() {
        try { W.localStorage.setItem(STORAGE, JSON.stringify({ position: state.position, collapsed: state.collapsed })); } catch {}
      }
      function invalidate() {
        epoch++;
        pendingCancel?.();
        pendingCancel = null;
        pending = null;
      }
      function clearAccount(phase = 'signed-out') {
        invalidate();
        emit({ phase, refreshing: false, wallets: [], bonusWallets: [], updatedAt: null, error: null });
      }
      function getRemote() {
        try { return api.remote(); } catch { return undefined; }
      }
      function refresh() {
        if (disposed) return Promise.resolve();
        if (pending) return pending;
        const requestEpoch = epoch;
        const remote = getRemote();
        if (typeof remote?.account?.getBalance !== 'function') {
          emit({ phase: 'error', refreshing: false, error: '余额服务未连接' });
          return Promise.resolve();
        }
        emit({ refreshing: true, error: null });
        let timer;
        const cancelled = Symbol('cancelled');
        const timeout = new Promise(resolve => {
          timer = timers.setTimeout(() => resolve({ timeout: true }), options.timeoutMs ?? TIMEOUT_MS);
        });
        const cancellation = new Promise(resolve => { pendingCancel = () => resolve(cancelled); });
        const call = Promise.resolve().then(() => remote.account.getBalance(api.metadata())).catch(() => ({ failed: true }));
        const request = Promise.race([call, timeout, cancellation]).then(result => {
          if (disposed || requestEpoch !== epoch || result === cancelled) return;
          if (result?.ok !== true) throw new Error(result?.timeout ? '余额查询超时' : '余额读取失败');
          if (result.value == null) { clearAccount(); return; }
          if (result.value.status !== 'ready') throw new Error('余额暂不可用');
          const wallets = money(result.value.value);
          const bonusWallets = money(result.value.bonusWallets);
          emit({ phase: 'ready', refreshing: false, wallets, bonusWallets, updatedAt: new Date().toISOString(), error: null });
        }).catch(error => {
          if (!disposed && requestEpoch === epoch) emit({ phase: 'error', refreshing: false, error: error.message });
        }).finally(() => {
          timers.clearTimeout(timer);
          if (pending === request) { pending = null; pendingCancel = null; }
        });
        pending = request;
        return request;
      }
      function startAccountWatch() {
        const remote = getRemote();
        if (!remote?.$stream || !remote.account?.watch) return () => {};
        let stopped = false;
        try {
          stream = remote.$stream({ name: 'whale-balance-account', open: signal => remote.account.watch(signal), ended: () => new Error('Account stream ended') });
          const currentStream = stream;
          (async () => {
            for await (const frame of currentStream) {
              if (stopped || disposed) break;
              clearAccount(frame.value.status === 'signed-out' ? 'signed-out' : 'idle');
              frame.accept();
              if (frame.value.status === 'credential-stored') void refresh();
            }
          })().catch(() => {
            // Polling continues if observation disconnects; cached amounts are removed.
            if (!stopped && !disposed) clearAccount('error');
          });
        } catch { /* Periodic refresh remains available on older clients. */ }
        return () => { stopped = true; void Promise.resolve(stream?.dispose()).catch(() => {}); stream = null; };
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        click() {
          emit({ mode: (state.mode + 1) % 3, clicks: state.clicks + 1 });
          if (state.mode === 0) void refresh();
        },
        refresh,
        clearAccount,
        setPosition(position) { emit({ position: clampPosition(position, undefined, undefined, state.collapsed) }); persist(); },
        setCollapsed(collapsed) {
          emit({ collapsed, position: clampPosition(state.position, undefined, undefined, collapsed) }); persist();
        },
        start() {
          let stopped = false;
          const stopWatch = startAccountWatch();
          void refresh();
          const timer = timers.setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh();
          }, options.pollMs ?? POLL_MS);
          const onFocus = () => { if (!stopped) void refresh(); };
          const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
          W.addEventListener?.('focus', onFocus);
          W.addEventListener?.('online', onFocus);
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          return () => {
            stopped = true; timers.clearInterval(timer); stopWatch();
            W.removeEventListener?.('focus', onFocus); W.removeEventListener?.('online', onFocus);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
          };
        },
        dispose() {
          disposed = true; invalidate(); listeners.clear();
          void Promise.resolve(stream?.dispose()).catch(() => {});
        },
      };
    }
    const symbol = currency => currency === 'CNY' ? '¥' : '$';
    const amounts = rows => rows.map(row => `${symbol(row.currency)}${row.text}`).join(' / ');
    function bubbleContent(state) {
      if (state.mode === 1) return { label: '好女孩', detail: '' };
      if (state.mode === 2) return { label: '哦鲸鲸', detail: '' };
      if (!state.updatedAt) {
        if (state.phase === 'signed-out') return { label: '请先登录', detail: '登录 DSH 账号后显示余额' };
        if (state.phase === 'error') return { label: '查询失败', detail: state.error ?? '余额服务暂未连接' };
        return { label: '查询中…', detail: '正在读取余额' };
      }
      return {
        label: amounts(state.wallets) || '暂无钱包',
        detail: state.error ? '更新失败 · 上次余额' : state.bonusWallets.length ? `赠金 ${amounts(state.bonusWallets)}` : '账户余额',
      };
    }
    const CSS = `
      .dshwb2{position:fixed;z-index:180;isolation:isolate;width:270px;height:274px;pointer-events:none;transform-origin:top left;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#12151c;user-select:none;-webkit-app-region:no-drag}
      .dshwb2 *{box-sizing:border-box}
      .dshwb2 [type=button]{font-family:inherit;cursor:pointer;-webkit-app-region:no-drag}
      .dshwb2-hero{position:absolute;right:0;bottom:0;width:214px;height:180px;padding:0;border:0;background:none;pointer-events:auto;touch-action:none;overflow:hidden;transform-origin:72% 92%;filter:drop-shadow(0 5px 6px #08224c25)}
      .dshwb2-hero img{position:absolute;bottom:0;right:0;width:214px;max-width:none;height:auto;pointer-events:none}
      .dshwb2-hero:focus-visible{outline:3px solid #5b8eff;outline-offset:3px;border-radius:20px}
      .dshwb2-bubble{position:absolute;left:0;top:0;width:212px;height:142px;pointer-events:auto;filter:drop-shadow(0 3px 3px #00000016)}
      .dshwb2-bubble>img{width:100%;height:100%;display:block;pointer-events:none}
      .dshwb2-words{position:absolute;left:23%;top:27%;width:58%;height:30%;background:#fff;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;overflow:hidden}
      .dshwb2-label{font-size:23px;font-weight:800;line-height:1.15;white-space:nowrap;letter-spacing:-.5px;max-width:100%;font-variant-numeric:tabular-nums}
      .dshwb2-label[data-long=true]{font-size:14px;white-space:normal;overflow-wrap:anywhere}
      .dshwb2-detail{font-size:9px;line-height:1.1;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;color:#626670}
      .dshwb2[data-error=true] .dshwb2-detail{color:#b33b45}
      .dshwb2-toolbar{position:absolute;right:0;top:0;display:flex;gap:4px;pointer-events:auto;opacity:0;transition:opacity .15s}
      .dshwb2:hover .dshwb2-toolbar,.dshwb2:focus-within .dshwb2-toolbar{opacity:1}
      .dshwb2-tool{border:1px solid #7385a42e;border-radius:50%;width:25px;height:25px;display:grid;place-items:center;background:#fffefb;color:#40516c;padding:0;font-size:16px;box-shadow:0 2px 5px #0001}
      .dshwb2-tool:disabled{opacity:.5;cursor:wait}
      .dshwb2-hint{position:absolute;bottom:-17px;right:6px;font-size:10px;color:var(--dsh-text-secondary,#8a94a6);opacity:0;white-space:nowrap}
      .dshwb2:hover .dshwb2-hint{opacity:1}
      .dshwb2[data-collapsed=true]{width:100px;height:100px}
      .dshwb2[data-collapsed=true] .dshwb2-hero{width:100px;height:100px;border-radius:50%;background:#e8f1ff}
      .dshwb2[data-collapsed=true] .dshwb2-hero img{width:130px;right:-12px;bottom:-4px}
      .dshwb2[data-collapsed=true] .dshwb2-toolbar{top:-20px;right:-4px}
      .dshwb2-status{position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:#729bd9;pointer-events:none}
      .dshwb2[data-error=true] .dshwb2-status{background:#d66a75}
      @media(prefers-reduced-motion:reduce){.dshwb2 *{animation:none!important;transition:none!important}}
      @media(hover:none){.dshwb2-toolbar{opacity:1}.dshwb2-hint{display:none}}
    `;
    function Widget({ whaleBalance }) {
      const { controller } = whaleBalance;
      // Bound getters: the controller's methods are not arrow-bound, so passing the raw
      // references would run them with the wrong `this` and throw on first paint.
      const subscribe = React.useCallback
        ? React.useCallback(listener => controller.subscribe(listener), [controller])
        : listener => controller.subscribe(listener);
      const getSnapshot = React.useCallback
        ? React.useCallback(() => controller.getSnapshot(), [controller])
        : () => controller.getSnapshot();
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const hero = React.useRef(null);
      const drag = React.useRef(null);
      const suppressClick = React.useRef(false);
      const animation = React.useRef(null);
      const [viewport, setViewport] = React.useState({ width: W.innerWidth, height: W.innerHeight });
      React.useEffect(() => {
        const resize = () => { setViewport({ width: W.innerWidth, height: W.innerHeight }); controller.setPosition(controller.getSnapshot().position); };
        W.addEventListener('resize', resize);
        return () => { W.removeEventListener('resize', resize); animation.current?.cancel(); };
      }, [controller]);
      // Every hook above this line is unconditional; the render body below is fail-soft
      // so a throwing interaction can never take the widget (or its host page) down.
      try {
      const reactToClick = event => {
        if (event.detail === 0) suppressClick.current = false;
        if (suppressClick.current) { suppressClick.current = false; return; }
        if (state.collapsed) { controller.setCollapsed(false); return; }
        controller.click();
        animation.current?.cancel();
        if (!W.matchMedia?.('(prefers-reduced-motion: reduce)').matches && hero.current?.animate) {
          animation.current = hero.current.animate([
            { transform: 'translateY(0) rotate(0) scale(1)' },
            { transform: 'translateY(-12px) rotate(-5deg) scale(1.035)', offset: .32 },
            { transform: 'translateY(0) rotate(3deg) scale(.98)', offset: .7 },
            { transform: 'translateY(0) rotate(0) scale(1)' },
          ], { duration: 360, easing: 'ease-out' });
        }
      };
      function onPointerDown(event) {
        if (event.button !== 0) return;
        suppressClick.current = false;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, position: state.position, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      function onPointerMove(event) {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 6) return;
        current.moved = true;
        controller.setPosition({ left: current.position.left + dx, top: current.position.top + dy });
      }
      function endPointer(event, cancelled = false) {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        suppressClick.current = current.moved || cancelled;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const content = bubbleContent(state);
      const scale = Math.min(1, (viewport.width - 16) / SIZE.width, Math.max(.1, (viewport.height - 72) / SIZE.height));
      const label = state.mode === 0 && state.wallets.length ? `余额 ${content.label}` : content.label;
      const h = React.createElement;
      const timestamp = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      const title = [label, content.detail, timestamp && `更新于 ${timestamp}`, state.error, '单击切换台词 · 按住拖动'].filter(Boolean).join('\n');
      return h('div', {
        className: 'dshwb2', 'data-collapsed': state.collapsed, 'data-error': state.phase === 'error' || state.phase === 'signed-out',
        style: { left: state.position.left, top: state.position.top, transform: `scale(${scale})` },
        'data-whale-balance': '0.2.2',
      }, !state.collapsed && h('div', { className: 'dshwb2-bubble', title },
        h('img', { src: BUBBLE, alt: '', draggable: false }),
        h('div', { className: 'dshwb2-words', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
          h('span', { className: 'dshwb2-label', 'data-long': content.label.length > 9 }, content.label),
          content.detail && h('span', { className: 'dshwb2-detail' }, content.detail))),
      h('button', {
        ref: hero, className: 'dshwb2-hero', type: 'button', title,
        'aria-label': state.collapsed ? '展开鲸鱼娘余额气泡' : `鲸鱼娘：${label}。点击切换台词`,
        onClick: reactToClick, onPointerDown, onPointerMove,
        onPointerUp: event => endPointer(event), onPointerCancel: event => endPointer(event, true),
        onLostPointerCapture: event => { if (drag.current) endPointer(event, true); },
      }, h('img', { src: ART, alt: 'DeepSeek 鲸鱼娘', draggable: false })),
      h('div', { className: 'dshwb2-toolbar' },
        h('button', { className: 'dshwb2-tool', type: 'button', title: '刷新余额', 'aria-label': '刷新余额', disabled: state.refreshing, onClick: () => controller.refresh() }, '↻'),
        !state.collapsed && h('button', { className: 'dshwb2-tool', type: 'button', title: '收起鲸鱼娘', 'aria-label': '收起鲸鱼娘', onClick: () => controller.setCollapsed(true) }, '−')),
      state.collapsed && h('span', { className: 'dshwb2-status', title: label }),
      !state.collapsed && h('span', { className: 'dshwb2-hint', 'aria-hidden': true }, '点我互动 · 按住拖动'));
      } catch (error) {
        console.warn('[whale-balance] render failed; the widget stayed off screen', error);
        return null;
      }
    }
    function apply(ctx) {
      // Fail-soft by contract: the DSH web boot audit fails the whole page when any
      // entry's fiber is not ACTIVE, so a plugin-side initialization error must never
      // escape this function. The widget simply stays off screen and logs instead.
      try {
      const controller = createController({
        remote: () => typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote,
        metadata: () => ({
          version: '0.2.0-rc.2', locale: ctx.locale.getSnapshot()?.active ?? 'zh',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }),
      });
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.whaleBalanceStyle = '0.2.2'; style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'whale-balance: styles');
      ctx.effect(() => {
        const stop = controller.start();
        return () => { stop(); controller.dispose(); };
      }, 'whale-balance: account and timers');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'whale-balance',
        inject: () => ({ whaleBalance: { controller } }),
      }, Widget));
      } catch (error) {
        console.warn('[whale-balance] activation failed; DSH startup is left untouched', error);
      }
    }
    return {
      // `remote.account` is the account Remote namespace the balance call goes through.
      // Cordis resolves every injected path through its context proxy, so the nested path
      // must be declared: with only `slots`/`locale`, the first read of `remote.account`
      // throws `cannot get property "remote.account" without inject`, which used to abort
      // activation before the overlay was ever registered.
      name: 'whale-balance', inject: ['slots', 'locale', 'remote.account'], apply,
      __test: { decimal, money, createController, bubbleContent, clampPosition, Widget, CSS, ART, BUBBLE, apply },
    };
  },
});
