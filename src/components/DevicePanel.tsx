// 左侧面板:品牌头 + 设备列表 + 设备详情 + 会话操作

import type { DeviceDetails, DeviceSnapshot } from '../types';
import { formatCoord, shortUdid } from '../lib/format';
import {
  IconAlert,
  IconBattery,
  IconCrosshair,
  IconPin,
  IconPower,
  IconRefresh,
  IconTarget,
  IconTrash,
  IconUsb,
  IconWifi,
} from './icons';

interface DevicePanelProps {
  devices: DeviceSnapshot[];
  activeUdid: string | null;
  details: DeviceDetails | null;
  busy: boolean;
  /** 当前设备是否已建立会话 */
  connected: boolean;
  connecting: boolean;
  simulatedPos: { lat: number; lon: number } | null;
  routeActive: boolean;
  onSelect: (udid: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onClear: () => void;
  onRefreshInfo: () => void;
  /** 重新扫描设备 */
  onRefreshDevices: () => void;
}

function connChip(connection: string) {
  if (connection === 'USB') {
    return (
      <span className="chip usb">
        <IconUsb />
        有线
      </span>
    );
  }
  return (
    <span className="chip wifi">
      <IconWifi />
      无线
    </span>
  );
}

function statusDot(connected: boolean, connecting: boolean) {
  const cls = connecting ? 'status-dot connecting' : connected ? 'status-dot on' : 'status-dot';
  return <span className={cls} />;
}

function batteryClass(level: number): string {
  if (level <= 20) return 'battery-fill low';
  if (level <= 50) return 'battery-fill mid';
  return 'battery-fill';
}

export function DevicePanel({
  devices,
  activeUdid,
  details,
  busy,
  connected,
  connecting,
  simulatedPos,
  routeActive,
  onSelect,
  onConnect,
  onDisconnect,
  onClear,
  onRefreshInfo,
  onRefreshDevices,
}: DevicePanelProps) {
  const active = devices.find((d) => d.udid === activeUdid) ?? null;

  return (
    <aside className="glass side-panel">
      <div className="brand">
        <div className="brand-logo">
          <IconPin style={{ color: 'white' }} />
        </div>
        <div>
          <div className="brand-title">RUSH Locator</div>
          <div className="brand-sub">iPhone 虚拟定位工作台</div>
        </div>
      </div>

      <div className="divider" />

      <div className="section" style={{ paddingTop: 14 }}>
        <div className="section-label">
          <span>设备</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="count">{devices.length} 台</span>
            <button
              className="btn btn-ghost btn-icon"
              title="重新扫描设备"
              disabled={busy}
              onClick={onRefreshDevices}
            >
              <IconRefresh />
            </button>
          </span>
        </div>

        {devices.length === 0 ? (
          <div className="empty">
            <IconUsb />
            <p>
              未检测到 iOS 设备
              <br />
              请检查:数据线支持传输、iPhone 已解锁并「信任此电脑」;
              <br />
              或让 iPhone 与本机处于同一 Wi-Fi。
              <br />
              点击右上角刷新按钮可立即重试。
            </p>
          </div>
        ) : (
          devices.map((d) => (
            <div
              key={d.udid}
              className={`device-card${d.udid === activeUdid ? ' active' : ''}`}
              onClick={() => onSelect(d.udid)}
            >
              <div className="device-card-head">
                {statusDot(d.connected, d.connecting)}
                <span className="device-name">{d.name ?? 'iPhone'}</span>
                {connChip(d.connection)}
              </div>
              <div className="device-meta">
                {d.model && <span className="chip">{d.model}</span>}
                {d.productVersion && <span>iOS {d.productVersion}</span>}
                {d.connected && <span className="chip on">已连接</span>}
                {d.connecting && <span className="chip connecting">连接中</span>}
              </div>
              <div className="device-udid">{shortUdid(d.udid)}</div>
            </div>
          ))
        )}
      </div>

      {active && (
        <>
          <div className="divider" />
          <div className="section" style={{ paddingTop: 14 }}>
            <div className="section-label">
              <span>会话</span>
            </div>
            {!connected ? (
              <button className="btn btn-primary" disabled={busy || connecting} onClick={onConnect}>
                <IconPower />
                {connecting ? '正在建立隧道…' : '连接设备'}
              </button>
            ) : (
              <div className="btn-row">
                <button className="btn btn-ghost" disabled={routeActive || busy} onClick={onClear}>
                  <IconTrash />
                  清除定位
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={onDisconnect}>
                  <IconPower />
                  断开
                </button>
              </div>
            )}
            <div className="hint">
              <IconAlert />
              <span>连接需设备已解锁、已信任本机,且开启「开发者模式」。</span>
            </div>
          </div>

          {connected && details && (
            <>
              <div className="divider" />
              <div className="section" style={{ paddingTop: 14 }}>
                <div className="section-label">
                  <span>设备信息</span>
                  <button
                    className="btn btn-ghost btn-icon"
                    title="刷新电量"
                    disabled={busy}
                    onClick={onRefreshInfo}
                  >
                    <IconRefresh />
                  </button>
                </div>
                <div className="info-grid">
                  <div className="info-cell">
                    <div className="k">型号</div>
                    <div className="v" title={details.modelName ?? details.productType ?? ''}>
                      {details.modelName ?? details.productType ?? '--'}
                    </div>
                  </div>
                  <div className="info-cell">
                    <div className="k">系统</div>
                    <div className="v">
                      {details.productVersion ? `iOS ${details.productVersion}` : '--'}
                    </div>
                  </div>
                  <div className="info-cell">
                    <div className="k">连接</div>
                    <div className="v">{details.tunnel ?? details.connection}</div>
                  </div>
                  <div className="info-cell">
                    <div className="k">构建</div>
                    <div className="v mono">{details.buildVersion ?? '--'}</div>
                  </div>
                  {details.batteryLevel !== null ? (
                    <div className="info-cell wide">
                      <div className="k">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <IconBattery style={{ width: 12, height: 12 }} />
                          电量
                          {details.batteryCharging ? '(充电中)' : ''}
                        </span>
                      </div>
                      <div className="battery">
                        <div className="battery-shell">
                          <div
                            className={batteryClass(details.batteryLevel)}
                            style={{ width: `${details.batteryLevel}%` }}
                          />
                        </div>
                        <span className="battery-txt">{details.batteryLevel}%</span>
                      </div>
                    </div>
                  ) : (
                    <div className="info-cell wide">
                      <div className="k">电量</div>
                      <div className="v" style={{ color: 'var(--text-faint)' }}>
                        刷新后读取
                      </div>
                    </div>
                  )}
                  <div className="info-cell wide">
                    <div className="k">UDID</div>
                    <div className="v mono" title={details.udid}>
                      {details.udid}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {connected && (
            <>
              <div className="divider" />
              <div className="section" style={{ paddingTop: 14 }}>
                <div className="section-label">
                  <span>当前虚拟位置</span>
                </div>
                {simulatedPos ? (
                  <div className="info-cell wide" style={{ margin: 0 }}>
                    <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <IconCrosshair style={{ width: 12, height: 12 }} />
                      模拟中
                    </div>
                    <div className="v mono">
                      {formatCoord(simulatedPos.lat)}, {formatCoord(simulatedPos.lon)}
                    </div>
                  </div>
                ) : (
                  <div className="hint">
                    <IconTarget />
                    <span>尚未设置虚拟位置。可在下方控制坞点击「点击定位」后在地图上选点。</span>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
