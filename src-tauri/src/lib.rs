//! RUSH Locator —— iPhone 虚拟定位工作台(Tauri 后端入口)。

mod device_names;
mod devices;
mod model;
mod route;
mod session;
mod state;
mod tiles;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::model::{DeviceDetails, DeviceSnapshot, LatLon, RouteOptions};
use crate::session::{SessionCmd, SessionHandle};
use crate::state::Shared;

/// 命令统一错误类型:字符串直接交给前端展示
type CmdResult<T> = Result<T, String>;

/// 向会话任务发送指令并等待应答
async fn call<T>(
    shared: &Shared,
    udid: &str,
    make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> SessionCmd,
    timeout_secs: u64,
) -> CmdResult<T> {
    let handle = {
        let sessions = shared.sessions.lock().await;
        sessions.get(udid).cloned()
    }
    .ok_or_else(|| "设备尚未建立会话,请先连接".to_string())?;

    let (tx, rx) = oneshot::channel();
    handle.send(make(tx)).await?;
    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("会话未响应".into()),
        Err(_) => Err("操作超时".into()),
    }
}

fn validate_coord(lat: f64, lon: f64) -> CmdResult<()> {
    if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
        return Err(format!("纬度非法: {lat}"));
    }
    if !lon.is_finite() || !(-180.0..=180.0).contains(&lon) {
        return Err(format!("经度非法: {lon}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 当前设备列表(轮询推送之外的一次性快照)
#[tauri::command]
async fn list_devices(state: State<'_, Arc<Shared>>) -> CmdResult<Vec<DeviceSnapshot>> {
    Ok(state.devices.lock().await.clone())
}

/// 立即重新扫描设备(手动刷新,便于排查设备未显示的问题)
#[tauri::command]
async fn rescan_devices(
    app: AppHandle,
    state: State<'_, Arc<Shared>>,
) -> CmdResult<Vec<DeviceSnapshot>> {
    let shared = state.inner().clone();
    devices::scan_and_emit(&app, &shared)
        .await
        .map_err(|e| format!("扫描 usbmuxd 失败: {e}"))
}

/// 连接设备:建立隧道 + 定位服务,返回设备详情
#[tauri::command]
async fn connect_device(
    app: AppHandle,
    state: State<'_, Arc<Shared>>,
    udid: String,
) -> CmdResult<DeviceDetails> {
    // 若已有会话则先关闭,保证干净重连
    let existing: Option<SessionHandle> = state.sessions.lock().await.remove(&udid);
    if let Some(h) = existing {
        let _ = h.send(SessionCmd::Shutdown).await;
    }

    state.connecting.lock().await.insert(udid.clone());
    let app2 = app.clone();
    let udid2 = udid.clone();
    let result =
        tauri::async_runtime::spawn(async move { session::open_session(&app2, &udid2).await })
            .await
            .map_err(|e| format!("连接任务异常终止: {e}"))?;
    state.connecting.lock().await.remove(&udid);

    match result {
        Ok((details, handle)) => {
            state.sessions.lock().await.insert(udid, handle);
            Ok(details)
        }
        Err(e) => Err(e),
    }
}

/// 断开设备会话(设备侧自动恢复真实定位)
#[tauri::command]
async fn disconnect_device(state: State<'_, Arc<Shared>>, udid: String) -> CmdResult<()> {
    let existing = state.sessions.lock().await.remove(&udid);
    if let Some(h) = existing {
        let _ = h.send(SessionCmd::Shutdown).await;
    }
    Ok(())
}

/// 在地图上设置一个虚拟坐标
#[tauri::command]
async fn set_location(
    state: State<'_, Arc<Shared>>,
    udid: String,
    lat: f64,
    lon: f64,
) -> CmdResult<()> {
    validate_coord(lat, lon)?;
    let shared = state.inner().clone();
    call(
        &shared,
        &udid,
        |reply| SessionCmd::SetLocation { lat, lon, reply },
        15,
    )
    .await
}

/// 清除虚拟定位,恢复真实 GPS
#[tauri::command]
async fn clear_location(state: State<'_, Arc<Shared>>, udid: String) -> CmdResult<()> {
    let shared = state.inner().clone();
    call(
        &shared,
        &udid,
        |reply| SessionCmd::ClearLocation { reply },
        15,
    )
    .await
}

/// 开始路线回放
#[tauri::command]
async fn start_route(
    state: State<'_, Arc<Shared>>,
    udid: String,
    points: Vec<LatLon>,
    options: RouteOptions,
) -> CmdResult<()> {
    if points.is_empty() {
        return Err("路线为空".into());
    }
    if points.len() > 20_000 {
        return Err(format!("路线航点过多({}),请精简后再试", points.len()));
    }
    if !options.speed_kmh.is_finite() || options.speed_kmh <= 0.0 {
        return Err("速度必须大于 0".into());
    }
    let mut options = options;
    options.speed_kmh = options.speed_kmh.clamp(0.5, 2000.0);
    options.update_ms = options.update_ms.clamp(50, 5000);

    let shared = state.inner().clone();
    call(
        &shared,
        &udid,
        |reply| SessionCmd::StartRoute {
            points,
            options,
            reply,
        },
        20,
    )
    .await
}

#[tauri::command]
async fn pause_route(state: State<'_, Arc<Shared>>, udid: String) -> CmdResult<()> {
    let shared = state.inner().clone();
    call(&shared, &udid, |reply| SessionCmd::PauseRoute { reply }, 10).await
}

#[tauri::command]
async fn resume_route(state: State<'_, Arc<Shared>>, udid: String) -> CmdResult<()> {
    let shared = state.inner().clone();
    call(
        &shared,
        &udid,
        |reply| SessionCmd::ResumeRoute { reply },
        10,
    )
    .await
}

/// 停止路线回放;`clear=true` 时同时清除设备虚拟定位
#[tauri::command]
async fn stop_route(state: State<'_, Arc<Shared>>, udid: String, clear: bool) -> CmdResult<()> {
    let shared = state.inner().clone();
    call(
        &shared,
        &udid,
        |reply| SessionCmd::StopRoute { clear, reply },
        10,
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatteryInfo {
    level: u32,
    charging: bool,
}

/// 主动刷新电量等信息
#[tauri::command]
async fn refresh_info(
    state: State<'_, Arc<Shared>>,
    udid: String,
) -> CmdResult<Option<BatteryInfo>> {
    let shared = state.inner().clone();
    let res = call(
        &shared,
        &udid,
        |reply| SessionCmd::RefreshInfo { reply },
        20,
    )
    .await?;
    Ok(res.map(|(level, charging)| BatteryInfo { level, charging }))
}

/// 内置瓦片服务地址(形如 `http://127.0.0.1:12345`)
#[tauri::command]
fn tile_server_url(server: State<'_, Arc<tiles::TileServer>>) -> String {
    server.base_url()
}

/// 后台预热瓦片缓存:以经纬度为中心,在指定缩放级别预取周围区域。
///
/// 传入的坐标应与底图坐标系一致(高德为 GCJ-02,其余为 WGS-84)。
#[tauri::command]
fn prefetch_tiles(
    server: State<'_, Arc<tiles::TileServer>>,
    provider: String,
    lat: f64,
    lon: f64,
    zooms: Vec<u32>,
) -> CmdResult<()> {
    validate_coord(lat, lon)?;
    if zooms.len() > 8 {
        return Err("一次最多预热 8 个缩放级别".into());
    }
    tiles::spawn_prefetch(server.inner().clone(), provider, lat, lon, zooms, 1);
    Ok(())
}

// ---------------------------------------------------------------------------
// 应用入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("rush_locator_lib=info,idevice=warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .setup(|app| {
            // 内置地图瓦片服务(本地代理 + 磁盘缓存)
            if let Some(server) = tiles::start(app.handle()) {
                app.manage(server);
            }
            let shared = Arc::new(Shared::default());
            app.manage(shared.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                devices::run_watcher(handle, shared).await;
            });
            info!("RUSH Locator 已启动");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            rescan_devices,
            connect_device,
            disconnect_device,
            set_location,
            clear_location,
            start_route,
            pause_route,
            resume_route,
            stop_route,
            refresh_info,
            tile_server_url,
            prefetch_tiles,
        ])
        .run(tauri::generate_context!())
        .expect("RUSH Locator 启动失败");
}
