# 鲸鱼娘余额气泡 · dsh-whale-balance 0.2.3

以 `deepseek-whale-girl.png` 和 `good-girl-bubble.png` 两张原图组成可交互的表情包。人物为主体，气泡在左上方，默认显示 DSH 登录账号的余额。

## 使用

- 初始显示余额；每点击一次人物，立即轻微弹跳，并按 **余额 → 好女孩 → 哦鲸鲸 → 计费时段 → 余额** 循环。
- 每 30 秒刷新余额；切回余额、窗口重新获得焦点、恢复网络时也会刷新。后台页面暂停定时查询。
- 自动刷新只更新余额数据，不改变当前台词。回到余额时显示最新查询结果。
- 按住人物拖动；悬停可看到刷新和收起按钮。收起后点人物展开。位置和收起状态会保留。
- `Tab` 可聚焦人物，`Enter` / 空格可切换。系统开启“减少动态效果”时停用弹跳。
- 查询失败会保留并明确标记上次成功的余额；首次失败不会显示虚构的零余额。退出账号后清空旧余额。

## 计费时段台词（0.2.3 新增）

轮转的第四个位置是**计费时段台词**，按当前时段二选一，两者共用同一个位置、永远不会同时出现：

| 时段 | 台词 | 副标题 |
| --- | --- | --- |
| 计费峰时 | `梁文峰...` | 计费峰时 |
| 计费谷时 | `梁文谷!!!` | 计费谷时 |

判定规则取自 DeepSeek 官方模型与价格页：**峰时 = 01:00–04:00 与 06:00–10:00（UTC），且仅周一至周五**；其余全部为谷时（峰价为谷价的两倍）。

| 时段 | UTC | 北京时间 |
| --- | --- | --- |
| 峰 | 01:00–04:00、06:00–10:00（周一至周五） | 09:00–12:00、14:00–18:00 |
| 谷 | 其余全部时间（含周末与节假日） | 其余 |

两个要注意的细节：

1. **峰时是两个分开的窗口** —— 04:00–06:00（UTC）夹在中间，是谷时。按「一整段」理解会算错。
2. **时段在每次刷新和每次点击时重新判定**，所以跨过窗口边界后不会残留过期台词；周末与节假日的峰时窗口按谷时处理。

已知限制：**中国法定节假日未做剔除**。官方口径里节假日整体算谷时，而识别节假日需要维护一份日历，因此本版只按「UTC 时段 + 工作日」判定 —— 落在节假日里的工作日峰时窗口会被误判为峰时。要精确剔除的话，需要接入一份节假日表。

## 余额含义

本版沿用原插件的 **DSH 登录账号余额**，调用 `ctx.remote.account.getBalance()`，与 DSH「设置 → 账号」使用同一接口。

气泡主行显示充值钱包；赠金单独列在下面，币种分别显示，不把人民币和美元相加。悬停可查看最后成功更新时间。它是每 30 秒轮询，不是服务器主动推送。

仅配置 API Key 而没有登录 DSH 账号时，气泡会提示登录；本版不直接调用 `/user/balance` 查询另一个 API Key 的余额。插件不读取账号凭据文件，不保存 token、API Key 或余额，也不向模型发送点击消息。

## 启动安全与 Remote 注入（0.2.2）

这一版修掉了两个会让插件「装上但什么都不显示」甚至「DSH 起不来」的问题，功能与外观没有任何改动。

### 1. `remote.account` 必须写进 `inject`

cordis 的上下文代理在读取**每一个被注入的路径**时做校验（`@deepseek-ai/cordis` 的 `ReflectService.handler.get`）。`ctx.get('remote')` 能拿到 Remote 服务，但在声明里没有 `remote.account` 时，访问它的 `.account` 属性会抛：

```text
Error: cannot get property "remote.account" without inject
```

