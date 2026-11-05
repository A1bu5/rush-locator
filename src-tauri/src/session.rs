//! 设备会话管理。
//!
//! 每台设备对应一个常驻 tokio 任务(actor):
//! 1. 通过 usbmuxd + CoreDeviceProxy 建立软件隧道(失败时自动回退到本地 tunneld);
//! 2. 在隧道上进行 RSD 握手,连接 DVT `dtservicehub`;
//! 3. 打开 `LocationSimulation` 通道,串行处理"设置/清除坐标、路线回放"等指令,
//!    并通过 Tauri 事件把进度与状态推送给前端。
//!
//! 采用 actor 模式的原因:`LocationSimulationClient` 借用了 `RemoteServerClient`,
//! 两者必须在同一作用域中长期共存,由任务独占并串行处理指令最自然。

use std::fmt::Display;
use std::net::IpAddr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use idevice::provider::{RsdProvider, UsbmuxdProvider};
use idevice::services::core_device_proxy::CoreDeviceProxy;
use idevice::services::diagnostics_relay::DiagnosticsRelayClient;
use idevice::services::dvt::device_info::DeviceInfoClient;
use idevice::services::dvt::location_simulation::LocationSimulationClient;
use idevice::services::dvt::remote_server::RemoteServerClient;
use idevice::services::lockdown::LockdownClient;
use idevice::services::rsd::RsdHandshake;
use idevice::tcp::handle::AdapterHandle;
use idevice::tunneld::{DEFAULT_PORT, get_tunneld_devices};
use idevice::usbmuxd::{Connection as UsbConnectionKind, UsbmuxdAddr, UsbmuxdDevice};
use idevice::{Idevice, IdeviceError, IdeviceService, ReadWrite, RsdService};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{MissedTickBehavior, interval, timeout};
use tracing::{info, warn};

use crate::model::{DeviceDetails, DeviceStateEvent, LatLon, RouteOptions};
use crate::route::{RoutePath, RoutePlayback};

/// 事件:设备状态变化(`connecting` / `connected` / `disconnected` / `error`)
pub const EVENT_DEVICE_STATE: &str = "device_state";
/// 事件:路线回放进度
pub const EVENT_ROUTE_PROGRESS: &str = "route_progress";
/// 事件:路线回放已停止
pub const EVENT_ROUTE_STOPPED: &str = "route_stopped";
/// 事件:设备信息(电量等)刷新
pub const EVENT_BATTERY: &str = "battery_update";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(20);
/// 回放 tick 周期(毫秒)
const TICK_MS: u64 = 60;

/// DVT 传输通道:`Box<dyn ReadWrite>` 必须显式标注 `'static`,
/// 否则在 tauri 命令宏的高阶生命周期检查下会推演出非静态生命周期而编译失败。
pub type DvtTransport = Box<dyn ReadWrite + 'static>;
/// 建立在隧道上的 DVT 客户端
pub type DvtClient = RemoteServerClient<DvtTransport>;

type Reply<T> = oneshot::Sender<Result<T, String>>;

fn err<E: Display>(e: E) -> String {
    e.to_string()
}

/// 发给会话任务的指令
pub enum SessionCmd {
    SetLocation {
        lat: f64,
        lon: f64,
        reply: Reply<()>,
    },
    ClearLocation {
        reply: Reply<()>,
    },
    StartRoute {
        points: Vec<LatLon>,
        options: RouteOptions,
        reply: Reply<()>,
    },
    PauseRoute {
        reply: Reply<()>,
    },
    ResumeRoute {
        reply: Reply<()>,
    },
    StopRoute {
        clear: bool,
        reply: Reply<()>,
    },
    RefreshInfo {
        reply: Reply<Option<(u32, bool)>>,
    },
    Shutdown,
}

/// 会话句柄(保存在全局状态里)
#[derive(Clone)]
pub struct SessionHandle {
    pub tx: mpsc::Sender<SessionCmd>,
}

impl SessionHandle {
    pub async fn send(&self, cmd: SessionCmd) -> Result<(), String> {
        self.tx
            .send(cmd)
            .await
            .map_err(|_| "会话已关闭".to_string())
    }
}

/// 隧道通道:内置软件隧道,或本地 pymobiledevice3 tunneld
pub enum TunnelProvider {
    Software(AdapterHandle),
    Tunneld(IpAddr),
}

