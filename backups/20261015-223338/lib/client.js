/**
 * `dsh-whale-balance` · Browser half.
 *
 * One floating widget in the bottom-right corner: the DeepSeek whale-girl as the
 * speaker, and her chat bubble showing the account balance. Registered into the
 * root-scoped `shell.overlay` list slot, so it lives over every page of the Web GUI
 * without ever taking a seat from the conversation.
 *
 * Data path: `ctx.remote.account.getBalance(client)` — the very Remote the official
 * Settings → Account page uses, so this widget and that page can never disagree.
 * The art comes from this package's own Host route (`/api/whale-balance/...`).
 *
 * Rules this half follows:
 * - nothing but registration happens during `apply`; resources start inside effects;
 * - every timer, listener and style tag dies with the owning effect;
 * - the widget must never throw into the page — a broken plugin must not blank the GUI.
 *
 * State lives in a controller outside React (shared with the module-scope commands),
 * so a re-render can never lose an in-flight request.
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-balance',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');

    /**
     * The page realm this bundle was loaded into. Captured once at factory time so
     * every helper reads the same object instead of resolving `window` late.
     */
    const WINDOW = typeof window === 'undefined' ? undefined : window;

    /* ── configuration ───────────────────────────────────────────────────────── */

    /** Auto-refresh cadence while the bubble is open. */
    const POLL_MS = 60_000;
    /** Below this amount the whale-girl switches to her worried face. */
    const DEFAULT_ALERT_BELOW = 5;
    /** Asset route registered by this package's Host half. */
    const ASSET_BASE = '/api/whale-balance';
    const ART_URL = `${ASSET_BASE}/whale-girl.jpg`;
    const AVATAR_URL = `${ASSET_BASE}/whale-girl-avatar.jpg`;
    /** localStorage key for everything the user can change by dragging or clicking. */
    const STORAGE_KEY = 'dsh-whale-balance/v1';
    /** Keep the panel inside the viewport with this margin. */
    const VIEWPORT_MARGIN = 12;
    /** Pointer travel (px) that turns a press into a drag instead of a click. */
    const DRAG_SLOP = 5;
    /** Give up on the Remote call instead of leaving the bubble spinning forever. */
    const REQUEST_TIMEOUT_MS = 20_000;

    const LOCALE_NAMESPACE = 'whaleBalance';
    const LOCALE = {
      en: {
        speaker: 'Whale-girl',
        balanceLabel: 'Balance',
        toppedUp: 'Topped-up',
        granted: 'Granted',
        loading: 'Counting your fish…',
        updated: 'Updated {time}',
        tapToRefresh: 'Tap the whale-girl to refresh',
        refresh: 'Refresh balance',
        collapse: 'Collapse',
        expand: 'Show balance',
        retry: 'Retry',
        storeFailed: 'The balance service did not answer.',
        quotaFailed: 'Could not read the balance.',
        noAmount: 'This account has no wallet yet',
        signedOut: 'Sign in to your DeepSeek account to see the balance.',
        lowAlert: 'Balance is running low — top up before the next task.',
        ready: 'Ready',
      },
      zh: {
        speaker: '鲸鱼娘',
        balanceLabel: '余额',
        toppedUp: '充值余额',
        granted: '赠金余额',
        loading: '正在数你的小鱼干…',
        updated: '更新于 {time}',
        tapToRefresh: '点一下鲸鱼娘就能刷新',
        refresh: '刷新余额',
        collapse: '收起来',
        expand: '查看余额',
        retry: '重试',
        storeFailed: '余额服务没有回应。',
        quotaFailed: '余额读取失败。',
        noAmount: '这个账号还没有钱包',
        signedOut: '先登录 DeepSeek 账号才能看到余额。',
        lowAlert: '余额快见底啦，趁早充值再开工～',
        ready: '就绪',
      },
    };

    /* ── persistence ─────────────────────────────────────────────────────────── */

    function loadStored() {
      try {
        const raw = WINDOW?.localStorage?.getItem(STORAGE_KEY);
        if (raw === null || raw === undefined) return {};
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /* ── diagnostics ─────────────────────────────────────────────────────────── */

    /**
     * Progress report to this package's Host half, so the browser side can be
     * inspected from `<package>/diag.log` without a browser console. Sent with an
     * image beacon: in the desktop shell `fetch` is carried over the app's own
     * transport, while a plain GET is served by the Host webserver directly.
     * A serialization failure reports itself — a silent probe is useless.
     * @param stage - short stage label.
     * @param data - small JSON-safe detail object.
     */
    function diag(stage, data) {
      let payload;
      try {
        payload = JSON.stringify({ stage, ...data });
      } catch (error) {
        try {
          payload = JSON.stringify({ stage, serializationFailed: String(error?.message ?? error) });
        } catch {
          payload = JSON.stringify({ stage });
        }
      }
      try {
        const beacon = new WINDOW.Image();
        beacon.alt = '';
        beacon.src = `${ASSET_BASE}/diag?e=${encodeURIComponent(payload)}&t=${Date.now()}`;
      } catch {
        /* diagnostics must never affect the widget */
      }
    }

    function saveStored(state) {
      try {
        WINDOW?.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* private mode or a full quota: the widget still works, it just forgets. */
      }
    }

    /* ── formatting ──────────────────────────────────────────────────────────── */

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };

    /**
     * Format a Platform decimal string for display.
     * @param value - amount string; kept as a string for anything but presentation.
     * @param currency - wallet currency.
     * @returns display text keeping sub-cent precision visible.
     */
    function formatAmount(value, currency) {
      const text = String(value ?? '');
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return text;
      if (numeric === 0) return '0.00';
      if (Math.abs(numeric) < 0.01) return numeric.toFixed(4);
      // Two decimals is the product-wide money display; below one unit a third
      // decimal stays visible so a nearly empty wallet never reads as "0.00".
      const digits = Math.abs(numeric) < 1 ? 3 : 2;
      try {
        return new Intl.NumberFormat(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(numeric);
      } catch {
        return numeric.toFixed(digits);
      }
    }

    function symbolOf(currency) {
      return CURRENCY_SYMBOL[currency] ?? `${currency} `;
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    }

    /**
     * Total an account's wallets of one currency.
     * @param wallets - Platform wallet rows.
     * @param currency - currency to total.
     * @returns summed amount, or null when the account has none.
     */
    function totalOf(wallets, currency) {
      let sum = 0;
      let seen = false;
      for (const wallet of wallets) {
        if (wallet.currency !== currency) continue;
        const amount = Number(wallet.balance);
        if (!Number.isFinite(amount)) continue;
        sum += amount;
        seen = true;
      }
      return seen ? sum : null;
    }

    /* ── controller ──────────────────────────────────────────────────────────── */

    /**
     * One widget's whole state plus the commands the UI calls.
     * @param api - `{ remote, requestClientMetadata }`.
     */
    function createController(api) {
      const stored = loadStored();
      let state = {
        collapsed: stored.collapsed === true,
        position:
          stored.position !== null &&
          typeof stored.position === 'object' &&
          Number.isFinite(stored.position.left) &&
          Number.isFinite(stored.position.top)
            ? { left: stored.position.left, top: stored.position.top }
            : null,
        alertBelow: Number.isFinite(stored.alertBelow) ? stored.alertBelow : DEFAULT_ALERT_BELOW,
        phase: 'idle',
        balance: null,
        updatedAt: null,
        errorKey: null,
        refreshCount: 0,
      };

      const listeners = new Set();
      let inflight = null;

      function emit(patch) {
        state = { ...state, ...patch };
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            console.warn('[whale-balance] subscriber failed', error);
          }
        }
      }

      function persist() {
        saveStored({
          collapsed: state.collapsed,
          position: state.position,
          alertBelow: state.alertBelow,
        });
      }

      function fail(errorKey) {
        diag('refresh:failed', { errorKey });
        emit({
          phase: 'error',
          errorKey,
          refreshCount: state.refreshCount + 1,
        });
      }

      function succeed(value) {
        diag('refresh:ready', {
          wallets: (value.value ?? []).map((wallet) => `${wallet.currency}:${wallet.balance}`),
          bonus: (value.bonusWallets ?? []).length,
        });
        emit({
          phase: 'ready',
          balance: { wallets: value.value ?? [], bonusWallets: value.bonusWallets ?? [] },
          errorKey: null,
          updatedAt: new Date().toISOString(),
          refreshCount: state.refreshCount + 1,
        });
      }

      /** Call the account Remote; never throws, always settles into a state. */
      function refresh() {
        if (inflight !== null) return inflight;

        const remote = (() => {
          try {
            return api.remote();
          } catch {
            return undefined;
          }
        })();
        const method = remote?.account?.getBalance;
        if (typeof method !== 'function') {
          fail('storeFailed');
          return Promise.resolve();
        }

        emit({ phase: 'loading', errorKey: null });
        const timeout = new Promise((resolve) => {
          WINDOW.setTimeout(() => resolve({ timedOut: true }), REQUEST_TIMEOUT_MS);
        });
        const call = Promise.resolve()
          .then(() => method.call(remote.account, api.requestClientMetadata()))
          .catch((error) => {
            console.warn('[whale-balance] balance request threw', error);
            return { threw: true };
          });

        inflight = Promise.race([call, timeout]).then((outcome) => {
          inflight = null;
          if (outcome === null || outcome === undefined) {
            // Signed out, or the stored grant changed under us.
            emit({
              phase: 'signed-out',
              balance: null,
              errorKey: null,
              updatedAt: new Date().toISOString(),
              refreshCount: state.refreshCount + 1,
            });
            return;
          }
          if (outcome.timedOut === true || outcome.threw === true) {
            fail('quotaFailed');
            return;
          }
          if (outcome.ok !== true) {
            fail(outcome.error?.code === 'ACCOUNT_QUOTA' ? 'quotaFailed' : 'storeFailed');
            return;
          }
          const value = outcome.value;
          if (value === null || value === undefined) {
            emit({
              phase: 'signed-out',
              balance: null,
              errorKey: null,
              updatedAt: new Date().toISOString(),
              refreshCount: state.refreshCount + 1,
            });
            return;
          }
          if (value.status === 'ready') {
            succeed(value);
            return;
          }
          fail('quotaFailed');
        });
        return inflight;
      }

      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setCollapsed(collapsed) {
          emit({ collapsed });
          persist();
        },
        setPosition(position) {
          emit({ position });
          persist();
        },
        setAlertBelow(value) {
          if (!Number.isFinite(value) || value < 0) return;
          emit({ alertBelow: value });
          persist();
        },
        refresh,
        dispose() {
          listeners.clear();
          inflight = null;
        },
      };
    }

    /**
     * Alert decision for one balance snapshot: every wallet the account has is
     * below the threshold. A single healthy wallet keeps the whale-girl calm.
     * @param state - controller snapshot.
     * @returns whether the worried face should show.
     */
    function isLow(state) {
      const wallets = state.balance?.wallets ?? [];
      if (wallets.length === 0) return false;
      const threshold = state.alertBelow;
      let evaluated = 0;
      for (const wallet of wallets) {
        const amount = Number(wallet.balance);
        if (!Number.isFinite(amount)) continue;
        evaluated += 1;
        if (amount >= threshold) return false;
      }
      return evaluated > 0;
    }

    /* ── stylesheet ──────────────────────────────────────────────────────────── */

    const STYLE_ID = 'dsh-whale-balance/style.css';
    const CSS = `
.dshwb-root{position:fixed;z-index:40;display:flex;flex-direction:column;align-items:flex-end;gap:10px;
  /* Positioning is CSS-owned: the widget lands in its corner even when the effect
     that follows a user drag never runs. place() only overrides these. */
  right:var(--dshwb-right,20px);bottom:var(--dshwb-bottom,16px);left:auto;top:auto;
  font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px;
  color:light-dark(#141a24,#eef3fb);-webkit-user-select:none;user-select:none}
.dshwb-root[data-dragging="true"]{cursor:grabbing}
.dshwb-root[data-dragging="true"] *{cursor:grabbing!important}
.dshwb-stage{display:flex;flex-direction:column;align-items:center;gap:8px}
.dshwb-hero{position:relative;display:flex;justify-content:center;cursor:grab;touch-action:none}
.dshwb-hero::before{content:"";position:absolute;inset:6% 4% 2%;border-radius:50%;
  background:radial-gradient(closest-side,rgba(77,171,247,.34),rgba(77,171,247,0) 72%);filter:blur(6px)}
.dshwb-hero img{position:relative;display:block;width:128px;height:auto;-webkit-user-drag:none;
  filter:drop-shadow(0 10px 18px rgba(9,58,120,.28));animation:dshwb-breathe 4.8s ease-in-out infinite}
.dshwb-root[data-alert="true"] .dshwb-hero img{
  filter:drop-shadow(0 10px 18px rgba(214,54,54,.4)) saturate(1.12) contrast(1.04)}
.dshwb-alert-mark{position:absolute;top:-4px;right:2px;width:30px;height:30px;display:none;
  align-items:center;justify-content:center;border-radius:50%;font-size:16px;font-weight:700;
  color:#fff;background:linear-gradient(140deg,#ff6b6b,#d92d2d);
  box-shadow:0 3px 10px rgba(180,30,30,.45);animation:dshwb-pulse 1.6s ease-in-out infinite}
.dshwb-root[data-alert="true"] .dshwb-alert-mark{display:flex}
@keyframes dshwb-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.012)}}
@keyframes dshwb-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
.dshwb-tail{width:16px;height:16px;margin:0 26px -7px 0;transform:rotate(45deg);
  background:light-dark(#ffffff,#1d2532);
  border-right:.5px solid light-dark(rgba(19,45,86,.16),rgba(255,255,255,.14));
  border-bottom:.5px solid light-dark(rgba(19,45,86,.16),rgba(255,255,255,.14))}
.dshwb-root[data-alert="true"] .dshwb-tail{border-color:rgba(217,45,45,.4)}
.dshwb-card{box-sizing:border-box;width:296px;padding:12px 14px;border-radius:16px;
  background:light-dark(#ffffff,#1d2532);
  border:.5px solid light-dark(rgba(19,45,86,.16),rgba(255,255,255,.14));
  box-shadow:0 14px 34px rgba(11,42,86,.18),0 2px 6px rgba(11,42,86,.1);
  animation:dshwb-pop .18s ease-out}
.dshwb-root[data-alert="true"] .dshwb-card{border-color:rgba(217,45,45,.55);
  box-shadow:0 14px 34px rgba(150,25,25,.22),0 2px 6px rgba(150,25,25,.12)}
.dshwb-root[data-alert="true"] .dshwb-stage{animation:dshwb-nudge .5s ease-in-out 2}
@keyframes dshwb-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
@keyframes dshwb-nudge{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.dshwb-head{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.dshwb-avatar{width:22px;height:22px;border-radius:50%;object-fit:cover;flex:none;
  border:1px solid light-dark(rgba(19,45,86,.18),rgba(255,255,255,.2))}
.dshwb-name{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshwb-pill{margin-left:auto;flex:none;padding:1px 8px;border-radius:999px;font-size:11px;
  background:light-dark(rgba(77,171,247,.14),rgba(77,171,247,.22));
  color:light-dark(#1b6fd0,#8fc7ff)}
.dshwb-root[data-alert="true"] .dshwb-pill{background:rgba(217,45,45,.16);color:light-dark(#c02626,#ffa8a8)}
.dshwb-body{display:flex;align-items:baseline;gap:4px}
.dshwb-currency{font-size:14px;opacity:.65}
.dshwb-amount{font-size:27px;font-weight:650;letter-spacing:-.4px;line-height:34px;
  font-variant-numeric:tabular-nums;cursor:pointer;border-radius:8px}
.dshwb-amount:focus-visible,.dshwb-icon:focus-visible,.dshwb-mini:focus-visible,
.dshwb-teaser:focus-visible,.dshwb-link:focus-visible{
  outline:2px solid light-dark(#2a7de1,#8fc7ff);outline-offset:2px}
.dshwb-suffix{font-size:11.5px;opacity:.7}
.dshwb-sub{margin-top:2px;font-size:12px;opacity:.78;font-variant-numeric:tabular-nums}
.dshwb-note{margin-top:6px;font-size:12px;opacity:.72}
.dshwb-error{color:light-dark(#c02626,#ff9b9b)}
.dshwb-bonus{margin-top:6px;font-size:11.5px;opacity:.68}
.dshwb-actions{margin-top:9px;padding-top:9px;display:flex;align-items:center;gap:8px;
  border-top:.5px solid light-dark(rgba(19,45,86,.12),rgba(255,255,255,.1))}
.dshwb-time{font-size:11.5px;opacity:.6;font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.dshwb-spacer{flex:1}
.dshwb-icon{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border-radius:8px;border:.5px solid transparent;background:transparent;color:inherit;cursor:pointer;padding:0}
.dshwb-icon:hover:not([disabled]){background:light-dark(rgba(19,45,86,.07),rgba(255,255,255,.1))}
.dshwb-icon[disabled]{opacity:.45;cursor:default}
.dshwb-icon svg{width:15px;height:15px;display:block}
.dshwb-root[data-phase="loading"] .dshwb-icon-refresh svg{animation:dshwb-spin 1s linear infinite}
@keyframes dshwb-spin{to{transform:rotate(360deg)}}
.dshwb-link{background:none;border:0;padding:0;font:inherit;font-size:11.5px;
  color:light-dark(#1b6fd0,#8fc7ff);cursor:pointer;text-decoration:underline}
.dshwb-collapsed-wrap{display:flex;align-items:center;gap:8px}
.dshwb-mini{position:relative;padding:3px;border-radius:999px;cursor:pointer;flex:none;
  border:1px solid light-dark(rgba(19,45,86,.16),rgba(255,255,255,.18));
  background:light-dark(#ffffff,#1d2532);
  box-shadow:0 8px 20px rgba(11,42,86,.2);transition:transform .15s ease}
.dshwb-mini img{display:block;width:40px;height:40px;border-radius:999px;object-fit:cover}
.dshwb-mini:hover{transform:translateY(-1px)}
.dshwb-dot{position:absolute;top:1px;right:1px;width:11px;height:11px;border-radius:50%;
  background:#d92d2d;border:2px solid light-dark(#ffffff,#1d2532);display:none}
.dshwb-root[data-alert="true"] .dshwb-dot{display:block}
.dshwb-teaser{padding:6px 12px;border-radius:14px;font-size:12.5px;font-weight:600;
  font-variant-numeric:tabular-nums;white-space:nowrap;
  background:light-dark(#ffffff,#1d2532);color:inherit;
  border:.5px solid light-dark(rgba(19,45,86,.16),rgba(255,255,255,.14));
  box-shadow:0 8px 20px rgba(11,42,86,.16);cursor:pointer}
@media (max-width:640px){.dshwb-card{width:min(296px,calc(100vw - 32px))}
  .dshwb-hero img{width:104px}}
@media (prefers-reduced-motion:reduce){
  .dshwb-hero img,.dshwb-alert-mark,.dshwb-card,.dshwb-root[data-phase="loading"] .dshwb-icon-refresh svg,
  .dshwb-root[data-alert="true"] .dshwb-stage{animation:none!important}
  .dshwb-mini:hover{transform:none}}
`;

    function installStyles(document) {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-whale-balance';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /** Minimal inline icons — no icon dependency in the module graph. */
    const ICONS = {
      refresh: React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
        React.createElement('path', { d: 'M20 4v7h-7' }),
      ),
      collapse: React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M6 6l12 12M18 6L6 18' }),
      ),
    };

    /* ── widget component ────────────────────────────────────────────────────── */

    /**
     * The floating whale-girl. React owns what is on screen; the dragged position is
     * written straight to the DOM so a drag never has to re-render.
     * @param props - framework props (including `t` from the registered locale
     * namespace) plus the `whaleFace` injection.
     */
    function WhaleBalanceWidget(props) {
      const { whaleFace, t } = props;
      const controller = whaleFace.controller;
      const translate = React.useCallback(
        (key, params) => {
          let text = '';
          try {
            text = typeof t === 'function' ? t(key, params) : '';
          } catch {
            text = '';
          }
          if (typeof text === 'string' && text !== '' && text !== key) return text;
          const table = LOCALE.zh ?? LOCALE.en;
          const template = table[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
        },
        [t],
      );

      const [state, setState] = React.useState(controller.getSnapshot());
      const rootRef = React.useRef(null);
      const storedPosition = React.useRef(state.position);

      // Proof that the component body ran at all: if this line is missing from the
      // Host log while `slot:registered` is present, the render never reached us.
      diag('render:start', { phase: state.phase, collapsed: state.collapsed, hasT: typeof t === 'function' });

      React.useEffect(() => {
        const node = rootRef.current;
        diag('render:mounted', {
          phase: state.phase,
          collapsed: state.collapsed,
          hasT: typeof t === 'function',
          nodes: document.querySelectorAll('.dshwb-root').length,
          rect: node === null ? null : {
            x: Math.round(node.getBoundingClientRect().x),
            y: Math.round(node.getBoundingClientRect().y),
            w: Math.round(node.getBoundingClientRect().width),
            h: Math.round(node.getBoundingClientRect().height),
          },
          viewport: [WINDOW.innerWidth, WINDOW.innerHeight],
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      React.useEffect(() => controller.subscribe(() => setState(controller.getSnapshot())), [controller]);

      // First read on mount, then poll while the bubble is open.
      React.useEffect(() => {
        controller.refresh();
      }, [controller]);

      React.useEffect(() => {
        if (state.collapsed) return undefined;
        const timer = WINDOW.setInterval(() => controller.refresh(), POLL_MS);
        return () => WINDOW.clearInterval(timer);
      }, [controller, state.collapsed]);

      // Follow the user's dragged corner. The stylesheet already places the widget in
      // the bottom-right; this effect only overrides that, and it is written so a
      // failure here can never leave the widget parked at the viewport origin.
      React.useEffect(() => {
        const root = rootRef.current;
        if (root === null) return undefined;
        const place = () => {
          const position = storedPosition.current;
          if (position === null) {
            root.style.setProperty('--dshwb-right', `${VIEWPORT_MARGIN + 8}px`);
            root.style.setProperty('--dshwb-bottom', `${VIEWPORT_MARGIN + 4}px`);
            root.style.removeProperty('left');
            root.style.removeProperty('top');
            return;
          }
          const maxLeft = Math.max(VIEWPORT_MARGIN, WINDOW.innerWidth - root.offsetWidth - VIEWPORT_MARGIN);
          const maxTop = Math.max(VIEWPORT_MARGIN, WINDOW.innerHeight - root.offsetHeight - VIEWPORT_MARGIN);
          const left = Math.min(Math.max(VIEWPORT_MARGIN, position.left), maxLeft);
          const top = Math.min(Math.max(VIEWPORT_MARGIN, position.top), maxTop);
          root.style.left = `${left}px`;
          root.style.top = `${top}px`;
          root.style.right = 'auto';
          root.style.bottom = 'auto';
        };

        let observer;
        let probe;
        try {
          place();
          probe = WINDOW.setTimeout(() => {
            try {
              const rect = root.getBoundingClientRect();
              const style = WINDOW.getComputedStyle(root);
              const slotError = document.querySelector('[data-slot-error="shell.overlay"]');
              diag('place:done', {
                position: storedPosition.current,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                css: { position: style.position, display: style.display, visibility: style.visibility, zIndex: style.zIndex, right: style.right, bottom: style.bottom },
                viewport: [WINDOW.innerWidth, WINDOW.innerHeight],
                overlayHosts: document.querySelectorAll('[data-shell-overlay]').length,
                rootNodes: document.querySelectorAll('.dshwb-root').length,
                slotErrorFace: slotError === null ? null : slotError.outerHTML.slice(0, 120),
                imgNatural: [...document.querySelectorAll('.dshwb-root img')].map((img) => `${img.naturalWidth}x${img.naturalHeight}`),
              });
            } catch (error) {
              diag('place:probe-failed', { message: String(error?.message ?? error) });
            }
          }, 250);
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(() => {
              try {
                place();
              } catch (error) {
                diag('place:resize-failed', { message: String(error?.message ?? error) });
              }
            });
            observer.observe(root);
          }
          WINDOW.addEventListener('resize', place);
        } catch (error) {
          // Keep the stylesheet's corner instead of letting React unmount the widget.
          diag('place:failed', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 400) });
        }

        // Second, timer-independent probe: two animation frames after the effect.
        if (typeof WINDOW.requestAnimationFrame === 'function') {
          WINDOW.requestAnimationFrame(() => {
            WINDOW.requestAnimationFrame(() => {
              try {
                const rect = root.getBoundingClientRect();
                const style = WINDOW.getComputedStyle(root);
                diag('place:raf', {
                  rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                  css: { position: style.position, display: style.display, visibility: style.visibility, right: style.right, bottom: style.bottom },
                });
              } catch (error) {
                diag('place:raf-failed', { message: String(error?.message ?? error) });
              }
            });
          });
        }

        return () => {
          WINDOW.clearTimeout(probe);
          observer?.disconnect();
          WINDOW.removeEventListener('resize', place);
        };
      }, [state.collapsed]);

      /**
       * Press-to-drag on the character. A press shorter than the slop counts as a
       * click (refresh); anything longer moves the widget and persists its corner.
       */
      const onPointerDown = React.useCallback(
        (event) => {
          if (event.button !== 0) return;
          const root = rootRef.current;
          if (root === null) return;
          const rect = root.getBoundingClientRect();
          const origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
          let moved = false;
          const move = (current) => {
            const dx = current.clientX - origin.x;
            const dy = current.clientY - origin.y;
            if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
            moved = true;
            root.dataset.dragging = 'true';
            const maxLeft = Math.max(VIEWPORT_MARGIN, WINDOW.innerWidth - root.offsetWidth - VIEWPORT_MARGIN);
            const maxTop = Math.max(VIEWPORT_MARGIN, WINDOW.innerHeight - root.offsetHeight - VIEWPORT_MARGIN);
            const left = Math.min(Math.max(VIEWPORT_MARGIN, origin.left + dx), maxLeft);
            const top = Math.min(Math.max(VIEWPORT_MARGIN, origin.top + dy), maxTop);
            root.style.right = 'auto';
            root.style.bottom = 'auto';
            root.style.left = `${left}px`;
            root.style.top = `${top}px`;
          };
          const up = () => {
            WINDOW.removeEventListener('pointermove', move);
            WINDOW.removeEventListener('pointerup', up);
            WINDOW.removeEventListener('pointercancel', up);
            delete root.dataset.dragging;
            if (!moved) return;
            const dropped = root.getBoundingClientRect();
            const position = { left: dropped.left, top: dropped.top };
            storedPosition.current = position;
            controller.setPosition(position);
          };
          WINDOW.addEventListener('pointermove', move);
          WINDOW.addEventListener('pointerup', up);
          WINDOW.addEventListener('pointercancel', up);
        },
        [controller],
      );

      const wallets = state.balance?.wallets ?? [];
      const bonusWallets = (state.balance?.bonusWallets ?? []).filter((wallet) => Number(wallet.balance) > 0);
      const currency = wallets[0]?.currency ?? bonusWallets[0]?.currency ?? 'CNY';
      const total = totalOf(wallets, currency);
      const bonusTotal = totalOf(bonusWallets, currency);
      const alert = state.phase === 'ready' && isLow(state);
      const expanded = !state.collapsed;

      const rootProps = {
        ref: rootRef,
        className: 'dshwb-root',
        'data-phase': state.phase,
        'data-alert': alert ? 'true' : 'false',
      };

      if (!expanded) {
        return React.createElement(
          'div',
          rootProps,
          React.createElement(
            'div',
            { className: 'dshwb-collapsed-wrap' },
            state.phase === 'ready' && total !== null
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dshwb-teaser',
                    onClick: () => controller.setCollapsed(false),
                    title: translate('expand'),
                  },
                  `${symbolOf(currency)}${formatAmount(total, currency)}`,
                )
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshwb-mini',
                onClick: () => controller.setCollapsed(false),
                title: translate('expand'),
                'aria-label': translate('expand'),
              },
              React.createElement('img', { src: AVATAR_URL, alt: '', draggable: false }),
              React.createElement('span', { className: 'dshwb-dot' }),
            ),
          ),
        );
      }

      const body = [];
      if (state.phase === 'signed-out') {
        body.push(React.createElement('div', { className: 'dshwb-note', key: 'out' }, translate('signedOut')));
      } else if (state.phase === 'error' && state.balance === null) {
        body.push(
          React.createElement(
            'div',
            { className: 'dshwb-note dshwb-error', key: 'error' },
            translate(state.errorKey ?? 'quotaFailed'),
          ),
        );
      } else if (total === null) {
        body.push(
          React.createElement(
            'div',
            { className: 'dshwb-note', key: 'empty' },
            state.phase === 'loading' ? translate('loading') : translate('noAmount'),
          ),
        );
      } else {
        body.push(
          React.createElement(
            'div',
            { className: 'dshwb-body', key: 'amount' },
            React.createElement('span', { className: 'dshwb-currency' }, symbolOf(currency)),
            React.createElement(
              'span',
              {
                className: 'dshwb-amount',
                role: 'button',
                tabIndex: 0,
                title: translate('refresh'),
                onClick: () => controller.refresh(),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  controller.refresh();
                },
              },
              formatAmount(total, currency),
            ),
            React.createElement('span', { className: 'dshwb-suffix' }, currency),
          ),
        );
        if (bonusTotal !== null && bonusTotal > 0) {
          body.push(
            React.createElement(
              'div',
              { className: 'dshwb-sub', key: 'bonus' },
              `${translate('granted')} ${symbolOf(currency)}${formatAmount(bonusTotal, currency)}`,
            ),
          );
        }
        if (state.phase === 'error') {
          body.push(
            React.createElement(
              'div',
              { className: 'dshwb-note dshwb-error', key: 'stale' },
              translate(state.errorKey ?? 'quotaFailed'),
            ),
          );
        }
      }
      if (alert) {
        body.push(React.createElement('div', { className: 'dshwb-note dshwb-error', key: 'alert' }, translate('lowAlert')));
      }

      const time = formatTime(state.updatedAt);
      const footNote =
        state.phase === 'ready' && time !== ''
          ? translate('updated', { time })
          : state.phase === 'loading'
            ? translate('loading')
            : state.phase === 'idle'
              ? translate('tapToRefresh')
              : translate('retry');

      return React.createElement(
        'div',
        rootProps,
        React.createElement(
          'div',
          { className: 'dshwb-stage' },
          React.createElement(
            'div',
            { className: 'dshwb-card' },
            React.createElement(
              'div',
              { className: 'dshwb-head' },
              React.createElement('img', { className: 'dshwb-avatar', src: AVATAR_URL, alt: '', draggable: false }),
              React.createElement('span', { className: 'dshwb-name' }, translate('speaker')),
              React.createElement(
                'span',
                { className: 'dshwb-pill' },
                state.phase === 'ready' && !alert
                  ? translate('balanceLabel')
                  : state.phase === 'ready'
                    ? '!'
                    : state.phase === 'loading'
                      ? '…'
                      : translate('retry'),
              ),
            ),
            ...body,
            React.createElement(
              'div',
              { className: 'dshwb-actions' },
              React.createElement('span', { className: 'dshwb-time', title: state.updatedAt ?? '' }, footNote),
              React.createElement('span', { className: 'dshwb-spacer' }),
              state.phase === 'error'
                ? React.createElement(
                    'button',
                    { type: 'button', className: 'dshwb-link', onClick: () => controller.refresh() },
                    translate('retry'),
                  )
                : null,
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshwb-icon dshwb-icon-refresh',
                  onClick: () => controller.refresh(),
                  disabled: state.phase === 'loading',
                  title: translate('refresh'),
                  'aria-label': translate('refresh'),
                },
                ICONS.refresh,
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshwb-icon',
                  onClick: () => controller.setCollapsed(true),
                  title: translate('collapse'),
                  'aria-label': translate('collapse'),
                },
                ICONS.collapse,
              ),
            ),
          ),
          React.createElement('div', { className: 'dshwb-tail' }),
        ),
        React.createElement(
          'div',
          { className: 'dshwb-hero', onPointerDown, title: translate('tapToRefresh') },
          React.createElement('span', { className: 'dshwb-alert-mark', 'aria-hidden': 'true' }, '!'),
          React.createElement('img', { src: ART_URL, alt: translate('speaker'), draggable: false }),
        ),
      );
    }

    /* ── plugin body ─────────────────────────────────────────────────────────── */

    /** Required client services; a missing one keeps the fiber pending, never broken. */
    const inject = ['slots', 'locale'];

    /**
     * Count the entries currently registered (or declared) for `shell.overlay`.
     * @param ctx - client root context.
     * @returns entry count, or -1 when the registry does not expose it.
     */
    function slots_entries(ctx) {
      try {
        return ctx.slots.entries('shell.overlay').length;
      } catch {
        return -1;
      }
    }

    /**
     * Register the whale-girl into the root `shell.overlay` list slot.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      // A render crash is absorbed by the slot error boundary, which is silent for the
      // operator; mirror anything that escapes to the Host log so it is diagnosable.
      try {
        if (WINDOW !== undefined && typeof WINDOW.addEventListener === 'function') {
          WINDOW.addEventListener('error', (event) => {
            const text = `${event?.message ?? ''} ${event?.filename ?? ''}`;
            if (!/whale|dshwb/i.test(text)) return;
            diag('window:error', { message: String(event?.message ?? '').slice(0, 400), line: event?.lineno ?? 0 });
          });
        }
      } catch {
        /* instrumentation only */
      }

      diag('apply:start', {
        hasSlots: typeof ctx.slots?.inject === 'function',
        hasLocale: typeof ctx.locale?.register === 'function',
        hasEffect: typeof ctx.effect === 'function',
      });
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, LOCALE), 'whale-balance: locale');
        diag('apply:locale-registered', {});

        const namespace = LOCALE_NAMESPACE;
        const requestClientMetadata = () => {
          let locale = 'zh';
          try {
            const active = ctx.locale.getSnapshot()?.active;
            if (typeof active === 'string' && active !== '') locale = active;
          } catch {
            /* keep the Chinese default */
          }
          return {
            version: 'whale-balance/0.1.0',
            locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          };
        };

        const controller = createController({
          remote: () => (typeof ctx.get === 'function' ? ctx.get('remote') : undefined),
          requestClientMetadata,
        });

        const removeStyles = typeof document === 'undefined' ? () => {} : installStyles(document);
        ctx.effect(() => removeStyles, 'whale-balance: styles');
        ctx.effect(() => () => controller.dispose(), 'whale-balance: controller');
        diag('apply:styles', {
          styleTag: typeof document === 'undefined'
            ? false
            : !!document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`),
        });

        ctx.slots.inject('shell.overlay', () => {
          diag('slot:declared', { entities: slots_entries(ctx) });
          const dispose = ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'whale-balance',
              locale: namespace,
              inject: () => ({ whaleFace: { controller } }),
            },
            WhaleBalanceWidget,
          );
          diag('slot:registered', {});
          return dispose;
        });
        diag('apply:pending-slot', {
          declared: slots_entries(ctx) > 0,
          spec: typeof ctx.slots.spec?.('shell.overlay'),
        });

        console.info('[whale-balance] whale-girl balance bubble registered');
      } catch (error) {
        // A client plugin that throws during apply blanks the page; never let that happen.
        diag('apply:failed', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) });
        console.warn('[whale-balance] mount failed (UI stays untouched)', error);
      }
    }

    /** Exposed for `node --test` only; the page never reads this. */
    exports.__test = { formatAmount, formatTime, totalOf, isLow, createController, LOCALE };

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'whale-balance';
    return module.exports;
  },
});
