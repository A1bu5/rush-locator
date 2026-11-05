// 地图视图:MapLibre GL 封装
// - 瓦片经内置代理加载(持久化缓存,见后端 tiles.rs)
// - 位置标记(脉冲光环 + 朝向 + 位置间平滑过渡动画)
// - 路线图层(完整路线 / 已走过部分 / 航点标记)
// - 点击交互(定位模式 / 绘制模式)
// - 高德底图(GCJ-02)自动做坐标纠偏,其余底图为 WGS-84

import { useEffect, useMemo, useRef } from 'react';
import maplibregl, { type Map as MlMap, type Marker, LngLatBounds } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import type { LatLon, MapMode, MapStyleKey, RouteProgress } from '../types';
import { haversineM, wgs84ToGcj02 } from '../lib/geo';
import { buildRasterStyle } from '../lib/mapStyles';

interface MapViewProps {
  mode: MapMode;
  styleKey: MapStyleKey;
  /** 内置瓦片服务地址(为 null 时直连上游) */
  tileBase: string | null;
  /** 当前底图是否为 GCJ-02 坐标系(高德) */
  gcj: boolean;
  waypoints: LatLon[];
  /** 单点定位后的当前位置(WGS-84) */
  currentPos: LatLon | null;
  /** 路线回放进度(含当前位置,WGS-84) */
  progress: RouteProgress | null;
  /** 递增的“回到视野”触发计数 */
  fitTick: number;
  /** 初始化视图(坐标系与 styleKey 一致) */
  initialView: { lat: number; lon: number; zoom: number } | null;
  onMapClick: (p: LatLon) => void;
  onWaypointMove: (index: number, p: LatLon) => void;
  /** 视图变化(中心点为当前底图坐标系) */
  onViewChange: (center: LatLon, zoom: number) => void;
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

function lineFeature(coords: [number, number][]): FeatureCollection {
  if (coords.length < 2) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      },
    ],
  };
}

/** 计算“已走过”的折线:返回结束于 distanceM 处的坐标串 */
function traveledCoords(waypoints: LatLon[], distanceM: number): [number, number][] {
  if (waypoints.length < 2) return [];
  const out: [number, number][] = [[waypoints[0].lon, waypoints[0].lat]];
  let cum = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const seg = haversineM(waypoints[i - 1], waypoints[i]);
    if (cum + seg < distanceM) {
      cum += seg;
      out.push([waypoints[i].lon, waypoints[i].lat]);
      continue;
    }
    const t = seg > 0 ? (distanceM - cum) / seg : 0;
    const lat = waypoints[i - 1].lat + (waypoints[i].lat - waypoints[i - 1].lat) * t;
    const lon = waypoints[i - 1].lon + (waypoints[i].lon - waypoints[i - 1].lon) * t;
    out.push([lon, lat]);
    break;
  }
  return out.length >= 2 ? out : [];
}

interface PosAnim {
  from: { lat: number; lon: number; heading: number };
  to: { lat: number; lon: number; heading: number };
  start: number;
  duration: number;
}

