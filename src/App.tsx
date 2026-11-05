// RUSH Locator 主界面:状态编排 + 事件订阅 + 地图/面板/控制坞组装

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, events } from './api';
import type {
  DeviceDetails,
  DeviceSnapshot,
  DeviceStateEvent,
  LatLon,
  MapMode,
  MapStyleKey,
  RouteOptions,
  RouteProgress,
} from './types';
import { MapView } from './components/MapView';
import { DevicePanel } from './components/DevicePanel';
import { ControlDock } from './components/ControlDock';
import { Toasts, useToasts } from './components/Toasts';
import { IconLayers, IconTarget } from './components/icons';
import { PROVIDER_BY_STYLE, STYLE_LABEL, STYLE_ORDER, isGcjStyle } from './lib/mapStyles';
import { gcj02ToWgs84, isOutsideChina, wgs84ToGcj02 } from './lib/geo';

/** 高德底图在境外各变体对应的全球替代 */
const AUTO_GLOBAL_FOR: Partial<Record<MapStyleKey, MapStyleKey>> = {
  amap: 'dark',
  'amap-sat': 'satellite',
};

/** 高德各底图在境外仍有数据的最大缩放级别(超过后返回空白/占位图) */
const OVERSEAS_MAX_ZOOM: Partial<Record<MapStyleKey, number>> = {
  amap: 9, // 路网:境外概览数据到 z9
  'amap-sat': 6, // 卫星:境外仅低级别有数据
};

function overseasZoomLimit(style: MapStyleKey): number {
  return OVERSEAS_MAX_ZOOM[style] ?? 9;
}

/** 高德底图在境外无数据时,对应的全球替代底图 */
function globalCounterpart(style: MapStyleKey): MapStyleKey {
  if (!isGcjStyle(style)) return style;
  return AUTO_GLOBAL_FOR[style] ?? 'dark';
}

const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
  speedKmh: 25,
  jitter: true,
  loopRoute: false,
  keepFinal: true,
  updateMs: 200,
};

const LS_VIEW = 'rush.mapView';

interface StoredView {
  lat: number;
  lon: number;
  zoom: number;
  style: MapStyleKey;
}

function loadStoredView(): StoredView | null {
  try {
    const raw = localStorage.getItem(LS_VIEW);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredView;
    if (
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lon) &&
      Number.isFinite(v.zoom) &&
      STYLE_ORDER.includes(v.style)
    ) {
      return v;
    }
  } catch {
    /* 忽略损坏的存储 */
  }
  return null;
}

function saveStoredView(v: StoredView) {
  try {
    localStorage.setItem(LS_VIEW, JSON.stringify(v));
  } catch {
    /* 存储不可用时忽略 */
  }
}

