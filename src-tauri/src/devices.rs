//! 设备发现:轮询 usbmuxd 维护设备列表,推送变化,并在设备消失时关闭对应会话。

use std::sync::Arc;
use std::time::{Duration, Instant};

use idevice::IdeviceService;
use idevice::services::lockdown::LockdownClient;
use idevice::usbmuxd::{Connection as UsbConnectionKind, UsbmuxdAddr, UsbmuxdDevice};
use tauri::{AppHandle, Emitter};
use tracing::warn;

use crate::model::DeviceSnapshot;
use crate::session::SessionCmd;
use crate::state::{CachedDevice, Shared};

/// 事件:设备列表更新
pub const EVENT_DEVICES: &str = "devices_updated";

/// 新设备信息查询失败后的重试间隔
const RETRY_AFTER: Duration = Duration::from_secs(60);

pub async fn run_watcher(app: AppHandle, shared: Arc<Shared>) {
    loop {
        if let Err(e) = scan_and_emit(&app, &shared).await {
            warn!("扫描 usbmuxd 失败:{e}");
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

/// 立即扫描一次设备并推送更新(后台轮询与手动刷新共用)。
pub async fn scan_and_emit(
    app: &AppHandle,
    shared: &Arc<Shared>,
) -> Result<Vec<DeviceSnapshot>, String> {
    let snapshots = scan(shared.clone()).await?;
    let changed = {
        let mut current = shared.devices.lock().await;
        if *current != snapshots {
            *current = snapshots.clone();
            true
        } else {
            false
        }
    };
    if changed {
        let _ = app.emit(EVENT_DEVICES, &snapshots);
    }
    reap_missing_sessions(shared.as_ref(), &snapshots).await;
    Ok(snapshots)
}

async fn scan(shared: Arc<Shared>) -> Result<Vec<DeviceSnapshot>, String> {
    let addr = UsbmuxdAddr::from_env_var().map_err(|e| e.to_string())?;
    let mut mux = addr.connect(1).await.map_err(|e| e.to_string())?;
    let devices = mux.get_devices().await.map_err(|e| e.to_string())?;

    let (sessions, connecting) = {
        let sessions = shared.sessions.lock().await;
        let connecting = shared.connecting.lock().await;
        (
            sessions.keys().cloned().collect::<Vec<_>>(),
            connecting.clone(),
        )
    };

    let mut snapshots = Vec::with_capacity(devices.len());
    for device in devices {
        let cached = shared.cache.lock().await.get(&device.udid).cloned();
        snapshots.push(DeviceSnapshot {
            udid: device.udid.clone(),
            name: cached.as_ref().and_then(|c| c.name.clone()),
            connection: connection_label(&device),
            connected: sessions.contains(&device.udid),
            connecting: connecting.contains(&device.udid),
            product_version: cached.as_ref().and_then(|c| c.product_version.clone()),
            model: cached
                .as_ref()
                .and_then(|c| c.product_type.as_deref())
                .and_then(crate::device_names::marketing_name)
                .map(str::to_string),
        });

        // 首次出现(或距上次尝试超过重试间隔)时,后台查询设备名
        let need_probe = match &cached {
            None => true,
            Some(c) => {
                c.name.is_none()
                    && c.attempted_at
                        .map(|t| t.elapsed() > RETRY_AFTER)
                        .unwrap_or(true)
            }
        };
        if need_probe {
            let shared = shared.clone();
            let udid = device.udid.clone();
            let addr = addr.clone();
            tokio::spawn(async move {
                let (name, version, product_type) = probe_device(&addr, &udid).await;
                let mut cache = shared.cache.lock().await;
                let entry = cache.entry(udid).or_insert_with(CachedDevice::default);
                if name.is_some() {
                    entry.name = name;
                }
                if version.is_some() {
                    entry.product_version = version;
                }
                if product_type.is_some() {
                    entry.product_type = product_type;
                }
                entry.attempted_at = Some(Instant::now());
                // 下一次轮询周期会自动带上新信息并推送列表更新
            });
        }
    }

    // 按 USB 优先、UDID 排序,保证列表顺序稳定
    snapshots.sort_by(|a, b| {
        let ka = (a.connection != "USB", a.udid.clone());
        let kb = (b.connection != "USB", b.udid.clone());
        ka.cmp(&kb)
    });
    Ok(snapshots)
}

fn connection_label(device: &UsbmuxdDevice) -> String {
    match &device.connection_type {
        UsbConnectionKind::Usb => "USB".to_string(),
        UsbConnectionKind::Network(ip) => format!("WiFi ({ip})"),
        UsbConnectionKind::Unknown(kind) => kind.clone(),
    }
}

/// 用一次临时 lockdown 连接查询设备名与系统版本(未连接设备也能显示)
async fn probe_device(
    addr: &UsbmuxdAddr,
    udid: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    async {
        let mut mux = addr.connect(1).await.ok()?;
        let device = mux.get_device(udid).await.ok()?;
        let provider = device.to_provider(addr.clone(), "rush-locator-probe");
        let mut lockdown = LockdownClient::connect(&provider).await.ok()?;
        let name = lockdown
            .get_value(Some("DeviceName"), None)
            .await
            .ok()
            .and_then(|v| v.as_string().map(str::to_string));
        let version = lockdown
            .get_value(Some("ProductVersion"), None)
            .await
            .ok()
            .and_then(|v| v.as_string().map(str::to_string));
        let product_type = lockdown
            .get_value(Some("ProductType"), None)
            .await
            .ok()
            .and_then(|v| v.as_string().map(str::to_string));
        Some((name, version, product_type))
    }
    .await
    .unwrap_or((None, None, None))
}

/// 设备已经拔掉/离线时,关闭其会话
async fn reap_missing_sessions(shared: &Shared, snapshots: &[DeviceSnapshot]) {
    let present: Vec<&str> = snapshots.iter().map(|s| s.udid.as_str()).collect();
    let stale: Vec<(String, crate::session::SessionHandle)> = {
        let sessions = shared.sessions.lock().await;
        sessions
            .iter()
            .filter(|(udid, _)| !present.contains(&udid.as_str()))
            .map(|(udid, h)| (udid.clone(), h.clone()))
            .collect()
    };
    for (udid, handle) in stale {
        warn!("设备 {udid} 已断开,关闭会话");
        let _ = handle.send(SessionCmd::Shutdown).await;
        shared.sessions.lock().await.remove(&udid);
    }
}
