# dsh-whale-balance · 鲸鱼娘余额气泡

给 DeepSeek Harness 的 Web GUI 加一只**鲸鱼娘**：她蹲在右下角，用自己的聊天气泡实时报出你
DeepSeek 账号的余额。点她一下就刷新，余额见底她会换成担心的表情并变红提醒。

```
        ╭───────────────────────────────╮
        │ (头像) 鲸鱼娘          余额   │
        │                               │
        │ ¥ 42.50  CNY                  │
        │ 赠金余额 ¥ 5.00               │
        │ ─────────────────────────     │
        │ 更新于 21:04:12      ⟳   ✕    │
        ╰───────────────────────────────╯
                     ◣
                  ╭──────╮
                  │ 鲸鱼娘 │   ← 点一下刷新 / 按住可以拖动
                  ╰──────╯
```

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 实时余额 | 每 60 秒自动读一次，数据来自 DSH 官方的 `account` Remote，和「设置 → 账号」里显示的数字完全一致 |
| 点击刷新 | 点鲸鱼娘、点余额数字、点 ⟳ 都可以立刻刷新；刷新中图标旋转，气泡里有「更新时间」 |
| 余额不足告警 | 所有钱包都低于阈值（默认 ¥5）时：鲸鱼娘变红、气泡抖动、出现 `!` 角标，并写一行提醒 |
| 可拖动 | 按住鲸鱼娘拖动，位置记在 `localStorage`，窗口缩放时自动贴边 |
| 可折叠 | 点 ✕ 收起成小头像 + 余额胶囊（余额不足时右上角有红点）；点一下展开 |
| 主题跟随 | 面板用 `light-dark()` 配色，明暗主题自动适配；支持 `prefers-reduced-motion` |
| 中英双语 | 通过 DSH 的 locale 服务注册 `whaleBalance` 词条，跟随界面语言切换 |

余额读取失败的每一种情况都有独立文案：未登录、余额服务无响应、Platform 拒绝查询、账号还没有钱包。

## 安装

### 已经装好了

本机已经装进 `desktop` profile：包被 link 到
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-balance`，profile 的
`package.json`（依赖 + `dsh.profile.bundles`）和 `cordis.patch.yml` 各加了一行，
两份原文件都留有 `*.before-whale-balance-*.bak` 备份。

**刷新一次 GUI 页面**即可看到鲸鱼娘。Host 半边已经热加载生效（可以直接验证）：

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/api/whale-balance/whale-girl.jpg
# 200
```

### 自己装（或换机器）

插件管理器支持本地目录路径安装：

1. 打开 GUI → **设置 → 插件**（Plugins）。
2. 在安装输入框里填这个目录的绝对路径：

   ```
   C:\Users\16686\Desktop\deepseek\dsh-whale-balance
   ```

3. 安装（pnpm 会把它 link 进 profile，并把 bundle 行写进 profile 配置）。
4. 页面会自动跟随模块图变化；若没出现，刷新一次 GUI 页面。

也可以直接用脚本做同一件事（会先备份 profile 文件）：

```powershell
node tools\install-profile.mjs              # 安装
node tools\install-profile.mjs --uninstall  # 卸载干净
node tools\verify-profile.mjs               # 验证解析链路与资源
```

卸载也可以直接用同一个 GUI 页面里的卸载按钮，鲸鱼娘会连同她的浮层、样式、定时器一起消失。

## 结构

```
dsh-whale-balance/
├── package.json           # dsh.bundle 层 + dsh.client(web) 声明
├── cordis.patch.yml       # 往 profile 里插一行 whale-balance
├── lib/
│   ├── index.js           # Host 半边：只负责用 /api/whale-balance/ 提供立绘
│   └── client.js          # 浏览器半边：shell.overlay 浮层 + 气泡 UI + 余额逻辑
├── assets/
│   ├── whale-girl.jpg         # 立绘（720×1040，已裁掉生成服务的水印）
│   └── whale-girl-avatar.jpg  # 折叠态头像（320×320）
└── tools/
    ├── gen-whale-girl.mjs    # 重新生成立绘（可换 prompt / seed）
    ├── prepare-art.py        # 裁剪水印、导出压缩图与头像
    ├── prompt-whale.txt      # 立绘 prompt
    ├── selftest.mjs          # node tools\selftest.mjs（8 项，零依赖）
    ├── install-profile.mjs   # link + profile 配置（可 --uninstall）
    └── verify-profile.mjs    # 从 profile 解析插件并自检两半
```

### 数据从哪来

浏览器半边调用 `ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })`，
即官方 `@deepseek-ai/dsh-api-account-controller` 暴露的同一个 Remote 方法；它由
`@deepseek-ai/dsh-deepseek-account-platform` 在 Host 侧用 `~/.dsh/.credentials.yaml` 里
已登录的授权向 `https://platform.deepseek.com/api/v0/users/get_user_summary` 查询。

**本插件不读、不存、不转发任何 token**：凭据始终留在 DSH 的 credentials 服务里，
插件只拿到已经投影好的 `{ currency, balance }` 数组。Host 半边唯一的路由只吐两张图片。

### 换掉立绘

立绘是原创生成图，风格和你在「设置 → 账号」看到的 DeepSeek 蓝一致，但它是**可以被替换**的：

```powershell
# 1) 重新生成（可选）
node tools\gen-whale-girl.mjs assets\whale-girl.raw.jpg 20261008 tools\prompt-whale.txt
# 2) 裁剪水印 + 导出压缩图与头像
<python> tools\prepare-art.py
```

或者直接把自己画的 `whale-girl.jpg`（竖版，人物居中）和 `whale-girl-avatar.jpg`（正方形头像）
覆盖到 `assets/` 下——文件名不变即可，代码里没有别的耦合。

## 边界与已知限制

- 只在 **Web GUI** 生效：`dsh.client.platform` 是 `web`，Electron 桌面壳不加载浏览器半边。
- 余额刷新是**轮询**（60 秒）而不是推送：账号状态流能告诉你「账号变了」，但不带余额数字。
- 面板位置与折叠状态存在浏览器 `localStorage`，换浏览器/清缓存后会回到默认的右下角。
- 立绘来自第三方文生图服务，是**原创但非官方**的鲸鱼娘形象；介意的话按上面的方法换图。
- 阈值目前是代码默认值 `5`，可通过 `controller.setAlertBelow()` 改，但没有做设置界面。
