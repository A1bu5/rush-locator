# RUSH Locator

> iPhone 虚拟定位工作台 —— 用 Rust 重写 `pymobiledevice3` 的定位链路,配一个漂亮的可视化界面。

基于 **Tauri 2 + React + MapLibre** 的跨平台桌面应用(macOS / Windows / Linux),
通过纯 Rust 协议栈与 iOS 设备通信,在**无需 root、无需 Xcode、无需 pymobiledevice3** 的前提下:

- 建立内置软件隧道(usbmuxd + CoreDeviceProxy + 用户态 TCP 栈)
- 连接 DVT(dtservicehub)→ `LocationSimulation` 服务
- 实时改写设备的 GPS 位置

> ✅ 已在真机验证:**iPhone 17 Pro Max / iOS 26.6.2**(USB)
> —— 隧道建立、单点定位、路线回放(266m 折线 @60km/h)、清除定位全部通过。

## 功能

| 模块 | 说明 |
| --- | --- |
| 设备发现 | 自动扫描 usbmuxd(USB / Wi-Fi),显示设备名、系统版本、连接方式 |
| 单点定位 | 地图点选 / 经纬度输入,一键设置虚拟位置;一键清除恢复真实 GPS |
| 路线模拟(核心) | 导入 GPX(航迹/路线/航点)或在地图上手绘路线,按设定速度回放 |
| 回放控制 | 开始 / 暂停 / 继续 / 停止(可选清除),循环回放、终点保留 |
| 拟真移动 | 按 8m 间距细分路线 + 平滑插值;可开启 ±15% 速度抖动模拟真人 |
| 进度可视化 | 地图上实时绘制"已走过"轨迹、朝向箭头、脉冲位置标记;进度条 + 里程 / 用时 / ETA / 当前速度 / 圈数 |
| 设备信息面板 | 型号(市场名)、iOS 版本、构建号、序列号、电量(含充电状态)、隧道方式 |
| **内置地图加速** | 本地瓦片服务 + 持久化磁盘缓存:已浏览区域秒开、断网可看;设置定位后自动预热周边瓦片 |
| 地图底图 | 高德 / 高德卫星(国内快、中文注记);深色 / 浅色 / 卫星(Esri,全球覆盖);境外自动切换 |

### 关于地图加载速度

地图瓦片不直接访问境外 CDN,而是走**内置的本地瓦片服务**(Rust 后端,监听 `127.0.0.1` 随机端口):

```
MapLibre → http://127.0.0.1:<port>/tiles/<provider>/<z>/<x>/<y>.png
              │ 命中缓存 → 直接返回(磁盘)
              └ 未命中   → 从上游拉取 → 落盘 → 返回
```

- 缓存位置:`<系统缓存目录>/com.rush.locator/tiles/`(macOS:`~/Library/Caches/com.rush.locator/tiles`)
- 首次浏览某区域后,该区域**永久秒开**,离线/弱网也能显示已缓存部分
- 样式 JSON / 字体 / sprite 全部本地构建,不再有额外的远程往返
- 底图选择(均已实测当前网络可达):
  - **高德 / 高德卫星**:国内加载快、中文注记;使用 GCJ-02 坐标系,应用已内置
    WGS-84 ↔ GCJ-02 双向换算,点击选点与设备定位均无偏移
  - **深色 / 浅色 / 卫星**:Esri ArcGIS 在线底图,全球覆盖(WGS-84)
- **境外自动切换(缩放感知)**:高德在境外只有低级别概览数据(路网 ≤z9,卫星 ≤z6),
  再放大就会变成空白/占位图。届时自动切到对应的全球底图(高德→深色、高德卫星→卫星),
  回到国内后自动切回;若你在境外手动选择了高德,应用会尊重你的选择,回国后恢复自动切换
- 内置服务不可用时会自动降级为直连上游 CDN

## 技术架构