0.2.0/0.2.1 的 `inject` 只有 `['slots', 'locale']`，所以 `apply` 里第一次读余额就抛错，插槽注册那一步根本没走到 —— 界面自然一片空白。现在声明为：

```js
name: 'whale-balance', inject: ['slots', 'locale', 'remote.account'], apply
```

### 2. `apply` 与渲染都必须 fail-soft

DSH 的 web 启动审计把「任何一个 entry 的 fiber 不是 ACTIVE」判为致命错误：一旦命中，整个界面停在启动失败页（表现就是「DSH 起不来」）。崩溃日志在
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`：

```text
Error: web boot: 1 entry did not activate
dsh-whale-balance: failed
```

因此：`apply` 内部任何异常只写 `console.warn('[whale-balance] activation failed; DSH startup is left untouched', error)`，绝不外抛；`Widget` 渲染体出错也只写 `render failed` 并返回 `null`（插件不显示，页面不受影响）。同时 `controller.subscribe` / `getSnapshot` 交给 React 前显式绑定 —— 原来传的是未绑定方法引用，React 调用时 `this` 丢失会直接抛错。

排查时先看 Console 里这两行警告，异常信息就在后面：

| 日志 | 含义 |
| --- | --- |
| `[whale-balance] activation failed; DSH startup is left untouched` | 注册阶段出错，插件不会显示 |
| `[whale-balance] render failed; the widget stayed off screen` | 渲染阶段出错，插件不显示 |

回归测试锁死了这两条契约（`test/client.test.mjs`）：`apply never throws, whatever the host context looks like` 用 6 种坏上下文断言不外抛；`the account Remote namespace is declared in inject, not merely read` 断言嵌套路径已声明；`a working host context still registers the widget` 断言兜底不等于静默失效。

如果哪天仍出现「启动失败」，执行下面这条即可让 DSH 正常起来（只改 profile 配置，不动插件内容）：

```powershell
node tools\profile-toggle.mjs --off    # 停用并移出 bundle 列表
node tools\profile-toggle.mjs          # 修好后重新启用
```

## 更新已有安装

你提供的安装源目录为：

```text
C:\Users\16686\Desktop\deepseek\dsh-whale-balance
```

本次更新仅替换该插件的 `package.json`、`cordis.patch.yml`、`README.md`、`lib/`，并添加 `src/` 和两张 PNG。原有插件配置和其他文件保留。更新工具会先把将被覆盖的内容复制到该目录的 `backups/<时间>/`，之后才写入新版。

**更新后重启 DeepSeek Harness 桌面应用**。只重新打开设置页可能仍使用旧的内存模块；若界面仍显示旧版，完全退出应用后重新启动。

如需回退，用备份中的同名文件覆盖当前文件后重启应用。新增的 `src/` 与 PNG 不影响旧版运行。

其他机器可在 DSH「设置 → 插件」的本地安装入口选择这个插件目录。`package.json` 已包含 `dsh.bundle` 和浏览器入口。此处 `dsh.client.platform: web` 是 DSH 的渲染层声明，桌面壳也加载这个客户端入口。

## 开发和验证

```powershell
npm run build
npm test
```

运行插件本身不需要安装依赖；构建也只使用 Node 内置功能。两张 PNG 逐字节嵌入客户端包，透明通道保留，无需额外图片服务器或第三方图片地址。原气泡的字由白色内容层遮住，动态文字绘制在其上，原图文件保持不变。

React 开发依赖只用于本机交互预览：

```powershell
npm ci --ignore-scripts
node tools/preview.mjs
# 打开 http://127.0.0.1:4317
```

预览中的余额均为演示数据，不是实际账号余额。真正余额的联网验证需在已登录 DSH 的应用内完成。

已验证本机 DSH `0.2.0-rc.2` 的模块声明、客户端加载协议、`shell.overlay` 插槽以及账号 Remote 数据结构。后续 DSH 预览版接口若有变更，可能需要适配。
