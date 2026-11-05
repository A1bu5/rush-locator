//! 内置地图瓦片服务:本地 HTTP 代理 + 持久化磁盘缓存。
//!
//! 前端把地图瓦片请求指向 `http://127.0.0.1:<port>/tiles/<provider>/<z>/<x>/<y>.png`,
//! 本服务负责:
//! - 命中磁盘缓存直接返回(离网也能看已缓存的区域);
//! - 未命中则按 provider 规则从上游拉取、落盘并返回;
//! - 支持后台预热(prefetch),让即将查看的区域提前建缓存。
//!
//! 缓存目录:`<应用缓存目录>/tiles/<provider>/<z>/<x>/<y>[@2x].png`

use std::collections::HashMap;
use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tauri::Manager;
use tokio::sync::Semaphore;
use tracing::{info, warn};

/// 单张瓦片的最大响应体积(防御性上限)
const MAX_TILE_BYTES: usize = 4 * 1024 * 1024;
/// 预取并发度
const PREFETCH_CONCURRENCY: usize = 6;

struct TileState {
    client: reqwest::Client,
    cache_root: PathBuf,
}

/// 已启动的瓦片服务(由 Tauri 托管)
pub struct TileServer {
    pub port: u16,
    state: Arc<TileState>,
}

impl TileServer {
    /// 服务地址,形如 `http://127.0.0.1:12345`
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// 上游瓦片 URL(按 provider 生成)
///
/// 说明:
/// - `amap-*`:高德,国内快、中文注记,但境外无数据(返回空白占位图);
/// - `esri-*`:Esri ArcGIS 在线底图,全球覆盖,国内可访问;
/// - Carto/OSM 的栅格服务在当前网络下不可用或返回占位图,已移除。
fn upstream_url(provider: &str, z: u32, x: u32, y: u32, _dpr2: bool) -> Option<String> {
    // dpr 仅用于区分缓存文件;上游均按 256px 瓦片提供
    let sub = 1 + (x.wrapping_add(y)) % 4;
    const ARCGIS: &str = "https://server.arcgisonline.com/ArcGIS/rest/services";
    Some(match provider {
        // ---- 高德(GCJ-02 坐标系,国内) ----
        "amap-road" => format!(
            "https://webrd0{sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
        ),
        "amap-sat" => {
            format!("https://webst0{sub}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}")
        }
        // ---- Esri 全球底图(WGS-84 坐标系) ----
        "esri-dark" => format!("{ARCGIS}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"),
        "esri-dark-ref" => {
            format!("{ARCGIS}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}")
        }
        "esri-light" => format!("{ARCGIS}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"),
        "esri-light-ref" => {
            format!("{ARCGIS}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}")
        }
        "esri-imagery" => format!("{ARCGIS}/World_Imagery/MapServer/tile/{z}/{y}/{x}"),
        _ => return None,
    })
}

/// 按文件头判断图片类型(Esri 卫星返回 JPEG,不能一律标成 PNG)
fn sniff_content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn cache_path(root: &StdPath, provider: &str, z: u32, x: u32, y: u32, dpr2: bool) -> PathBuf {
    let name = if dpr2 {
        format!("{y}@2x.png")
    } else {
        format!("{y}.png")
    };
    root.join(provider).join(z.to_string()).join(x.to_string()).join(name)
}

/// 经纬度 → 瓦片坐标(Web Mercator)
fn lonlat_to_tile(lat: f64, lon: f64, z: u32) -> (u32, u32) {
    let n = 2f64.powi(z as i32);
    let x = ((lon + 180.0) / 360.0 * n).floor();
    let lat_rad = lat.to_radians();
    let y = ((1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n)
        .floor();
    let max = (n as i64 - 1).max(0);
    (x.clamp(0.0, max as f64) as u32, y.clamp(0.0, max as f64) as u32)
}

/// 启动内置瓦片服务。绑定端口是同步完成的,便于立刻把地址交给前端。
pub fn start(app: &tauri::AppHandle) -> Option<Arc<TileServer>> {
    let cache_root = app.path().app_cache_dir().ok()?.join("tiles");
    if let Err(e) = std::fs::create_dir_all(&cache_root) {
        warn!("无法创建瓦片缓存目录 {}: {e}", cache_root.display());
    }

    // reqwest 使用 `rustls-no-provider`,这里安装 ring 作为进程级默认加密提供者
    // (与 idevice 协议栈保持一致,避免引入 aws-lc-rs)。
    let _ = rustls::crypto::ring::default_provider().install_default();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("RUSH-Locator/0.1 (iOS location simulator)")
        .build()
        .ok()?;

    let state = Arc::new(TileState {
        client,
        cache_root: cache_root.clone(),
    });

    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    std_listener.set_nonblocking(true).ok()?;
    let port = std_listener.local_addr().ok()?.port();

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/tiles/{provider}/{z}/{x}/{y}", get(tile_handler))
        .with_state(state.clone());

    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, router).await {
                    warn!("内置瓦片服务退出: {e}");
                }
            }
            Err(e) => warn!("内置瓦片服务启动失败: {e}"),
        }
    });

    info!("内置瓦片服务已启动:http://127.0.0.1:{port}(缓存: {})", cache_root.display());
    Some(Arc::new(TileServer { port, state }))
}