```
┌────────────────────────── 前端 (WebView) ──────────────────────────┐
│  React 19 + MapLibre GL(深色/浅色/卫星/标准 四种底图)            │
│  设备面板 · 控制坞 · 路线编辑器 · 进度可视化                       │
└──────────────────────────────┬─────────────────────────────────────┘
                        Tauri IPC(命令 + 事件)
┌──────────────────────────────┴─────────────────────────────────────┐
│                     Rust 后端 (src-tauri)                          │
│                                                                    │
│  devices.rs   设备轮询(usbmuxd)与列表事件                         │
│  session.rs   每台设备一个 actor:                                 │
│     usbmuxd → CoreDeviceProxy(CDTunnel)→ 用户态 TCP 栈            │
│     → RSD 握手 → DVT dtservicehub → LocationSimulation            │
│     → 串行处理:设置/清除坐标、路线回放、电量刷新                  │
│  route.rs     路线细分、Haversine、回放状态机(含单元测试)         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ 纯 Rust 协议栈
                     idevice crate (MIT)
          usbmuxd / lockdownd / RSD / DTX / CDTunnel / jktcp
```

设计要点:

- **actor 模式**:`LocationSimulationClient` 借用 `RemoteServerClient`(Rust 生命周期),
  会话任务独占两者并以 `mpsc` 指令串行驱动,天然避免并发状态错乱;
  回放 tick(60ms)在任务内与指令处理 `select!` 复用,暂停/停止即时响应。
- **回放只在需要时下发**:按 200ms 间隔 + 位移阈值向设备推送坐标,
  界面进度按 tick 平滑刷新(320ms 位置过渡动画)。
- **隧道回退**:内置 CoreDeviceProxy 隧道建立失败时,自动尝试本地
  `pymobiledevice3 tunneld`(127.0.0.1:49151),并在信息面板标注隧道方式。

## 环境要求

- Rust **1.99+**(由 `src-tauri/rust-toolchain.toml` 固定)
- Node.js 20+ / npm
- macOS 11.0+(Intel / Apple Silicon 均可)、Windows 10+ 或带 WebKitGTK 的 Linux 发行版
- 一台 iOS 17 – iOS 26 设备(USB 优先;Wi-Fi 需先在 iTunes/devicectl 侧完成配对)
- 设备需:**解锁**、**信任本机**、**开启开发者模式** (设置 → 隐私与安全性 → 开发者模式)

## 安装(macOS)

1. 打开 `RUSH Locator_0.1.0_universal.dmg`,把 **RUSH Locator** 拖入「应用程序」。
2. 首次打开若提示"无法验证开发者"(应用未使用 Apple 开发者证书公证,为 ad-hoc 签名):
   - 方式一:在「应用程序」中**右键 → 打开**,再点「打开」;
   - 方式二:`xattr -dr com.apple.quarantine "/Applications/RUSH Locator.app"`;
   - 方式三:系统设置 → 隐私与安全性 → 底部「仍要打开」。
3. 安装包为 **Universal 二进制**(x86_64 + arm64),Intel Mac 与 Apple Silicon 均原生运行。

## 开发与构建

```bash
npm install            # 安装前端依赖
npm run tauri dev      # 开发模式(热重载)
npm run tauri build    # 打包(当前架构)
```

macOS 通用安装包(Intel + Apple Silicon 一份搞定):

```bash
npm run tauri build -- --target universal-apple-darwin
```

产物在 `src-tauri/target/<目标>/release/bundle/` 下:

| 产物 | 说明 |
| --- | --- |
| `dmg/RUSH Locator_<版本>_<架构>.dmg` | 安装包:打开后把 App 拖进「应用程序」即可 |
| `macos/RUSH Locator.app` | 应用本体,可直接拖入「应用程序」 |

后端测试:

```bash
cd src-tauri
cargo test             # 路线引擎单元测试
cargo clippy           # 静态检查
```

## 使用流程

