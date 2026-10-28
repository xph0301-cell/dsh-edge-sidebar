# dsh-edge-sidebar

侧栏浏览器 tab 由本插件接管：把**真实 Microsoft Edge 窗口**（保留标题栏、标签栏、地址栏）整窗停到侧栏
面板体上。浏览器控件、输入法、下载、文件对话框都是 Edge 原生的；侧栏面板体在 DSH 侧栏头部**下方**，
所以窗口不会盖住 DSH 自己的“隐藏/折叠侧栏”按钮。

> 这不是 iframe、不是 canvas、不是逐帧投影；就是一个真正的 Edge 窗口，按面板体的矩形精确摆放。

## 做法

1. **接管 tab 类型**：注册 `kind: "browser"`、`priority: "extension"`，覆盖官方 `builtin` 浏览器
   类型。侧栏里任何“打开浏览器”（链接预览、`browser.new`、恢复的 tab）都进入本插件。
2. **面板体只负责量矩形**：客户端 body 就是一块页面宿主，持续上报它在屏幕上的矩形（CSS px）。
3. **宿主接管 Edge**：找到 `dsh-builtin-browser` 的那台 Edge（同一 profile、同一 CDP），
   用 `Browser.setWindowBounds` 把**整个窗口**放到面板体矩形上（不是只放网页视口）。
4. **保留浏览器 chrome**：标题栏、标签页、地址栏都在窗口内，用户可以直接切标签、输地址、前进后退。
5. **不越界**：面板体从 DSH 侧栏头部下方开始，整窗被限制在面板体内，不会盖住侧栏的隐藏/折叠按钮。
6. **原生跟随**：helper 进程里有一个 C# 线程每 **8 ms** 读取 `ClientToScreen(DSH)` 并 `SetWindowPos(Edge)`，
   把窗口钉在面板体的客户区偏移（`inset`）上。它不经过渲染进程定时器或 WebSocket 往返，所以拖动 DSH
   窗口时浏览器是“长”在侧栏上的，而不是慢半拍地吸附过来。
7. **跟随与隐藏**：面板不可见时 `SW_HIDE` 并停掉跟随线程，但 Edge 进程和 CDP 都活着，agent 可以继续用
   `dsh_browser_*` 操作同一个实例。

导航/历史走 CDP（`Page.navigate` / `getNavigationHistory` / `navigateToHistoryEntry` / `reload`），
所以 `edge_sidebar_show` 与 `dsh_browser_*` 操作的是同一页。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | host 半：起停靠服务、注册工具与 prompt 段 |
| `lib/dock.js` | host 半：接管 Edge、CDP 会话、整窗定位、可见性、导航 |
| `lib/dock-helper.ps1` | 唯一的 Win32 出口：`find-profile` / `own` / `place` / `hide` / `show`（另有裁剪原语，当前不使用） |
| `lib/tools.js` | `edge_sidebar_status` / `edge_sidebar_show` |
| `client.js` | client 半：遮蔽 `browser` kind、页面宿主测量、状态显示 |
| `cordis.patch.yml` | bundle patch（行名必须是包根名） |

## 安装

```sh
dsh plugin --profile desktop add <本目录>
# 重启 DSH Desktop 后生效（client 半只在窗口加载时注册）
dsh plugin --profile desktop remove dsh-edge-sidebar   # 卸载
```

诊断：插件会把工具解析/注册结果写到 `$DSH_HOME/edge-sidebar.log`。

## 给 agent 的工具

| 工具 | 作用 |
| --- | --- |
| `edge_sidebar_status` | 是否已接管 Edge、面板是否可见、当前 URL/标题 |
| `edge_sidebar_show` | 让侧栏那台 Edge 打开指定 URL（面板隐藏时也可用） |

## 已验证

- `probe-follow`：原生跟随线程（stand-in DSH 窗口 + 真实 Edge）→ 首次落位、移动 DSH 窗口后 250 ms 内
  逐像素跟上。**PASS**
- `probe-crop`（整窗停靠版）：接管 carrier Edge → **整个窗口**落在面板体矩形上（逐项断言
  x/y/w/h，且窗口顶部不低于面板顶部）→ 不应用窗口区域 → 隐藏/恢复 → 移动跟随 → 关闭服务只隐藏、
  不杀浏览器。**PASS**
- `probe-client`：`kind=browser` + `priority=extension`，body 不是 iframe，slot 注册正确。**PASS**
- `probe-tools` / `probe-host`：两个工具、无 `defineTool` 时的 plain 注册、服务起停。**PASS**

## 已知取舍

- **窗口形态**：侧栏里是一个带标题栏/地址栏的 Edge 窗口；这是有意的——保留下来的 chrome 让用户能
  直接操控浏览器。真正把 Edge 渲染进 DOM/父窗口已实测不可行（见文末）。
- **最小窗口宽度**：Edge 不允许窗口窄于约 520 CSS px。侧栏比这更窄时窗口会保持最小宽度，超出面板的
  部分由 Windows 裁到屏幕/窗口外（不会盖住侧栏头部）。
- **首次启动**：没有 carrier Edge 时，侧栏会拉起同一 profile 的 Edge（约 1 秒）；之后复用同一实例。
- **同一实例**：侧栏与 `dsh_browser_*` 共用 `dsh-builtin-browser` 的 Edge profile。
- **窗口归属**：停靠窗口是 DSH 的附属工具窗口，DSH 最小化时随之隐藏；不会单独出现在任务栏。
- 独立 profile：`<DSH_HOME>/dsh-builtin-browser-host/edge-profile`，与日常 Edge 分开。

## 为什么不是“真嵌入 / 页面裁剪”

- **在 Electron 里 `SetParent` 嵌入 Edge**：父窗口的合成表面盖住外来子 HWND，实测嵌入区域显示的是
  DSH 自己的界面；连纯色 WinForms 子窗口也画不出来。
- **DWM 缩略图**：`DwmRegisterThumbnail(dest=DSH 窗口)` 跨进程返回 `E_INVALIDARG`。
- **窗口区域裁剪（上一版）**：`SetWindowRgn` 能把页面视口裁出来，但 Edge 自己的浏览器 UI 覆盖层
  （翻译气泡、查找栏等）会画在区域之外；实测把侧栏头部的隐藏/折叠按钮挡了，而且裁掉 chrome 后
  用户没法方便地控制浏览器。因此改为整窗停靠，保留 chrome，只保证整窗在面板体内。