/// 从 RSD 握手结果中查服务端口
fn rsd_service_port(handshake: &RsdHandshake, name: &str) -> Result<u16, String> {
    handshake
        .services
        .get(name)
        .map(|s| s.port)
        .ok_or_else(|| format!("设备的 RSD 服务列表中没有 {name}"))
}

/// 连接 DVT dtservicehub。
///
/// 语义等价于 `handshake.connect::<DvtClient>()`,但直接取端口 + 构造客户端,
/// 绕过 `RsdHandshake::connect` 的泛型路径——该路径在 rustc 1.88/1.99 下
/// 会让命令 future 的 `Send + 'static` 求解触发
/// "implementation of RsdService is not general enough" 编译错误。
async fn connect_dvt_client(
    provider: &mut TunnelProvider,
    handshake: &RsdHandshake,
) -> Result<DvtClient, String> {
    let name = <DvtClient as RsdService>::rsd_service_name();
    let port = rsd_service_port(handshake, name.as_ref())?;
    let stream = provider.connect_to_service_port(port).await.map_err(err)?;
    // 与 `impl RsdService for RemoteServerClient` 的 from_stream 行为一致
    Ok(DvtClient::new(stream))
}

/// 连接诊断服务(`.shim.remote` 服务需要先做 RSD check-in)
async fn connect_diagnostics_client(
    provider: &mut TunnelProvider,
    handshake: &RsdHandshake,
) -> Result<DiagnosticsRelayClient, String> {
    let name = <DiagnosticsRelayClient as RsdService>::rsd_service_name();
    let port = rsd_service_port(handshake, name.as_ref())?;
    let stream = provider.connect_to_service_port(port).await.map_err(err)?;
    // 与 `impl RsdService for DiagnosticsRelayClient` 的 from_stream 行为一致
    let mut idevice = Idevice::new(stream, "rush-locator");
    idevice.rsd_checkin().await.map_err(err)?;
    Ok(DiagnosticsRelayClient::new(idevice))
}

impl std::fmt::Debug for TunnelProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelProvider::Software(_) => write!(f, "TunnelProvider::Software(CoreDeviceProxy)"),
            TunnelProvider::Tunneld(ip) => write!(f, "TunnelProvider::Tunneld({ip})"),
        }
    }
}

impl RsdProvider for TunnelProvider {
    async fn connect_to_service_port(
        &mut self,
        port: u16,
    ) -> Result<Box<dyn ReadWrite>, IdeviceError> {
        match self {
            TunnelProvider::Software(handle) => handle.connect_to_service_port(port).await,
            TunnelProvider::Tunneld(ip) => ip.connect_to_service_port(port).await,
        }
    }
}

/// 建立完成的会话资源
struct Established {
    provider: TunnelProvider,
    handshake: RsdHandshake,
    dvt: DvtClient,
    tunnel_kind: &'static str,
}

fn connection_label(device: &UsbmuxdDevice) -> String {
    match &device.connection_type {
        UsbConnectionKind::Usb => "USB".to_string(),
        UsbConnectionKind::Network(ip) => format!("WiFi ({ip})"),
        UsbConnectionKind::Unknown(kind) => kind.clone(),
    }
}

fn emit_state(
    app: &AppHandle,
    udid: &str,
    state: &str,
    message: Option<String>,
    details: Option<DeviceDetails>,
) {
    let _ = app.emit(
        EVENT_DEVICE_STATE,
        DeviceStateEvent {
            udid: udid.to_string(),
            state: state.to_string(),
            message,
            details,
        },
    );
}

/// 打开一条会话。成功时返回设备详情与句柄;过程状态通过事件推送。
pub async fn open_session(
    app: &AppHandle,
    udid: &str,
) -> Result<(DeviceDetails, SessionHandle), String> {
    emit_state(app, udid, "connecting", None, None);
    match timeout(CONNECT_TIMEOUT, open_session_inner(app, udid)).await {
        Ok(Ok(opened)) => {
            emit_state(app, udid, "connected", None, Some(opened.0.clone()));
            Ok(opened)
        }
        Ok(Err(e)) => {
            emit_state(app, udid, "error", Some(e.clone()), None);
            Err(e)
        }
        Err(_) => {
            let e = format!(
                "连接超时({} 秒)。请确认设备已解锁、已信任本机并已开启开发者模式",
                CONNECT_TIMEOUT.as_secs()
            );
            emit_state(app, udid, "error", Some(e.clone()), None);
            Err(e)
        }
    }
}

