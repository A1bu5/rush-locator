//! 前后端共享的数据模型(通过 serde 以 camelCase 传给前端)。

use serde::{Deserialize, Serialize};

/// 经纬度坐标
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

/// 设备列表快照(用于左侧设备面板)
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSnapshot {
    pub udid: String,
    /// 设备名(缓存的 lockdown 查询结果,未连接时也可能有)
    pub name: Option<String>,
    /// 连接方式标签,如 `USB` / `WiFi (fe80::…)`
    pub connection: String,
    /// 是否已建立定位会话(隧道 + DVT)
    pub connected: bool,
    /// 正在连接中
    pub connecting: bool,
    /// 缓存的系统版本
    pub product_version: Option<String>,
    /// 市场名称(由 ProductType 映射,如 “iPhone 17 Pro”)
    pub model: Option<String>,
}

/// 设备详细信息(右侧信息面板)
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDetails {
    pub udid: String,
    pub name: Option<String>,
    /// 市场名称,如 “iPhone 17 Pro”
    pub model_name: Option<String>,
    /// 硬件标识,如 “iPhone18,1”
    pub product_type: Option<String>,
    pub product_version: Option<String>,
    pub build_version: Option<String>,
    pub serial_number: Option<String>,
    /// 电量 0-100
    pub battery_level: Option<u32>,
    pub battery_charging: Option<bool>,
    pub connection: String,
    /// 隧道方式: `CoreDeviceProxy`(内置)或 `tunneld`(外部)
    pub tunnel: Option<String>,
}

/// 路线回放选项
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteOptions {
    /// 地面速度(km/h)
    pub speed_kmh: f64,
    /// 是否加入轻微速度抖动(更接近真人移动)
    pub jitter: bool,
    /// 走完是否循环
    pub loop_route: bool,
    /// 结束后是否保留最后一个点(否则清除虚拟定位)
    pub keep_final: bool,
    /// 向设备推送位置的间隔(毫秒)
    pub update_ms: u64,
}

impl Default for RouteOptions {
    fn default() -> Self {
        Self {
            speed_kmh: 20.0,
            jitter: true,
            loop_route: false,
            keep_final: true,
            update_ms: 200,
        }
    }
}

/// 回放进度(推送给前端)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteProgress {
    pub udid: String,
    /// 正在播放(未暂停且未结束)
    pub playing: bool,
    pub paused: bool,
    pub finished: bool,
    pub position: LatLon,
    /// 航向角(0-360,北为 0)
    pub heading: f64,
    /// 当前速度(km/h,含抖动)
    pub speed_kmh: f64,
    /// 0.0 - 1.0
    pub progress: f64,
    pub distance_done_m: f64,
    pub distance_total_m: f64,
    pub elapsed_s: f64,
    /// 预计剩余时间(秒)
    pub eta_s: f64,
    pub loop_count: u32,
}

/// 设备会话状态变更事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStateEvent {
    pub udid: String,
    /// connecting | connected | disconnected | error
    pub state: String,
    pub message: Option<String>,
    pub details: Option<DeviceDetails>,
}
