// 底部控制坞:定位模式 + 路线模拟(重点功能)

import { useRef, useState } from 'react';
import type { LatLon, MapMode, RouteOptions, RouteProgress } from '../types';
import { formatCoord, formatDistance, formatDuration, formatSpeed } from '../lib/format';
import { polylineLengthM, validLatLon } from '../lib/geo';
import { readGpxFile } from '../lib/gpx';
import {
  IconCrosshair,
  IconGauge,
  IconMap,
  IconPause,
  IconPin,
  IconPlay,
  IconRoute,
  IconStop,
  IconTrash,
  IconUndo,
  IconUpload,
} from './icons';

interface ControlDockProps {
  tab: 'locate' | 'route';
  onTabChange: (t: 'locate' | 'route') => void;
  mode: MapMode;
  onModeChange: (m: MapMode) => void;
  connected: boolean;
  busy: boolean;

  // 定位
  currentPos: LatLon | null;
  onApplyCoord: (lat: number, lon: number) => void;
  onClearLocation: () => void;

  // 路线
  waypoints: LatLon[];
  onImportGpx: (points: LatLon[], name: string) => void;
  onClearWaypoints: () => void;
  onUndoWaypoint: () => void;
  routeOptions: RouteOptions;
  onRouteOptionsChange: (o: RouteOptions) => void;
  progress: RouteProgress | null;
  routeActive: boolean;
  routePaused: boolean;
  onStartRoute: () => void;
  onPauseRoute: () => void;
  onResumeRoute: () => void;
  onStopRoute: (clear: boolean) => void;
  onToast: (msg: string, kind?: 'info' | 'success' | 'error') => void;
}

const SPEED_PRESETS: { label: string; value: number }[] = [
  { label: '步行', value: 5 },
  { label: '跑步', value: 12 },
  { label: '骑行', value: 25 },
  { label: '驾车', value: 60 },
  { label: '高速', value: 110 },
];