async fn open_session_inner(
    app: &AppHandle,
    udid: &str,
) -> Result<(DeviceDetails, SessionHandle), String> {
    // ---- 1. 通过 usbmuxd 找到设备 ----
    let mux_addr = UsbmuxdAddr::from_env_var().map_err(|e| format!("无效的 usbmuxd 地址: {e}"))?;
    let mut mux = mux_addr
        .connect(1)
        .await
        .map_err(|e| format!("无法连接 usbmuxd: {e}"))?;
    let device = mux
        .get_device(udid)
        .await
        .map_err(|e| format!("usbmuxd 未找到设备 {udid}: {e}"))?;
    let connection_label = connection_label(&device);
    let mux_provider = device.to_provider(mux_addr.clone(), "rush-locator");

    // ---- 2. 建立隧道 + RSD + DVT ----
    let Established {
        mut provider,
        handshake,
        mut dvt,
        tunnel_kind,
    } = match establish_software_tunnel(&mux_provider).await {
        Ok(v) => v,
        Err(primary_err) => {
            info!("内置隧道建立失败({primary_err}),尝试本地 pymobiledevice3 tunneld…");
            match establish_tunneld_tunnel(udid).await {
                Ok(v) => v,
                Err(fallback_err) => {
                    return Err(format!(
                        "无法建立到设备的隧道。\n· 内置 CoreDeviceProxy: {primary_err}\n· 本地 tunneld: {fallback_err}\n\
                         提示:确认设备已解锁、iOS ≥ 17.4 且已开启开发者模式;或在后台运行 `pymobiledevice3 tunneld` 后重试。",
                    ));
                }
            }
        }
    };
    info!("会话隧道就绪:{tunnel_kind}");

    // ---- 3. 采集设备详情(lockdown + DVT + 诊断服务,全部尽力而为) ----
    let mut details = gather_details(&mux_provider, &mut provider, &handshake, &mut dvt).await;
    details.udid = udid.to_string();
    details.connection = connection_label;
    details.tunnel = Some(tunnel_kind.to_string());

    // ---- 4. 启动会话任务 ----
    let (tx, rx) = mpsc::channel::<SessionCmd>(64);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
    let app_clone = app.clone();
    let udid_owned = udid.to_string();
    tokio::spawn(async move {
        run_actor(
            app_clone, udid_owned, provider, handshake, dvt, rx, ready_tx,
        )
        .await;
    });

    match timeout(Duration::from_secs(12), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok((details, SessionHandle { tx })),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("会话任务异常退出".into()),
        Err(_) => Err("打开定位服务超时".into()),
    }
}

/// 通过 usbmuxd + CoreDeviceProxy 建立纯软件隧道并连接 DVT
async fn establish_software_tunnel(mux_provider: &UsbmuxdProvider) -> Result<Established, String> {
    let proxy = timeout(TUNNEL_TIMEOUT, CoreDeviceProxy::connect(mux_provider))
        .await
        .map_err(|_| "CoreDeviceProxy 连接超时".to_string())?
        .map_err(|e| format!("CoreDeviceProxy 不可用: {e}"))?;

    let rsd_port = proxy.tunnel_info().server_rsd_port;
    let adapter = proxy
        .create_software_tunnel()
        .map_err(|e| format!("创建软件隧道失败: {e}"))?;
    let mut provider = TunnelProvider::Software(adapter.to_async_handle());

    let stream = provider
        .connect_to_service_port(rsd_port)
        .await
        .map_err(|e| format!("连接 RSD 端口 {rsd_port} 失败: {e}"))?;
    let handshake = RsdHandshake::new(stream)
        .await
        .map_err(|e| format!("RSD 握手失败: {e}"))?;
    let dvt = connect_dvt_client(&mut provider, &handshake).await?;

    Ok(Established {
        provider,
        handshake,
        dvt,
        tunnel_kind: "CoreDeviceProxy",
    })
}

