# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-09
- Primary product surfaces: 手机浏览器中的 tmux/Codex 控制台、单机 Node 服务
- Evidence reviewed: 空仓库；运行环境中存在 tmux 3.4、Node 24，`leo_lab` 有 9 个 Codex pane

## Brand
- Personality: 安静、可靠、偏工具感；让用户快速确认“我连到了哪一个会话”。
- Trust signals: 明确显示连接状态、当前 tmux session/window、访问令牌说明和只允许 tmux 操作的后端边界。
- Avoid: 伪装成完整远程桌面、过度装饰、把原始 shell 执行能力暴露给浏览器。

## Product goals
- Goals: 手机选择 tmux session；查看其中的 Codex pane；读取最近终端内容；向当前 pane 发送文本和常用控制键；在网络波动时可恢复。
- Non-goals: 文件浏览、任意 shell API、桌面级终端模拟、多人协作权限系统。
- Success signals: 首屏可在几秒内选中 `leo_lab`；9 个 pane 可辨识；输入发送后能看到 Codex 响应；无令牌不能读取或修改 tmux。

## Personas and jobs
- Primary personas: 在电脑前运行多个 Codex 的个人开发者。
- User jobs: 离开电脑后从手机查看某个 Codex 是否完成、继续对话、发送 Ctrl-C/Enter 等控制操作。
- Key contexts of use: 手机竖屏、局域网或 Tailscale/SSH 隧道、单手操作、短时快速查看。

## Information architecture
- Primary navigation: session rail → pane list → terminal output + composer。
- Core routes/screens: `/` 应用壳；令牌解锁态；session/pane 选择态；连接错误/空状态。
- Content hierarchy: 当前 session 名 > pane 的 window 名和 Codex 标题 > 最近终端输出 > 输入区。

## Design principles
- Principle 1: 先定位，再操作；当前 session、window、pane 始终可见。
- Principle 2: 原始终端输出优先于二次解析；不猜测 Codex 消息结构。
- Principle 3: 移动端触控目标足够大，危险/高影响控制键需要显式按钮。
- Tradeoffs: 轮询优先于引入 WebSocket 依赖，以保持自托管安装简单；输出使用捕获文本而非完整终端仿真。

## Visual language
- Color: 深色终端底色，暖珊瑚色作为唯一主操作色，冷灰用于层级和状态。
- Typography: 系统无衬线用于导航，等宽字体用于 pane 标签、终端和输入。
- Spacing/layout rhythm: 8px 基础间距；桌面双栏，手机改为上下分区和横向滚动 pane 条。
- Shape/radius/elevation: 12px 卡片圆角，细边框，低对比阴影；终端区域保持近方形和高对比。
- Motion: 仅使用短促的连接/刷新过渡；支持 `prefers-reduced-motion`。
- Imagery/iconography: 品牌入口使用项目自有的极简 Pocket + tmux 分屏图标；其余操作图标继续使用 CSS/文本符号，不引入图标依赖。

## Components
- Existing components to reuse: 无。
- New/changed components: AuthGate、SessionRail、PaneStrip、PaneRenamer（任意 pane 独立显示名，单-pane window 同步 tmux 窗口名）、MobileQuickSwitcher（深色底部选择面板）、TerminalViewport、Composer（最多 10 个混合附件的可移除队列）、ConnectionBadge、Toast。
- Variants and states: loading、selected、busy/标题 spinner、dead pane、empty、unauthorized、offline、附件待发送/上传中/部分无效。
- Token/component ownership: `public/styles.css` 统一 CSS 变量；`public/app.js` 仅负责状态和 DOM 更新。

## Accessibility
- Target standard: WCAG 2.1 AA 的实用子集。
- Keyboard/focus behavior: 令牌输入和消息输入可回车提交；移动端消息框随长文本增高或软键盘可视区变化时保持光标可见，输入聚焦期间终端轮询不抢夺页面滚动；按钮有可见 focus；MobileQuickSwitcher 支持方向键、Home/End、Escape 和选中项初始焦点；终端输出使用 `aria-live="polite"`，避免每次刷新抢焦点。
- Interaction consistency: 重命名对话框绑定打开时的 Pane；附件允许同名同大小的不同文件共存，批量上传部分失败时复用已成功上传的附件，避免重复上传。
- Contrast/readability: 输出与背景保持高对比；状态不能只依赖颜色。
- Screen-reader semantics: 使用 `nav`、`main`、`section`、button 和明确 label。
- Reduced motion and sensory considerations: 尊重 `prefers-reduced-motion`，不使用持续闪烁。

## Responsive behavior
- Supported breakpoints/devices: 先支持 360px 以上手机和常见桌面浏览器。
- Layout adaptations: 780px 以下 session 变为横向滚动条，pane 变为横向 chip；顶部保留 sticky 的 session / Pane 快速选择器，点击后打开统一的深色底部面板，避免原生系统弹窗破坏主题；输入区固定在终端底部附近。
- Touch/hover differences: 触控区域至少约 44px；hover 只作补充，不承载关键操作。

## Interaction states
- Loading: skeleton/文字状态，保留上一次输出。
- Empty: 没有 tmux server/session 时给出可执行提示。
- Error: 显示读取或发送失败，并保留重试入口；401 回到令牌解锁态。
- Success: 发送后立即刷新输出，连接 badge 显示最近更新时间。
- Disabled: 未选 pane、正在发送、dead pane 时禁用相关操作。
- Offline/slow network, if applicable: 轮询失败标记离线，恢复后自动继续；不伪造新输出。

## Content voice
- Tone: 简短、直接、可信；中文界面，tmux/Codex 技术名保留原文。
- Terminology: session 用“会话”，window 用“窗口”，pane 用“Pane”；不把 pane 强行称为“聊天”。
- Microcopy rules: 操作按钮使用动词；安全提示说明“只允许 tmux 目标和常用按键，不提供任意 shell API”。

## Implementation constraints
- Framework/styling system: Node.js 内置 `http`/`child_process`/`fs`；无运行时依赖；原生 HTML/CSS/JS。
- Design-token constraints: 所有颜色、圆角、间距集中在 CSS `:root` 变量。
- Performance constraints: 仅捕获当前 pane 最近 240 行；默认 1.5 秒轮询；不保存终端历史到磁盘。
- Compatibility constraints: Node 20+、tmux 3.x；访问端只需现代手机浏览器。
- Test/screenshot expectations: Node 内置测试覆盖认证、tmux 解析、输入白名单和 API；启动后做真实 tmux 冒烟检查。

## Open questions
- [ ] 是否需要公网访问或多人账号 / owner / impact：当前假设使用局域网、Tailscale 或 SSH 隧道的单用户模式。
- [ ] 是否需要保留历史对话或搜索：当前只展示 tmux 当前捕获历史，不落盘。
