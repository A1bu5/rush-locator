// 地图样式定义:全部为本地构建的栅格样式,瓦片经内置代理(含磁盘缓存)加载。
//
// 底图策略:
// - 国内:高德(快、中文注记,GCJ-02 坐标系)
// - 境外:Esri ArcGIS 在线底图(全球覆盖,国内可访问,WGS-84 坐标系)
//   Carto/OSM 的栅格服务在当前网络下不可用或返回占位图,因此不再使用。

import type { LayerSpecification, RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';
import type { MapStyleKey } from '../types';

export interface RasterLayerSpec {
  provider: string;
  /** 该服务自身的最大缩放级别,超出后由 MapLibre 放大低级别瓦片 */
  maxzoom: number;
}

interface StyleSpec {
  label: string;
  attribution: string;
  /** 是否为 GCJ-02 坐标系(需要坐标纠偏) */
  gcj: boolean;
  /** 从底到顶的叠放图层 */
  layers: RasterLayerSpec[];
}

export const STYLE_SPECS: Record<MapStyleKey, StyleSpec> = {
  amap: {
    label: '高德',
    attribution: '© 高德地图',
    gcj: true,
    layers: [{ provider: 'amap-road', maxzoom: 18 }],
  },
  'amap-sat': {
    label: '高德卫星',
    attribution: '© 高德地图',
    gcj: true,
    layers: [{ provider: 'amap-sat', maxzoom: 18 }],
  },
  dark: {
    label: '深色',
    attribution: '© Esri · HERE · Garmin',
    gcj: false,
    layers: [
      { provider: 'esri-dark', maxzoom: 16 },
      { provider: 'esri-dark-ref', maxzoom: 16 },
    ],
  },
  light: {
    label: '浅色',
    attribution: '© Esri · HERE · Garmin',
    gcj: false,
    layers: [
      { provider: 'esri-light', maxzoom: 16 },
      { provider: 'esri-light-ref', maxzoom: 16 },
    ],
  },
  satellite: {
    label: '卫星',
    attribution: '© Esri · Maxar · Earthstar Geographics',
    gcj: false,
    layers: [{ provider: 'esri-imagery', maxzoom: 19 }],
  },
};

/** 底图切换顺序(高德的两种变体排在最前) */
export const STYLE_ORDER: MapStyleKey[] = ['amap', 'amap-sat', 'dark', 'light', 'satellite'];

export const STYLE_LABEL: Record<MapStyleKey, string> = Object.fromEntries(
  STYLE_ORDER.map((k) => [k, STYLE_SPECS[k].label]),
) as Record<MapStyleKey, string>;

/** 预热缓存时使用的代表瓦片层(取最底层) */
export const PROVIDER_BY_STYLE: Record<MapStyleKey, string> = Object.fromEntries(
  STYLE_ORDER.map((k) => [k, STYLE_SPECS[k].layers[0].provider]),
) as Record<MapStyleKey, string>;

/** 高德底图使用 GCJ-02 坐标系,需要做坐标纠偏 */
export function isGcjStyle(style: MapStyleKey): boolean {
  return STYLE_SPECS[style].gcj;
}

/** 无内置代理时的直连地址(降级路径) */
const DIRECT_TILES: Record<string, string> = {
  'amap-road':
    'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  'amap-sat': 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
  'esri-dark':
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  'esri-dark-ref':
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  'esri-light':
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  'esri-light-ref':
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  'esri-imagery':
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

/**
 * 构建栅格样式(可能包含底层 + 标注叠加层)。
 *
 * @param style      样式 key
 * @param tileBase   内置瓦片服务地址(`http://127.0.0.1:PORT`),为 null 时直连上游
 */
export function buildRasterStyle(
  style: MapStyleKey,
  tileBase: string | null,
): StyleSpecification {
  const spec = STYLE_SPECS[style];
  const retina = typeof window !== 'undefined' && window.devicePixelRatio >= 1.5;

  const sources: Record<string, RasterSourceSpecification> = {};
  const layers: LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0e13' } },
  ];

  spec.layers.forEach((layer, i) => {
    const id = `base-${i}`;
    sources[id] = {
      type: 'raster',
      tiles: [
        tileBase
          ? `${tileBase}/tiles/${layer.provider}/{z}/{x}/{y}.png${retina ? '?dpr=2' : ''}`
          : DIRECT_TILES[layer.provider],
      ],
      tileSize: 256,
      maxzoom: layer.maxzoom,
      attribution: i === 0 ? spec.attribution : undefined,
    };
    layers.push({ id, type: 'raster', source: id });
  });

  return { version: 8, sources, layers };
}
