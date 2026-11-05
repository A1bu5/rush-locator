# 第三方组件与服务声明

RUSH Locator 基于以下开源项目构建,谨向其作者致谢。本项目自身以 MIT 协议开源(见 `LICENSE`)。

## 主要 Rust 依赖

| 组件 | 协议 | 项目地址 |
| --- | --- | --- |
| [idevice](https://crates.io/crates/idevice) | MIT | https://github.com/jkcoxson/idevice |
| [jktcp](https://crates.io/crates/jktcp) | MIT | https://github.com/jkcoxson/jktcp |
| [tauri](https://crates.io/crates/tauri) | MIT OR Apache-2.0 | https://tauri.app |
| [axum](https://crates.io/crates/axum) | MIT | https://github.com/tokio-rs/axum |
| [reqwest](https://crates.io/crates/reqwest) | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| [rustls](https://crates.io/crates/rustls) | Apache-2.0 OR MIT OR ISC | https://github.com/rustls/rustls |
| [tokio](https://crates.io/crates/tokio) | MIT | https://tokio.rs |
| [serde](https://crates.io/crates/serde) / [serde_json](https://crates.io/crates/serde_json) | MIT OR Apache-2.0 | https://serde.rs |
| [plist](https://crates.io/crates/plist) | MIT | https://github.com/ebarnard/rust-plist |
| [tracing](https://crates.io/crates/tracing) | MIT | https://github.com/tokio-rs/tracing |
| [thiserror](https://crates.io/crates/thiserror) | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |

## 主要前端依赖

| 组件 | 协议 | 项目地址 |
| --- | --- | --- |
| [React](https://react.dev) / React DOM | MIT | https://github.com/facebook/react |
| [MapLibre GL JS](https://maplibre.org) | BSD-3-Clause | https://github.com/maplibre/maplibre-gl-js |
| [Vite](https://vite.dev) | MIT | https://github.com/vitejs/vite |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | https://github.com/microsoft/TypeScript |

## 地图瓦片服务

应用内置本地瓦片代理,按需从以下服务获取瓦片并在本地缓存:

- **高德地图**(`webrd0x.is.autonavi.com` / `webst0x.is.autonavi.com`):中国大陆区域的
  道路与卫星底图,使用须遵守[高德开放平台服务条款](https://lbs.amap.com/)及 Apple/高德相关授权。
- **Esri ArcGIS 在线底图**(`server.arcgisonline.com`):全球深色/浅色/卫星底图,
  使用须遵守 [Esri 使用条款](https://www.esri.com/en-us/legal/terms/full-master-agreement)。

瓦片版权归各自提供方所有;本项目仅做请求转发与本地缓存,不重新分发瓦片数据。

## 数据来源

- `src-tauri/src/device_names.rs` 中的产品标识符与市场名称对应关系为
  Apple 公开产品标识符(ProductType)的**事实性映射**,覆盖 iOS 17+ 支持的 iPhone / iPad。
- 协议实现思路参考了 [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)(GPL-3.0)
  与 [go-ios](https://github.com/danielpaulus/go-ios)(MIT),本项目未包含其源代码。