/// 通过本地 tunneld(pymobiledevice3)建立隧道并连接 DVT
async fn establish_tunneld_tunnel(udid: &str) -> Result<Established, String> {
    let addr = format!("127.0.0.1:{DEFAULT_PORT}")
        .parse()
        .expect("静态地址可解析");
    let devices = get_tunneld_devices(addr)
        .await
        .map_err(|e| format!("tunneld 不可用: {e}"))?;
    let device = devices
        .get(udid)
        .ok_or_else(|| format!("tunneld 中没有设备 {udid}"))?;
    let ip = IpAddr::from_str(&device.tunnel_address)
        .map_err(|e| format!("tunneld 返回的隧道地址非法({}): {e}", device.tunnel_address))?;
    info!(
        "使用 tunneld 隧道 {}:{} ({})",
        device.tunnel_address, device.tunnel_port, device.interface
    );

    let stream = tokio::net::TcpStream::connect((ip, device.tunnel_port))
        .await
        .map_err(|e| format!("连接 tunneld 隧道端点失败: {e}"))?;
    let handshake = RsdHandshake::new(stream)
        .await
        .map_err(|e| format!("tunneld RSD 握手失败: {e}"))?;
    let mut provider = TunnelProvider::Tunneld(ip);
    let dvt = connect_dvt_client(&mut provider, &handshake).await?;

    Ok(Established {
        provider,
        handshake,
        dvt,
        tunnel_kind: "tunneld",
    })
}

/// 尽力采集设备信息;任何一项失败都不影响整体
async fn gather_details(
    mux_provider: &UsbmuxdProvider,
    provider: &mut TunnelProvider,
    handshake: &RsdHandshake,
    dvt: &mut DvtClient,
) -> DeviceDetails {
    let mut details = DeviceDetails::default();

    // (a) RSD 握手属性:序列号 / 硬件标识 / 系统版本等(连接后即有,最可靠)
    let props = &handshake.properties;
    details.serial_number = prop_str(props, "SerialNumber");
    details.product_type = prop_str(props, "ProductType");
    details.product_version = prop_str(props, "OSVersion");
    details.build_version = prop_str(props, "BuildVersion");

    // (b) 市场名称:内置 ProductType 映射表
    if let Some(pt) = details.product_type.as_deref() {
        details.model_name = crate::device_names::marketing_name(pt).map(str::to_string);
    }

    // (c) lockdown 补充设备名(RSD 属性里没有 DeviceName),并补齐缺失字段
    if let Ok(mut lockdown) = LockdownClient::connect(mux_provider).await {
        details.name = get_str(&mut lockdown, "DeviceName").await;
        if details.product_version.is_none() {
            details.product_version = get_str(&mut lockdown, "ProductVersion").await;
        }
        if details.build_version.is_none() {
            details.build_version = get_str(&mut lockdown, "BuildVersion").await;
        }
        if details.product_type.is_none() {
            details.product_type = get_str(&mut lockdown, "ProductType").await;
        }
        if details.serial_number.is_none() {
            details.serial_number = get_str(&mut lockdown, "SerialNumber").await;
        }
    } else {
        warn!("lockdown 连接失败,跳过设备信息补充");
    }

    // (d) 市场名称兜底:DVT 硬件信息(部分系统版本在 hardwareInformation 里带 MarketingName)
    if details.model_name.is_none()
        && let Ok(mut info) = DeviceInfoClient::new(dvt).await
        && let Ok(hw) = info.hardware_information().await
    {
        for key in ["MarketingName", "ProductName", "DeviceName"] {
            if let Some(v) = hw.get(key).and_then(|v| v.as_string()) {
                details.model_name = Some(v.to_string());
                break;
            }
        }
    }

    // (e) 诊断服务:MobileGestalt 市场名(旧系统)与电量
    if let Ok(mut diag) = connect_diagnostics_client(provider, handshake).await {
        if details.model_name.is_none()
            && let Ok(Some(mg)) = diag
                .mobilegestalt(Some(vec!["MarketingNameString".into()]))
                .await
        {
            details.model_name = mg
                .get("MarketingNameString")
                .and_then(|v| v.as_string())
                .map(str::to_string);
        }
        if let Ok(Some(power)) = diag.ioregistry(None, None, Some("IOPMPowerSource")).await
            && let Some((level, charging)) = parse_battery(&power)
        {
            details.battery_level = Some(level);
            details.battery_charging = Some(charging);
        }
    }

    details
}