1. 连接 iPhone:
   - **USB**:使用支持数据传输的数据线,手机解锁并「信任此电脑」;
   - **Wi-Fi**:iPhone 与电脑处于同一网络,且在 Apple 工具侧完成过配对
     (列表中会显示「无线」标识)。
   - 若设备未出现,点击设备区右上角的**刷新按钮**重新扫描;
     iPhone 休眠或切换网络时,Wi-Fi 设备可能暂时从 usbmuxd 消失。
2. 点击 **连接设备**:自动建立隧道并打开定位服务(首次约 2–5 秒)。
3. **单点定位**:选择「单点定位」页签 → 点击「点击地图定位」→ 单击地图任意位置。
4. **路线模拟**:
   - 「绘制路线」在地图上逐点勾勒,航点可拖动微调;或「导入 GPX」加载轨迹;
   - 调整速度(1–160 km/h,含步行/跑步/骑行/驾车/高速预设)与抖动/循环/终点保留;
   - 点击 ▶ 开始回放,进度、航向、剩余时间实时呈现;⏸ 暂停、■ 停止、🗑 停止并清除。
5. 断开连接或应用退出时,自动清除虚拟定位,设备恢复真实 GPS。

> 说明:同一 iOS 设备同一时间只允许一个定位会话。多个工具同时连接会互相抢占,
> 表现为其中一个悄悄失效——请先断开其它工具(iAnyGo、Xcode 等)。

## 兼容性与已知限制

| 场景 | 状态 |
| --- | --- |
| iOS 17.4 – 26(USB) | ✅ 内置隧道,开箱即用 |
| iOS 17.4 – 26(Wi-Fi) | ✅ 需先在 Apple 工具侧完成配对;设备休眠时可能暂时从列表消失 |
| iOS 17.0 – 17.3 | ⚠️ 无 CoreDeviceProxy,可运行 `pymobiledevice3 tunneld` 后自动回退 |
| iOS ≤ 16 | ❌ 不在范围内(需 DeveloperDiskImage + lockdown DVT 路径) |
| 地图瓦片 | 内置本地代理 + 磁盘缓存:首次浏览需要网络,之后秒开、断网可看已缓存区域 |

## 目录结构

```
rush-locator/
├── src/                       # React 前端
│   ├── components/            # MapView / DevicePanel / ControlDock / Toasts
│   ├── lib/                   # geo(含 GCJ-02 纠偏)/ gpx / mapStyles / format
│   ├── App.tsx                # 状态编排与事件订阅
│   └── styles.css             # 设计系统(深色玻璃质感)
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs             # Tauri 命令入口
│   │   ├── devices.rs         # usbmuxd 轮询
│   │   ├── session.rs         # 隧道 + DVT + 会话 actor
│   │   ├── route.rs           # 路线几何与回放状态机
│   │   ├── tiles.rs           # 内置瓦片服务(本地代理 + 磁盘缓存)
│   │   ├── device_names.rs    # ProductType → 市场名称映射
│   │   ├── model.rs           # 共享数据模型
│   │   └── state.rs           # 全局共享状态
│   └── tauri.conf.json
└── app-icon.svg               # 应用图标源文件
```

## 开源协议

本项目以 [MIT 协议](LICENSE)开源。第三方组件、地图服务与数据的授权说明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 致谢

- 协议栈:[`idevice`](https://github.com/jkcoxson/idevice)(usbmuxd / lockdown / RSD / DTX /
  CDTunnel,纯 Rust)与 [`jktcp`](https://github.com/jkcoxson/jktcp)(用户态 TCP 栈);
- 框架:[Tauri](https://tauri.app) / [React](https://react.dev) / [MapLibre GL JS](https://maplibre.org);
- 协议研究与调试思路:[pymobiledevice3](https://github.com/doronz88/pymobiledevice3)、
  [go-ios](https://github.com/danielpaulus/go-ios);
- 底图:高德地图、Esri ArcGIS 在线底图。

## 免责声明

本项目仅用于**应用开发与测试**。请遵守 Apple 软件许可协议及当地法律法规,
不要将虚拟定位用于作弊、欺诈等违规用途。使用本软件产生的任何后果由使用者自行承担。