export function MapView({
  mode,
  styleKey,
  tileBase,
  gcj,
  waypoints,
  currentPos,
  progress,
  fitTick,
  initialView,
  onMapClick,
  onWaypointMove,
  onViewChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const styleLoadedRef = useRef(false);

  const posMarkerRef = useRef<Marker | null>(null);
  const headingRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<PosAnim | null>(null);
  const rafRef = useRef<number | null>(null);
  const renderedRef = useRef<{ lat: number; lon: number; heading: number } | null>(null);

  const wpMarkersRef = useRef<Marker[]>([]);
  const routeCoordsRef = useRef<[number, number][]>([]);
  const doneCoordsRef = useRef<[number, number][]>([]);
  const firstStyleRunRef = useRef(true);

  // 回调经 ref 转发,避免重复注册事件
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onWaypointMoveRef = useRef(onWaypointMove);
  onWaypointMoveRef.current = onWaypointMove;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const initialViewRef = useRef(initialView);

  // ---------- 显示坐标(GCJ 底图需要纠偏) ----------
  const toDisplay = (p: LatLon): LatLon => (gcj ? wgs84ToGcj02(p.lat, p.lon) : p);
  const dispWaypoints = useMemo(
    () => (gcj ? waypoints.map((p) => wgs84ToGcj02(p.lat, p.lon)) : waypoints),
    [waypoints, gcj],
  );

  // ---------- 初始化 ----------
  useEffect(() => {
    if (!containerRef.current) return;
    const view = initialViewRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildRasterStyle(styleKey, tileBase),
      center: view ? [view.lon, view.lat] : [116.3913, 39.9075],
      zoom: view ? view.zoom : 11,
      attributionControl: { compact: true },
      pitchWithRotate: false,
      dragRotate: false,
    });
    mapRef.current = map;

    map.on('style.load', () => {
      styleLoadedRef.current = true;
      addRouteLayers(map);
      // 重新灌入路线数据
      setSourceData(map, 'route-full', lineFeature(routeCoordsRef.current));
      setSourceData(map, 'route-done', lineFeature(doneCoordsRef.current));
    });

    map.on('click', (e) => {
      clickRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onViewChangeRef.current({ lat: c.lat, lon: c.lng }, map.getZoom());
    });

    // 首次加载完成后也触发一次视图检查(用于“境外自动切换底图”等逻辑)
    map.once('load', () => {
      const c = map.getCenter();
      onViewChangeRef.current({ lat: c.lat, lon: c.lng }, map.getZoom());
    });

    // 位置标记 DOM
    const el = document.createElement('div');
    el.className = 'pos-marker';
    el.innerHTML =
      '<div class="pos-ring"></div><div class="pos-heading"></div><div class="pos-dot"></div>';
    headingRef.current = el.querySelector('.pos-heading');
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([116.3913, 39.9075])
      .addTo(map);
    marker.getElement().style.display = 'none';
    posMarkerRef.current = marker;

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
      posMarkerRef.current = null;
      wpMarkersRef.current = [];
      styleLoadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 样式切换(本地样式对象,即时生效) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstStyleRunRef.current) {
      firstStyleRunRef.current = false;
      return;
    }
    styleLoadedRef.current = false;
    map.setStyle(buildRasterStyle(styleKey, tileBase), { diff: false });
  }, [styleKey, tileBase]);

  // ---------- 路线数据 ----------
  const routeCoords = useMemo(
    () => dispWaypoints.map((p) => [p.lon, p.lat] as [number, number]),
    [dispWaypoints],
  );
  const doneCoords = useMemo(
    () => (progress ? traveledCoords(dispWaypoints, progress.distanceDoneM) : []),
    [dispWaypoints, progress],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) return;
    routeCoordsRef.current = routeCoords;
    doneCoordsRef.current = doneCoords;
    setSourceData(map, 'route-full', lineFeature(routeCoords));
    setSourceData(map, 'route-done', lineFeature(doneCoords));
  }, [routeCoords, doneCoords]);

  // ---------- 航点标记 ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    while (wpMarkersRef.current.length > dispWaypoints.length) {
      wpMarkersRef.current.pop()?.remove();
    }
    while (wpMarkersRef.current.length < dispWaypoints.length) {
      const index = wpMarkersRef.current.length;
      const el = document.createElement('div');
      el.className = 'wp-marker';
      el.textContent = String(index + 1);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true })
        .setLngLat([0, 0])
        .addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        onWaypointMoveRef.current(index, { lat: ll.lat, lon: ll.lng });
      });
      wpMarkersRef.current.push(marker);
    }
    wpMarkersRef.current.forEach((marker, i) => {
      const p = dispWaypoints[i];
      const el = marker.getElement();
      if (p) {
        el.style.display = '';
        marker.setLngLat([p.lon, p.lat]);
        el.textContent = String(i + 1);
        el.style.opacity = modeRef.current === 'draw' ? '1' : '0.85';
      } else {
        el.style.display = 'none';
      }
    });
  }, [dispWaypoints]);

  // ---------- 当前位置标记(带过渡动画) ----------
  const rawTarget = progress ? progress.position : currentPos;
  const target = rawTarget ? toDisplay(rawTarget) : null;
  const targetHeading = progress ? progress.heading : 0;

  useEffect(() => {
    const marker = posMarkerRef.current;
    if (!marker) return;
    const el = marker.getElement();
    if (!target) {
      el.style.display = 'none';
      renderedRef.current = null;
      return;
    }
    el.style.display = '';
    const rendered = renderedRef.current;
    if (!rendered) {
      marker.setLngLat([target.lon, target.lat]);
      renderedRef.current = { lat: target.lat, lon: target.lon, heading: targetHeading };
      applyHeading(headingRef.current, targetHeading);
      return;
    }
    animRef.current = {
      from: rendered,
      to: { lat: target.lat, lon: target.lon, heading: targetHeading },
      start: performance.now(),
      duration: 320,
    };
    if (rafRef.current == null) tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.lat, target?.lon, targetHeading]);

  const tick = () => {
    const anim = animRef.current;
    const marker = posMarkerRef.current;
    if (!anim || !marker) {
      rafRef.current = null;
      return;
    }
    const now = performance.now();
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const e = easeOutCubic(t);
    const lat = anim.from.lat + (anim.to.lat - anim.from.lat) * e;
    const lon = anim.from.lon + (anim.to.lon - anim.from.lon) * e;
    const heading = lerpAngle(anim.from.heading, anim.to.heading, e);
    marker.setLngLat([lon, lat]);
    applyHeading(headingRef.current, heading);
    renderedRef.current = { lat, lon, heading };
    if (t < 1) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
      animRef.current = null;
    }
  };

  // ---------- 回到视野 ----------
  useEffect(() => {
    if (fitTick <= 0) return;
    const map = mapRef.current;
    if (!map) return;
    const pts: LatLon[] = [...dispWaypoints];
    if (target) pts.push(target);
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.flyTo({ center: [pts[0].lon, pts[0].lat], zoom: 15, duration: 700 });
      return;
    }
    const bounds = new LngLatBounds();
    for (const p of pts) bounds.extend([p.lon, p.lat]);
    map.fitBounds(bounds, {
      padding: { top: 120, bottom: 200, left: 400, right: 260 },
      duration: 700,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick]);

  return <div ref={containerRef} className={`map-container mode-${mode}`} />;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function addRouteLayers(map: MlMap) {
  if (map.getSource('route-full')) return;
  map.addSource('route-full', { type: 'geojson', data: EMPTY_FC });
  map.addSource('route-done', { type: 'geojson', data: EMPTY_FC });

  map.addLayer({
    id: 'route-glow',
    type: 'line',
    source: 'route-full',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#6366f1',
      'line-width': 9,
      'line-opacity': 0.22,
      'line-blur': 3,
    },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-full',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#a5b4fc',
      'line-width': 3,
      'line-opacity': 0.75,
      'line-dasharray': [1, 1.6],
    },
  });
  map.addLayer({
    id: 'route-done-glow',
    type: 'line',
    source: 'route-done',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#22d3ee', 'line-width': 10, 'line-opacity': 0.3, 'line-blur': 4 },
  });
  map.addLayer({
    id: 'route-done',
    type: 'line',
    source: 'route-done',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#22d3ee', 'line-width': 4 },
  });
}

function setSourceData(map: MlMap, id: string, data: FeatureCollection) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data);
}

function applyHeading(el: HTMLDivElement | null, heading: number) {
  if (el) el.style.transform = `rotate(${heading}deg)`;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}
