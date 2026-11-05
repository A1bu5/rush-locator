// 前端几何计算(与后端保持一致的算法,用于即时预览统计)

import type { LatLon } from '../types';

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineM(a: LatLon, b: LatLon): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** 折线总长度(米) */
export function polylineLengthM(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1], points[i]);
  }
  return total;
}

/** 校验经纬度范围 */
export function validLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

// ---------------------------------------------------------------------------
// GCJ-02(火星坐标系)与 WGS-84 互转
// 高德等国内底图使用 GCJ-02;设备 GPS 与其余底图使用 WGS-84。
// 在国内点击地图选点时必须换算,否则定位会有数百米偏移。
// ---------------------------------------------------------------------------

const A = 6378245.0;
const EE = 0.00669342162296594323;

/**
 * 是否在中国大陆范围之外(用于底图可用性判断与坐标纠偏)。
 * @param margin 判定外扩余量(度),用于边界滞回,避免来回抖动
 */
export function isOutsideChina(lat: number, lon: number, margin = 0): boolean {
  return (
    lon < 72.004 - margin ||
    lon > 137.8347 + margin ||
    lat < 0.8293 - margin ||
    lat > 55.8271 + margin
  );
}

function outOfChina(lat: number, lon: number): boolean {
  return isOutsideChina(lat, lon);
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) /
    3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) /
    3.0;
  return ret;
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lat: number, lon: number): LatLon {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

/** GCJ-02 → WGS-84(迭代逼近,误差 < 0.5 米) */
export function gcj02ToWgs84(lat: number, lon: number): LatLon {
  if (outOfChina(lat, lon)) return { lat, lon };
  let wgs = { lat, lon };
  for (let i = 0; i < 3; i++) {
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lon);
    wgs = { lat: wgs.lat + (lat - gcj.lat), lon: wgs.lon + (lon - gcj.lon) };
  }
  return wgs;
}
