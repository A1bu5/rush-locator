// Tauri 命令与事件封装

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  BatteryUpdate,
  DeviceDetails,
  DeviceSnapshot,
  DeviceStateEvent,
  LatLon,
  RouteOptions,
  RouteProgress,
  RouteStoppedEvent,
} from './types';

export const api = {
  listDevices: () => invoke<DeviceSnapshot[]>('list_devices'),
  rescanDevices: () => invoke<DeviceSnapshot[]>('rescan_devices'),
  connectDevice: (udid: string) => invoke<DeviceDetails>('connect_device', { udid }),
  disconnectDevice: (udid: string) => invoke<void>('disconnect_device', { udid }),
  setLocation: (udid: string, lat: number, lon: number) =>
    invoke<void>('set_location', { udid, lat, lon }),
  clearLocation: (udid: string) => invoke<void>('clear_location', { udid }),
  startRoute: (udid: string, points: LatLon[], options: RouteOptions) =>
    invoke<void>('start_route', { udid, points, options }),
  pauseRoute: (udid: string) => invoke<void>('pause_route', { udid }),
  resumeRoute: (udid: string) => invoke<void>('resume_route', { udid }),
  stopRoute: (udid: string, clear: boolean) => invoke<void>('stop_route', { udid, clear }),
  refreshInfo: (udid: string) =>
    invoke<{ level: number; charging: boolean } | null>('refresh_info', { udid }),
  tileServerUrl: () => invoke<string | null>('tile_server_url'),
  prefetchTiles: (provider: string, lat: number, lon: number, zooms: number[]) =>
    invoke<void>('prefetch_tiles', { provider, lat, lon, zooms }),
};

export const events = {
  devicesUpdated: (cb: (devices: DeviceSnapshot[]) => void): Promise<UnlistenFn> =>
    listen<DeviceSnapshot[]>('devices_updated', (e) => cb(e.payload)),
  deviceState: (cb: (e: DeviceStateEvent) => void): Promise<UnlistenFn> =>
    listen<DeviceStateEvent>('device_state', (e) => cb(e.payload)),
  routeProgress: (cb: (p: RouteProgress) => void): Promise<UnlistenFn> =>
    listen<RouteProgress>('route_progress', (e) => cb(e.payload)),
  routeStopped: (cb: (e: RouteStoppedEvent) => void): Promise<UnlistenFn> =>
    listen<RouteStoppedEvent>('route_stopped', (e) => cb(e.payload)),
  batteryUpdate: (cb: (b: BatteryUpdate) => void): Promise<UnlistenFn> =>
    listen<BatteryUpdate>('battery_update', (e) => cb(e.payload)),
};

/** 将后端错误(字符串)转成可展示的文案 */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
