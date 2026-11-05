//! 全局共享状态。

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use tokio::sync::Mutex;

use crate::model::DeviceSnapshot;
use crate::session::SessionHandle;

/// 设备静态信息缓存(避免反复查询)
#[derive(Debug, Default, Clone)]
pub struct CachedDevice {
    pub name: Option<String>,
    pub product_version: Option<String>,
    pub product_type: Option<String>,
    /// 上次查询时间(失败后要等一会儿再重试)
    pub attempted_at: Option<Instant>,
}

/// 应用级共享状态(由 Tauri 托管为 `Arc<Shared>`)
#[derive(Default)]
pub struct Shared {
    /// 已建立的定位会话:udid -> 句柄
    pub sessions: Mutex<HashMap<String, SessionHandle>>,
    /// 正在连接的设备集合
    pub connecting: Mutex<HashSet<String>>,
    /// 最近一次扫描到的设备列表
    pub devices: Mutex<Vec<DeviceSnapshot>>,
    /// 设备静态信息缓存
    pub cache: Mutex<HashMap<String, CachedDevice>>,
}