export function ControlDock(props: ControlDockProps) {
  const { tab, onTabChange } = props;
  return (
    <section className="glass dock">
      <div className="dock-tabs">
        <button
          className={`dock-tab${tab === 'locate' ? ' active' : ''}`}
          onClick={() => onTabChange('locate')}
        >
          <IconCrosshair />
          单点定位
        </button>
        <button
          className={`dock-tab${tab === 'route' ? ' active' : ''}`}
          onClick={() => onTabChange('route')}
        >
          <IconRoute />
          路线模拟
        </button>
      </div>
      <div className="dock-body">
        {tab === 'locate' ? <LocateTab {...props} /> : <RouteTab {...props} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 单点定位
// ---------------------------------------------------------------------------

function LocateTab({
  mode,
  onModeChange,
  connected,
  busy,
  currentPos,
  onApplyCoord,
  onClearLocation,
}: ControlDockProps) {
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');

  const apply = () => {
    const lat = Number.parseFloat(latText);
    const lon = Number.parseFloat(lonText);
    if (!validLatLon(lat, lon)) return; // 非法输入忽略
    onApplyCoord(lat, lon);
  };

  return (
    <>
      <div className="mode-bar">
        <button
          className={`mode-btn${mode === 'locate' ? ' active' : ''}`}
          onClick={() => onModeChange('locate')}
        >
          <IconCrosshair />
          点击地图定位
        </button>
        <button
          className={`mode-btn${mode === 'draw' ? ' active' : ''}`}
          onClick={() => onModeChange('draw')}
        >
          <IconRoute />
          绘制路线
        </button>
        <button
          className={`mode-btn${mode === 'browse' ? ' active' : ''}`}
          onClick={() => onModeChange('browse')}
        >
          <IconMap />
          浏览
        </button>
      </div>

      <div className="field-row">
        <div className="field">
          <label>纬度 Latitude</label>
          <input
            className="input"
            placeholder="39.907500"
            value={latText}
            onChange={(e) => setLatText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="field">
          <label>经度 Longitude</label>
          <input
            className="input"
            placeholder="116.391300"
            value={lonText}
            onChange={(e) => setLonText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <button
          className="btn btn-primary"
          style={{ height: 36 }}
          disabled={!connected || busy}
          onClick={apply}
        >
          <IconPin />
          应用
        </button>
        <button
          className="btn btn-danger"
          style={{ height: 36 }}
          disabled={!connected || busy || !currentPos}
          onClick={onClearLocation}
        >
          <IconTrash />
          清除
        </button>
      </div>

      <div className="progress-stats">
        <span>
          当前虚拟位置:{' '}
          <b>
            {currentPos
              ? `${formatCoord(currentPos.lat)}, ${formatCoord(currentPos.lon)}`
              : '未设置'}
          </b>
        </span>
        <span style={{ color: 'var(--text-faint)' }}>
          {mode === 'locate' ? '已开启地图点选:单击地图即可定位' : '切换到「点击地图定位」后可选点'}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 路线模拟
// ---------------------------------------------------------------------------

function RouteTab({
  connected,
  busy,
  mode,
  onModeChange,
  waypoints,
  onImportGpx,
  onClearWaypoints,
  onUndoWaypoint,
  routeOptions,
  onRouteOptionsChange,
  progress,
  routeActive,
  routePaused,
  onStartRoute,
  onPauseRoute,
  onResumeRoute,
  onStopRoute,
  onToast,
}: ControlDockProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const totalM = polylineLengthM(waypoints);

  const importFile = async (file: File) => {
    try {
      const gpx = await readGpxFile(file);
      onImportGpx(
        gpx.points,
        gpx.name ?? file.name.replace(/\.gpx$/i, ''),
      );
      onToast(`已导入 ${gpx.points.length} 个轨迹点(${sourceLabel(gpx.source)})`, 'success');
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const playing = routeActive && !routePaused;
  const showProgress = progress && (routeActive || progress.finished);

  return (
    <>
      <div className="mode-bar" style={{ alignItems: 'stretch' }}>
        <button
          className={`mode-btn${mode === 'draw' ? ' active' : ''}`}
          onClick={() => onModeChange(mode === 'draw' ? 'browse' : 'draw')}
        >
          <IconRoute />
          {mode === 'draw' ? '绘制中(点击地图添加)' : '在地图上绘制路线'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: '0 0 auto' }}
          onClick={() => fileRef.current?.click()}
        >
          <IconUpload />
          导入 GPX
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gpx,application/gpx+xml,text/xml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="progress-stats" style={{ justifyContent: 'space-between' }}>
        <span>
          航点 <b>{waypoints.length}</b>
        </span>
        <span>
          总距离 <b>{formatDistance(totalM)}</b>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            className="btn btn-ghost"
            disabled={!waypoints.length || routeActive}
            onClick={onUndoWaypoint}
          >
            <IconUndo />
            撤销
          </button>
          <button
            className="btn btn-ghost"
            disabled={!waypoints.length || routeActive}
            onClick={onClearWaypoints}
          >
            <IconTrash />
            清空
          </button>
        </span>
      </div>

      <div className="slider-row">
        <IconGauge style={{ width: 15, height: 15, color: 'var(--text-dim)', flexShrink: 0 }} />
        <input
          className="slider"
          type="range"
          min={1}
          max={160}
          step={1}
          value={routeOptions.speedKmh}
          style={
            {
              '--fill': `${((routeOptions.speedKmh - 1) / 159) * 100}%`,
            } as React.CSSProperties
          }
          onChange={(e) =>
            onRouteOptionsChange({ ...routeOptions, speedKmh: Number(e.target.value) })
          }
        />
        <span className="speed-readout">
          {formatSpeed(routeOptions.speedKmh)}
          <small>km/h</small>
        </span>
      </div>

      <div className="preset-row">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p.label}
            className={`preset${Math.abs(routeOptions.speedKmh - p.value) < 0.5 ? ' active' : ''}`}
            onClick={() => onRouteOptionsChange({ ...routeOptions, speedKmh: p.value })}
          >
            {p.label} {p.value}
          </button>
        ))}
      </div>

      <div className="switch-row">
        <Switch
          label="速度抖动"
          on={routeOptions.jitter}
          onClick={() => onRouteOptionsChange({ ...routeOptions, jitter: !routeOptions.jitter })}
        />
        <Switch
          label="循环回放"
          on={routeOptions.loopRoute}
          onClick={() =>
            onRouteOptionsChange({ ...routeOptions, loopRoute: !routeOptions.loopRoute })
          }
        />
        <Switch
          label="保留终点"
          on={routeOptions.keepFinal}
          onClick={() =>
            onRouteOptionsChange({ ...routeOptions, keepFinal: !routeOptions.keepFinal })
          }
        />
      </div>

      <div className="transport">
        <button
          className="transport-btn primary"
          disabled={!connected || busy || waypoints.length === 0 || playing}
          title={routePaused ? '继续' : '开始回放'}
          onClick={routePaused ? onResumeRoute : onStartRoute}
        >
          <IconPlay />
        </button>
        <button
          className="transport-btn"
          disabled={!routeActive || !playing}
          title="暂停"
          onClick={onPauseRoute}
        >
          <IconPause />
        </button>
        <button
          className="transport-btn"
          disabled={!routeActive}
          title="停止(保留当前位置)"
          onClick={() => onStopRoute(false)}
        >
          <IconStop />
        </button>
        <button
          className="transport-btn"
          disabled={!routeActive}
          title="停止并清除虚拟定位"
          onClick={() => onStopRoute(true)}
        >
          <IconTrash />
        </button>

        <div className="progress-block">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${showProgress ? Math.round(progress.progress * 100) : 0}%` }}
            />
          </div>
          <div className="progress-stats">
            {showProgress ? (
              <>
                <span>
                  已行进 <b>{formatDistance(progress.distanceDoneM)}</b>
                </span>
                <span>
                  用时 <b>{formatDuration(progress.elapsedS)}</b>
                </span>
                <span>
                  剩余 <b>{formatDuration(progress.etaS)}</b>
                </span>
                <span>
                  速度 <b>{formatSpeed(progress.speedKmh)}</b> km/h
                </span>
                {progress.loopCount > 0 && (
                  <span>
                    第 <b>{progress.loopCount + 1}</b> 圈
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--text-faint)' }}>
                设置路线与速度后,点击 ▶ 开始回放
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Switch({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className={`switch-item${on ? ' on' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <div className={`switch${on ? ' on' : ''}`} />
    </div>
  );
}

function sourceLabel(source: 'track' | 'route' | 'waypoint'): string {
  return source === 'track' ? '航迹' : source === 'route' ? '路线' : '航点';
}