async fn tile_handler(
    State(st): State<Arc<TileState>>,
    Path((provider, z, x, y_raw)): Path<(String, u32, u32, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    with_cors(handle_tile(st, provider, z, x, y_raw, q).await)
}

/// WebView 页面(tauri://… 或开发时的 http://localhost:1420)与瓦片服务不同源,
/// 必须返回 CORS 头,否则 MapLibre 无法读取瓦片响应。
fn with_cors(mut resp: Response) -> Response {
    resp.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        axum::http::HeaderValue::from_static("*"),
    );
    resp
}

async fn handle_tile(
    st: Arc<TileState>,
    provider: String,
    z: u32,
    x: u32,
    y_raw: String,
    q: HashMap<String, String>,
) -> Response {
    if z > 19 {
        return (StatusCode::BAD_REQUEST, "zoom out of range").into_response();
    }
    // 路径形如 `.../{y}.png`,去掉扩展名再解析
    let Ok(y) = y_raw.trim_end_matches(".png").parse::<u32>() else {
        return (StatusCode::BAD_REQUEST, "bad tile y").into_response();
    };
    let dpr2 = q.get("dpr").map(|v| v == "2").unwrap_or(false);
    let file = cache_path(&st.cache_root, &provider, z, x, y, dpr2);

    // 1) 磁盘缓存
    if let Ok(bytes) = tokio::fs::read(&file).await
        && !bytes.is_empty()
    {
        return tile_response(bytes);
    }

    // 2) 回源
    let Some(url) = upstream_url(&provider, z, x, y, dpr2) else {
        return (StatusCode::NOT_FOUND, "unknown provider").into_response();
    };
    match fetch_and_store(&st, &url, &file).await {
        Ok(bytes) => tile_response(bytes),
        Err(e) => {
            warn!("瓦片获取失败 {provider} {z}/{x}/{y}: {e}");
            (StatusCode::BAD_GATEWAY, "upstream fetch failed").into_response()
        }
    }
}

fn tile_response(bytes: Vec<u8>) -> Response {
    let ctype = sniff_content_type(&bytes);
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, ctype),
            (axum::http::header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        bytes,
    )
        .into_response()
}

async fn fetch_and_store(st: &TileState, url: &str, file: &StdPath) -> Result<Vec<u8>, String> {
    let resp = st.client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() {
        return Err("空响应".into());
    }
    if bytes.len() > MAX_TILE_BYTES {
        return Err(format!("响应过大({} 字节)", bytes.len()));
    }
    if let Some(parent) = file.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let tmp = file.with_extension("tmp");
    if tokio::fs::write(&tmp, &bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, file).await;
    }
    Ok(bytes)
}

/// 后台预热:以 (lat, lon) 为中心,在每个 zoom 上预取 (2*radius+1)^2 张瓦片。
///
/// 坐标使用目标底图的坐标系(高德是 GCJ-02,其余是 WGS-84),由调用方负责换算。
pub fn spawn_prefetch(
    server: Arc<TileServer>,
    provider: String,
    lat: f64,
    lon: f64,
    zooms: Vec<u32>,
    radius: u32,
) {
    tauri::async_runtime::spawn(async move {
        let st = server.state.clone();
        let semaphore = Arc::new(Semaphore::new(PREFETCH_CONCURRENCY));
        let mut tasks = Vec::new();
        for z in zooms {
            if z > 19 {
                continue;
            }
            let (cx, cy) = lonlat_to_tile(lat, lon, z);
            let n = 2u32.pow(z);
            for dx in -(radius as i64)..=(radius as i64) {
                for dy in -(radius as i64)..=(radius as i64) {
                    let x = (cx as i64 + dx).rem_euclid(n as i64) as u32;
                    let y = (cy as i64 + dy).clamp(0, n as i64 - 1) as u32;
                    let st = st.clone();
                    let provider = provider.clone();
                    let permit = semaphore.clone().acquire_owned().await;
                    tasks.push(tauri::async_runtime::spawn(async move {
                        let _permit = permit;
                        let file = cache_path(&st.cache_root, &provider, z, x, y, false);
                        if tokio::fs::metadata(&file).await.is_ok() {
                            return; // 已有缓存
                        }
                        if let Some(url) = upstream_url(&provider, z, x, y, false) {
                            let _ = fetch_and_store(&st, &url, &file).await;
                        }
                    }));
                }
            }
        }
        for t in tasks {
            let _ = t.await;
        }
    });
}
