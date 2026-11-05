// 与 Rust 后端共享的数据类型(字段名与 serde camelCase 输出一致)

export interface DeviceSnapshot {
  udid: string;
  name: string | null;
  connection: string;
  connected: boolean;
  connecting: boolean;
  productVersion: string | null;
  model: string | null;
}

export interface DeviceDetails {
  udid: string;
  name: string | null;
  modelName: string | null;
  productType: string | null;
  productVersion: string | null;
  buildVersion: string | null;
  serialNumber: string | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  connection: string;
  tunnel: string | null;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteOptions {
  speedKmh: number;
  jitter: boolean;
  loopRoute: boolean;
  keepFinal: boolean;
  updateMs: number;
}

export interface RouteProgress {
  udid: string;
  playing: boolean;
  paused: boolean;
  finished: boolean;
  position: LatLon;
  heading: number;
  speedKmh: number;
  progress: number;
  distanceDoneM: number;
  distanceTotalM: number;
  elapsedS: number;
  etaS: number;
  loopCount: number;
}

export type DeviceState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface DeviceStateEvent {
  udid: string;
  state: DeviceState;
  message: string | null;
  details: DeviceDetails | null;
}

export interface BatteryUpdate {
  udid: string;
  level: number;
  charging: boolean;
}

export interface RouteStoppedEvent {
  udid: string;
  cleared: boolean;
}

export type MapMode = 'locate' | 'draw' | 'browse';
export type MapStyleKey = 'amap' | 'amap-sat' | 'dark' | 'light' | 'satellite';