fn prop_str(props: &std::collections::HashMap<String, plist::Value>, key: &str) -> Option<String> {
    props
        .get(key)
        .and_then(|v| v.as_string())
        .map(str::to_string)
}

async fn get_str(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    match lockdown.get_value(Some(key), None).await {
        Ok(v) => v.as_string().map(str::to_string),
        Err(_) => None,
    }
}

fn parse_battery(dict: &plist::Dictionary) -> Option<(u32, bool)> {
    let cap = dict.get("CurrentCapacity").and_then(|v| {
        v.as_unsigned_integer()
            .or_else(|| v.as_signed_integer().map(|i| i.max(0) as u64))
    });
    let charging = dict
        .get("IsCharging")
        .and_then(|v| v.as_boolean())
        .unwrap_or(false);
    cap.map(|c| (c.min(100) as u32, charging))
}

/// 会话主循环:独占 DVT 连接与定位客户端,串行处理指令并驱动路线回放
async fn run_actor(
    app: AppHandle,
    udid: String,
    mut provider: TunnelProvider,
    handshake: RsdHandshake,
    mut dvt: DvtClient,
    mut rx: mpsc::Receiver<SessionCmd>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) {
    // 打开定位通道(借用 dvt;此后 dvt 不可直接用,但仍在作用域内存活)
    let mut loc = match LocationSimulationClient::new(&mut dvt).await {
        Ok(loc) => {
            let _ = ready_tx.send(Ok(()));
            loc
        }
        Err(e) => {
            let _ = ready_tx.send(Err(format!("打开 LocationSimulation 服务失败: {e}")));
            emit_state(
                &app,
                &udid,
                "error",
                Some(format!("打开定位服务失败: {e}")),
                None,
            );
            return;
        }
    };
    info!("定位服务通道已打开");

    let mut route: Option<RoutePlayback> = None;
    let mut ticker = interval(Duration::from_millis(TICK_MS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await; // 消费立即触发的首 tick
    let mut last_tick = Instant::now();

    let mut diag_client: Option<DiagnosticsRelayClient> = None;
    let mut battery_ticker = interval(Duration::from_secs(45));
    battery_ticker.tick().await;

    // 带超时的设备调用:设备失去响应时避免会话任务被永久阻塞
    macro_rules! dev_call {
        ($fut:expr) => {
            match tokio::time::timeout(Duration::from_secs(8), $fut).await {
                Ok(r) => r.map_err(|e| e.to_string()),
                Err(_) => Err("设备响应超时".to_string()),
            }
        };
    }

    loop {
        tokio::select! {
            biased;

            cmd = rx.recv() => {
                let Some(cmd) = cmd else {
                    // 通道关闭(全局状态被移除或应用退出)
                    let _ = dev_call!(loc.clear());
                    break;
                };
                match cmd {
                    SessionCmd::SetLocation { lat, lon, reply } => {
                        route = None;
                        last_tick = Instant::now();
                        let res = dev_call!(loc.set(lat, lon));
                        if res.is_err() {
                            warn!("设置坐标失败:{:?}", res.as_ref().err());
                        }
                        let _ = reply.send(res);
                    }
                    SessionCmd::ClearLocation { reply } => {
                        route = None;
                        last_tick = Instant::now();
                        let res = dev_call!(loc.clear());
                        let _ = reply.send(res);
                    }
                    SessionCmd::StartRoute { points, options, reply } => {
                        match RoutePath::build(&points) {
                            Err(e) => { let _ = reply.send(Err(e)); }
                            Ok(path) => {
                                let mut playback = RoutePlayback::new(path, options);
                                // 首点立即下发,避免启动延迟
                                let first = points[0];
                                playback.last_sent = Some(first);
                                playback.ms_since_send = 0;
                                if let Err(e) = dev_call!(loc.set(first.lat, first.lon)) {
                                    let _ = reply.send(Err(format!("下发起点失败: {e}")));
                                } else {
                                    let progress = playback.progress(&udid);
                                    let _ = app.emit(EVENT_ROUTE_PROGRESS, &progress);
                                    route = Some(playback);
                                    last_tick = Instant::now();
                                    let _ = reply.send(Ok(()));
                                }
                            }
                        }
                    }
                    SessionCmd::PauseRoute { reply } => {
                        if let Some(rt) = route.as_mut() {
                            rt.playing = false;
                            let p = rt.progress(&udid);
                            let _ = app.emit(EVENT_ROUTE_PROGRESS, &p);
                        }
                        let _ = reply.send(Ok(()));
                    }
                    SessionCmd::ResumeRoute { reply } => {
                        match route.as_mut() {
                            Some(rt) if !rt.finished => {
                                rt.playing = true;
                                last_tick = Instant::now();
                                let p = rt.progress(&udid);
                                let _ = app.emit(EVENT_ROUTE_PROGRESS, &p);
                                let _ = reply.send(Ok(()));
                            }
                            Some(_) => { let _ = reply.send(Err("路线已结束,请重新开始".into())); }
                            None => { let _ = reply.send(Err("没有正在进行的路线".into())); }
                        }
                    }
                    SessionCmd::StopRoute { clear, reply } => {
                        route = None;
                        last_tick = Instant::now();
                        let stopped = serde_json::json!({ "udid": udid, "cleared": clear });
                        let _ = app.emit(EVENT_ROUTE_STOPPED, stopped);
                        if clear {
                            let res = dev_call!(loc.clear());
                            let _ = reply.send(res);
                        } else {
                            let _ = reply.send(Ok(()));
                        }
                    }
                    SessionCmd::RefreshInfo { reply } => {
                        let battery = timeout(Duration::from_secs(10), fetch_battery(&mut provider, &handshake, &mut diag_client))
                            .await
                            .unwrap_or_else(|_| {
                                warn!("电量查询超时");
                                None
                            });
                        if let Some((level, charging)) = battery {
                            let payload = BatteryUpdate { udid: udid.clone(), level, charging };
                            let _ = app.emit(EVENT_BATTERY, payload);
                        }
                        let _ = reply.send(Ok(battery));
                    }
                    SessionCmd::Shutdown => {
                        let _ = route.take();
                        let _ = dev_call!(loc.clear());
                        break;
                    }
                }
            }

            _ = ticker.tick(), if route.as_ref().is_some_and(|r| r.playing) => {
                let now = Instant::now();
                let dt_ms = (now - last_tick).as_millis() as u64;
                last_tick = now;

                let Some(rt) = route.as_mut() else { continue };
                let mut send_error: Option<String> = None;
                if let Some(pos) = rt.advance(dt_ms)
                    && let Err(e) = dev_call!(loc.set(pos.lat, pos.lon))
                {
                    send_error = Some(format!("向设备下发位置失败: {e}"));
                    rt.playing = false;
                }
                let progress = rt.progress(&udid);
                let _ = app.emit(EVENT_ROUTE_PROGRESS, &progress);
                if let Some(msg) = send_error {
                    emit_state(&app, &udid, "error", Some(msg), None);
                }
                if rt.finished {
                    if !rt.options.keep_final {
                        let _ = dev_call!(loc.clear());
                    }
                    route = None;
                }
            }

            _ = battery_ticker.tick() => {
                let battery = timeout(
                    Duration::from_secs(10),
                    fetch_battery(&mut provider, &handshake, &mut diag_client),
                )
                .await
                .unwrap_or_default();
                if let Some((level, charging)) = battery {
                    let payload = BatteryUpdate { udid: udid.clone(), level, charging };
                    let _ = app.emit(EVENT_BATTERY, payload);
                }
            }
        }
    }

    info!("会话结束:{udid}");
    emit_state(&app, &udid, "disconnected", None, None);
}

/// 读取电量(懒加载诊断服务连接;失败时返回 None 并允许下次重试)
async fn fetch_battery(
    provider: &mut TunnelProvider,
    handshake: &RsdHandshake,
    client: &mut Option<DiagnosticsRelayClient>,
) -> Option<(u32, bool)> {
    if client.is_none() {
        match connect_diagnostics_client(provider, handshake).await {
            Ok(c) => *client = Some(c),
            Err(e) => {
                warn!("连接诊断服务失败:{e}");
                return None;
            }
        }
    }
    let c = client.as_mut()?;
    match c.ioregistry(None, None, Some("IOPMPowerSource")).await {
        Ok(Some(dict)) => parse_battery(&dict),
        Ok(None) => None,
        Err(e) => {
            warn!("读取电量失败:{e}");
            *client = None; // 连接可能已失效
            None
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct BatteryUpdate {
    udid: String,
    level: u32,
    charging: bool,
}
