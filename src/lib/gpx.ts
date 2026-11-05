// GPX 解析:优先航迹(trkpt),其次路线(rtept),最后航点(wpt)

import type { LatLon } from '../types';

export interface GpxImport {
  points: LatLon[];
  /** 数据来源:track / route / waypoint */
  source: 'track' | 'route' | 'waypoint';
  name?: string;
}

function collectPoints(parent: Element, tag: string): LatLon[] {
  const out: LatLon[] = [];
  for (const el of Array.from(parent.getElementsByTagNameNS('*', tag))) {
    const lat = Number.parseFloat(el.getAttribute('lat') ?? '');
    const lon = Number.parseFloat(el.getAttribute('lon') ?? '');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ lat, lon });
    }
  }
  return out;
}

export function parseGpx(text: string): GpxImport {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('GPX 文件解析失败:不是合法的 XML');
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') {
    throw new Error('GPX 文件解析失败:根节点不是 <gpx>');
  }

  const name = root.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim() || undefined;

  const trackPoints = collectPoints(root, 'trkpt');
  if (trackPoints.length > 0) {
    return { points: trackPoints, source: 'track', name };
  }
  const routePoints = collectPoints(root, 'rtept');
  if (routePoints.length > 0) {
    return { points: routePoints, source: 'route', name };
  }
  const waypoints = collectPoints(root, 'wpt');
  if (waypoints.length > 0) {
    return { points: waypoints, source: 'waypoint', name };
  }
  throw new Error('GPX 文件中没有可用的轨迹点(trkpt / rtept / wpt)');
}

/** 从文件读取并解析 GPX */
export async function readGpxFile(file: File): Promise<GpxImport> {
  const text = await file.text();
  return parseGpx(text);
}