export default function App() {
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [activeUdid, setActiveUdid] = useState<string | null>(null);
  const [detailsMap, setDetailsMap] = useState<Record<string, DeviceDetails>>({});
  const [currentPosMap, setCurrentPosMap] = useState<Record<string, LatLon | null>>({});

  const [mode, setMode] = useState<MapMode>('locate');
  const [tab, setTab] = useState<'locate' | 'route'>('locate');
  const [styleKey, setStyleKey] = useState<MapStyleKey>(() => loadStoredView()?.style ?? 'amap');
  const [fitTick, setFitTick] = useState(0);
  /** 内置瓦片服务地址;null = 尚未就绪或不可用(降级直连) */
  const [tileBase, setTileBase] = useState<string | null | undefined>(undefined);
  const [initialView] = useState(() => loadStoredView());

  const [waypoints, setWaypoints] = useState<LatLon[]>([]);
  const [routeOptions, setRouteOptions] = useState<RouteOptions>(DEFAULT_ROUTE_OPTIONS);
  const [progressMap, setProgressMap] = useState<Record<string, RouteProgress>>({});
  const [busy, setBusy] = useState(false);
  /** 最近一次地图视图(用于持久化与预热) */
  const lastViewRef = useRef<{ lat: number; lon: number; zoom: number } | null>(null);
  /** 因无数据自动切走前使用的底图;回到国内时自动切回 */
  const autoSwitchedFromRef = useRef<MapStyleKey | null>(null);
  /** 用户在境外手动选择高德时置位:尊重用户选择,回国后恢复自动切换 */
  const suppressAutoSwitchRef = useRef(false);

  const { toasts, push, dismiss } = useToasts();
  const pushRef = useRef(push);
  pushRef.current = push;

  const activeDevice = devices.find((d) => d.udid === activeUdid) ?? null;
  const activeDetails = activeUdid ? (detailsMap[activeUdid] ?? null) : null;
  const connected = activeDevice?.connected ?? false;
  const connecting = activeDevice?.connecting ?? false;
  const currentPos = activeUdid ? (currentPosMap[activeUdid] ?? null) : null;
  const routeProgress = activeUdid ? (progressMap[activeUdid] ?? null) : null;
  const routeActive = routeProgress != null;
  const gcj = isGcjStyle(styleKey);

  // ---------- 初始化与事件订阅 ----------
  useEffect(() => {
    let alive = true;
    const unsubs: Array<() => void> = [];

    // 内置瓦片服务地址(本地调用,毫秒级返回)
    void api
      .tileServerUrl()
      .then((url) => {
        if (alive) setTileBase(url ?? null);
      })
      .catch(() => {
        if (alive) setTileBase(null);
      });

    void api.listDevices().then((list) => {
      if (alive) setDevices(list);
    });

    const setup = async () => {
      unsubs.push(
        await events.devicesUpdated((list) => {
          setDevices(list);
          setActiveUdid((cur) => cur ?? list[0]?.udid ?? null);
        }),
      );
      unsubs.push(
        await events.deviceState((e: DeviceStateEvent) => {
          if (e.state === 'connected' && e.details) {
            setDetailsMap((m) => ({ ...m, [e.udid]: e.details! }));
            pushRef.current(`「${e.details.name ?? '设备'}」已连接`, 'success');
          } else if (e.state === 'error') {
            pushRef.current(e.message ?? '连接失败', 'error');
          } else if (e.state === 'disconnected') {
            setDetailsMap((m) => {
              const next = { ...m };
              delete next[e.udid];
              return next;
            });
            setCurrentPosMap((m) => ({ ...m, [e.udid]: null }));
          }
        }),
      );
      unsubs.push(
        await events.routeProgress((p) => {
          setProgressMap((m) => ({ ...m, [p.udid]: p }));
          setCurrentPosMap((m) => ({ ...m, [p.udid]: p.position }));
        }),
      );
      unsubs.push(
        await events.routeStopped((e) => {
          setProgressMap((m) => {
            const next = { ...m };
            delete next[e.udid];
            return next;
          });
          if (e.cleared) {
            setCurrentPosMap((m) => ({ ...m, [e.udid]: null }));
          }
        }),
      );
      unsubs.push(
        await events.batteryUpdate((b) => {
          setDetailsMap((m) => {
            const d = m[b.udid];
            if (!d) return m;
            return {
              ...m,
              [b.udid]: { ...d, batteryLevel: b.level, batteryCharging: b.charging },
            };
          });
        }),
      );
    };
    void setup();

    return () => {
      alive = false;
      for (const u of unsubs) u();
    };
  }, []);

  // 设备刚连上时默认选中它
  useEffect(() => {
    if (!activeUdid && devices.length > 0) {
      setActiveUdid(devices[0].udid);
    }
  }, [devices, activeUdid]);

  // ---------- 操作 ----------

  const withBusy = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        push(errorText(e), 'error');
      } finally {
        setBusy(false);
      }
    },
    [push],
  );

  const handleConnect = () =>
    withBusy(async () => {
      if (!activeUdid) return;
      const d = await api.connectDevice(activeUdid);
      setDetailsMap((m) => ({ ...m, [activeUdid]: d }));
    });

  const handleDisconnect = () =>
    withBusy(async () => {
      if (!activeUdid) return;
      await api.disconnectDevice(activeUdid);
      setProgressMap((m) => {
        const next = { ...m };
        delete next[activeUdid];
        return next;
      });
      setCurrentPosMap((m) => ({ ...m, [activeUdid]: null }));
    });

  const applyLocation = (p: LatLon) =>
    withBusy(async () => {
      if (!activeUdid || !connected) return;
      const zoom = lastViewRef.current?.zoom ?? 12;
      // 境外点位:按与视图相同的规则决定是否切换全球底图(设置位置后通常会放大查看)
      maybeAutoSwitchStyle(p, zoom);
      const effectiveStyle =
        isOutsideChina(p.lat, p.lon) && !suppressAutoSwitchRef.current
          ? globalCounterpart(styleKey)
          : styleKey;

      await api.setLocation(activeUdid, p.lat, p.lon);
      setProgressMap((m) => {
        const next = { ...m };
        delete next[activeUdid];
        return next;
      });
      setCurrentPosMap((m) => ({ ...m, [activeUdid]: p }));
      push(`已设置虚拟位置 ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, 'success');

      // 后台预热周边瓦片:用户放大查看时会秒开
      const provider = PROVIDER_BY_STYLE[effectiveStyle];
      const disp = isGcjStyle(effectiveStyle) ? wgs84ToGcj02(p.lat, p.lon) : p;
      void api
        .prefetchTiles(provider, disp.lat, disp.lon, [13, 14, 15, 16])
        .catch(() => {});
    });

  const handleClearLocation = () =>
    withBusy(async () => {
      if (!activeUdid || !connected) return;
      await api.clearLocation(activeUdid);
      setProgressMap((m) => {
        const next = { ...m };
        delete next[activeUdid];
        return next;
      });
      setCurrentPosMap((m) => ({ ...m, [activeUdid]: null }));
      push('已清除虚拟定位,设备恢复真实 GPS', 'success');
    });

  /**
   * 底图可用性自动切换(缩放感知):
   * - 高德在境外 z<=9 有概览数据,继续使用;放大到 z>9(会变成空白)时,
   *   自动切换到对应的全球底图;
   * - 回到国内(带 1.5° 滞回)且仍为自动切换的底图时,自动切回;
   * - 用户在境外手动选择高德时尊重其选择,回国后恢复自动切换。
   */
  const maybeAutoSwitchStyle = (center: LatLon, zoom: number) => {
    const outside = isOutsideChina(center.lat, center.lon);

    if (!outside) {
      suppressAutoSwitchRef.current = false;
      const autoFrom = autoSwitchedFromRef.current;
      if (
        autoFrom !== null &&
        styleKey === globalCounterpart(autoFrom) &&
        !isOutsideChina(center.lat, center.lon, 1.5)
      ) {
        autoSwitchedFromRef.current = null;
        setStyleKey(autoFrom);
        push('已切回高德底图', 'info');
      }
      return;
    }

    if (suppressAutoSwitchRef.current) return;

    if (
      zoom > overseasZoomLimit(styleKey) &&
      isGcjStyle(styleKey) &&
      autoSwitchedFromRef.current === null
    ) {
      autoSwitchedFromRef.current = styleKey;
      setStyleKey(globalCounterpart(styleKey));
      push('该区域在境外且高德无数据,已自动切换为全球底图', 'info');
    }
  };

  const handleMapClick = (p: LatLon) => {
    // 高德底图坐标(GCJ-02)换算为设备使用的 WGS-84
    const wgs = gcj ? gcj02ToWgs84(p.lat, p.lon) : p;
    if (mode === 'locate') {
      if (!connected) {
        push('请先连接设备,再在地图上选点', 'info');
        return;
      }
      void applyLocation(wgs);
    } else if (mode === 'draw') {
      if (routeActive) return; // 回放中不改动路线
      setWaypoints((w) => [...w, wgs]);
    }
  };

  const handleStartRoute = () =>
    withBusy(async () => {
      if (!activeUdid || !connected || waypoints.length === 0) return;
      await api.startRoute(activeUdid, waypoints, routeOptions);
      push('开始回放路线', 'success');
    });

  const handlePauseRoute = () =>
    withBusy(async () => {
      if (!activeUdid) return;
      await api.pauseRoute(activeUdid);
    });

  const handleResumeRoute = () =>
    withBusy(async () => {
      if (!activeUdid) return;
      await api.resumeRoute(activeUdid);
    });

  const handleStopRoute = (clear: boolean) =>
    withBusy(async () => {
      if (!activeUdid) return;
      await api.stopRoute(activeUdid, clear);
      setProgressMap((m) => {
        const next = { ...m };
        delete next[activeUdid];
        return next;
      });
      if (clear) {
        setCurrentPosMap((m) => ({ ...m, [activeUdid]: null }));
      }
    });

  const handleRefreshInfo = () =>
    withBusy(async () => {
      if (!activeUdid) return;
      const res = await api.refreshInfo(activeUdid);
      if (res) {
        setDetailsMap((m) => {
          const d = m[activeUdid];
          if (!d) return m;
          return { ...m, [activeUdid]: { ...d, batteryLevel: res.level, batteryCharging: res.charging } };
        });
      }
    });

  const handleImportGpx = (points: LatLon[], name: string) => {
    setWaypoints(points);
    setTab('route');
    setMode('browse');
    setFitTick((t) => t + 1);
    push(`已导入「${name}」:${points.length} 个航点`, 'success');
  };

  const cycleStyle = () => {
    const idx = STYLE_ORDER.indexOf(styleKey);
    const next = STYLE_ORDER[(idx + 1) % STYLE_ORDER.length];
    setStyleKey(next);
    autoSwitchedFromRef.current = null; // 手动切换后不再自动切回
    const view = lastViewRef.current;
    // 在境外高缩放下手动选择高德:尊重用户选择,暂停自动切换(回国后恢复)
    if (
      view &&
      isGcjStyle(next) &&
      isOutsideChina(view.lat, view.lon) &&
      view.zoom > overseasZoomLimit(next)
    ) {
      suppressAutoSwitchRef.current = true;
    } else if (!isGcjStyle(next)) {
      suppressAutoSwitchRef.current = false;
    }
    if (view) {
      saveStoredView({ ...view, style: next });
    }
  };

  const routePaused = routeActive && (routeProgress?.paused ?? false);

  return (
    <div className="app">
      {tileBase !== undefined && (
        <MapView
          mode={mode}
          styleKey={styleKey}
          tileBase={tileBase}
          gcj={gcj}
          waypoints={waypoints}
          currentPos={currentPos}
          progress={routeActive ? routeProgress : null}
          fitTick={fitTick}
          initialView={initialView}
          onMapClick={handleMapClick}
          onWaypointMove={(index, p) => {
            const wgs = gcj ? gcj02ToWgs84(p.lat, p.lon) : p;
            setWaypoints((w) => w.map((wp, i) => (i === index ? wgs : wp)));
          }}
          onViewChange={(center, zoom) => {
            lastViewRef.current = { lat: center.lat, lon: center.lon, zoom };
            saveStoredView({ lat: center.lat, lon: center.lon, zoom, style: styleKey });
            maybeAutoSwitchStyle(center, zoom);
          }}
        />
      )}

      <DevicePanel
        devices={devices}
        activeUdid={activeUdid}
        details={activeDetails}
        busy={busy}
        connected={connected}
        connecting={connecting}
        simulatedPos={currentPos}
        routeActive={routeActive}
        onSelect={setActiveUdid}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onClear={handleClearLocation}
        onRefreshInfo={handleRefreshInfo}
        onRefreshDevices={() =>
          withBusy(async () => {
            const list = await api.rescanDevices();
            setDevices(list);
          })
        }
      />

      <div className="top-right">
        <div className="pill-group">
          <button className="pill" onClick={cycleStyle} title="切换地图样式">
            <IconLayers />
            {STYLE_LABEL[styleKey]}
          </button>
          <button
            className="pill"
            onClick={() => setFitTick((t) => t + 1)}
            title="回到位置/路线视野"
          >
            <IconTarget />
            居中
          </button>
        </div>
      </div>

      <ControlDock
        tab={tab}
        onTabChange={setTab}
        mode={mode}
        onModeChange={setMode}
        connected={connected}
        busy={busy}
        currentPos={currentPos}
        onApplyCoord={(lat, lon) => void applyLocation({ lat, lon })}
        onClearLocation={handleClearLocation}
        waypoints={waypoints}
        onImportGpx={handleImportGpx}
        onClearWaypoints={() => setWaypoints([])}
        onUndoWaypoint={() => setWaypoints((w) => w.slice(0, -1))}
        routeOptions={routeOptions}
        onRouteOptionsChange={setRouteOptions}
        progress={routeProgress}
        routeActive={routeActive}
        routePaused={routePaused}
        onStartRoute={handleStartRoute}
        onPauseRoute={handlePauseRoute}
        onResumeRoute={handleResumeRoute}
        onStopRoute={handleStopRoute}
        onToast={push}
      />

      {connecting && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="spinner" />
            <p>
              正在与设备建立安全隧道并启动定位服务…
              {'\n'}首次连接可能需要几秒钟
            </p>
          </div>
        </div>
      )}

      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}
