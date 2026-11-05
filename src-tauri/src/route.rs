//! 路线几何计算与回放状态机(纯逻辑,含单元测试)。

use crate::model::{LatLon, RouteOptions, RouteProgress};

const EARTH_RADIUS_M: f64 = 6_371_008.8;
/// 采样点间距(米):把折线细分成密集采样点,回放时按行驶距离插值,移动更顺滑。
const SAMPLE_STEP_M: f64 = 8.0;
/// 采样点数量上限,超长路线自动放宽间距。
const MAX_SAMPLES: usize = 300_000;

/// 一个采样点:坐标 + 从起点累计的距离(米)
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub lat: f64,
    pub lon: f64,
    pub cum_m: f64,
}

/// 细分后的路线
#[derive(Debug, Clone)]
pub struct RoutePath {
    pub samples: Vec<Sample>,
    pub total_m: f64,
}

/// Haversine 距离(米)
pub fn haversine_m(a: LatLon, b: LatLon) -> f64 {
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = (b.lat - a.lat).to_radians();
    let dlon = (b.lon - a.lon).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

/// 航向角(度,0-360)
pub fn bearing_deg(a: LatLon, b: LatLon) -> f64 {
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlon = (b.lon - a.lon).to_radians();
    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    let deg = y.atan2(x).to_degrees();
    (deg + 360.0) % 360.0
}

/// 在 a-b 之间按比例 t (0..1) 线性插值(小距离前提下足够精确)
fn lerp(a: LatLon, b: LatLon, t: f64) -> LatLon {
    LatLon {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
    }
}

impl RoutePath {
    /// 由航点(至少 1 个)构建细分路线。
    pub fn build(points: &[LatLon]) -> Result<Self, String> {
        if points.is_empty() {
            return Err("路线为空".into());
        }
        for p in points {
            if !p.lat.is_finite()
                || !p.lon.is_finite()
                || !(-90.0..=90.0).contains(&p.lat)
                || !(-180.0..=180.0).contains(&p.lon)
            {
                return Err("路线包含非法坐标".into());
            }
        }
        if points.len() == 1 {
            return Ok(Self {
                samples: vec![Sample {
                    lat: points[0].lat,
                    lon: points[0].lon,
                    cum_m: 0.0,
                }],
                total_m: 0.0,
            });
        }

        // 先用航点粗算总长,据此决定采样步长(限制显存与内存占用)
        let rough_total: f64 = points.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
        let step = if rough_total > SAMPLE_STEP_M * MAX_SAMPLES as f64 {
            rough_total / MAX_SAMPLES as f64
        } else {
            SAMPLE_STEP_M
        };

        let mut samples = Vec::with_capacity(1024);
        samples.push(Sample {
            lat: points[0].lat,
            lon: points[0].lon,
            cum_m: 0.0,
        });
        let mut cum = 0.0f64;

        for w in points.windows(2) {
            let (a, b) = (w[0], w[1]);
            let seg_len = haversine_m(a, b);
            if seg_len < 1e-9 {
                continue;
            }
            let steps = (seg_len / step).ceil().max(1.0) as usize;
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                let p = lerp(a, b, t);
                cum += seg_len / steps as f64;
                samples.push(Sample {
                    lat: p.lat,
                    lon: p.lon,
                    cum_m: cum,
                });
            }
        }

        Ok(Self {
            samples,
            total_m: cum,
        })
    }

    /// 按累计距离取插值坐标
    pub fn sample_at(&self, distance_m: f64) -> LatLon {
        let d = distance_m.clamp(0.0, self.total_m);
        let idx = self.samples.partition_point(|s| s.cum_m < d);
        if idx == 0 {
            let s = self.samples[0];
            return LatLon {
                lat: s.lat,
                lon: s.lon,
            };
        }
        if idx >= self.samples.len() {
            let s = self.samples[self.samples.len() - 1];
            return LatLon {
                lat: s.lat,
                lon: s.lon,
            };
        }
        let prev = self.samples[idx - 1];
        let next = self.samples[idx];
        let span = next.cum_m - prev.cum_m;
        let t = if span > 0.0 {
            (d - prev.cum_m) / span
        } else {
            0.0
        };
        lerp(
            LatLon {
                lat: prev.lat,
                lon: prev.lon,
            },
            LatLon {
                lat: next.lat,
                lon: next.lon,
            },
            t,
        )
    }

    /// 距离 d 处的航向(取前后一个小步长计算)
    pub fn heading_at(&self, distance_m: f64) -> f64 {
        let d = distance_m.clamp(0.0, self.total_m);
        let delta = 6.0f64.min(self.total_m).max(0.5);
        let a = self.sample_at((d - delta).max(0.0));
        let b = self.sample_at((d + delta).min(self.total_m));
        if haversine_m(a, b) < 0.01 {
            0.0
        } else {
            bearing_deg(a, b)
        }
    }
}

/// 回放状态机:根据经过的真实时间推进行驶距离,并给出要发送给设备的位置。
#[derive(Debug)]
pub struct RoutePlayback {
    pub path: RoutePath,
    pub options: RouteOptions,
    pub done_m: f64,
    pub elapsed_s: f64,
    pub playing: bool,
    pub finished: bool,
    pub loop_count: u32,
    /// 最近一次实际发送给设备的位置(避免无意义的重复推送)
    pub last_sent: Option<LatLon>,
    /// 距下次推送还差多少毫秒
    pub ms_since_send: u64,
    /// 速度抖动状态(0.85 - 1.15 之间平滑变化)
    pub jitter_current: f64,
    jitter_target: f64,
    jitter_countdown_ms: u64,
}

impl RoutePlayback {
    pub fn new(path: RoutePath, options: RouteOptions) -> Self {
        Self {
            path,
            options,
            done_m: 0.0,
            elapsed_s: 0.0,
            playing: true,
            finished: false,
            loop_count: 0,
            last_sent: None,
            ms_since_send: u64::MAX,
            jitter_current: 1.0,
            jitter_target: 1.0,
            jitter_countdown_ms: 0,
        }
    }

    /// 当前有效速度(m/s)
    fn speed_ms(&self) -> f64 {
        (self.options.speed_kmh.max(0.1) / 3.6) * self.jitter_current
    }

    /// 推进 dt 毫秒。返回本次 tick 结束后需要推送给设备的坐标(若需要)。
    pub fn advance(&mut self, dt_ms: u64) -> Option<LatLon> {
        if !self.playing || self.finished {
            return None;
        }
        let dt = dt_ms as f64 / 1000.0;
        self.elapsed_s += dt;

        // 速度抖动:分段随机目标 + 向目标平滑逼近
        if self.options.jitter {
            self.jitter_countdown_ms = self.jitter_countdown_ms.saturating_sub(dt_ms);
            if self.jitter_countdown_ms == 0 {
                // 简单 LCG 随机,避免额外依赖
                let n = self.elapsed_s.to_bits() ^ (self.done_m.to_bits() << 1);
                let r = ((n
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407)
                    >> 33)
                    % 1000) as f64
                    / 1000.0;
                self.jitter_target = 0.85 + 0.30 * r;
                self.jitter_countdown_ms = 1500 + (r * 2500.0) as u64;
            }
            self.jitter_current += (self.jitter_target - self.jitter_current) * 0.08;
        } else {
            self.jitter_current = 1.0;
        }

        self.done_m += self.speed_ms() * dt;

        if self.done_m >= self.path.total_m {
            if self.options.loop_route && self.path.total_m > 0.0 {
                self.done_m %= self.path.total_m;
                self.loop_count += 1;
            } else {
                self.done_m = self.path.total_m;
                self.finished = true;
                self.playing = false;
            }
        }

        // 到达第一个点或到达推送间隔时推送
        let pos = self.path.sample_at(self.done_m);
        let send_due = self.ms_since_send >= self.options.update_ms.max(50);
        self.ms_since_send = self.ms_since_send.saturating_add(dt_ms);

        let moved_enough = match self.last_sent {
            None => true,
            Some(last) => haversine_m(last, pos) >= 0.5,
        };

        if self.finished || (send_due && moved_enough) {
            self.last_sent = Some(pos);
            self.ms_since_send = 0;
            Some(pos)
        } else {
            None
        }
    }

    /// 生成当前进度快照
    pub fn progress(&self, udid: &str) -> RouteProgress {
        let position = self
            .last_sent
            .unwrap_or_else(|| self.path.sample_at(self.done_m));
        let heading = self.path.heading_at(self.done_m);
        let total = self.path.total_m;
        let progress = if total > 0.0 {
            (self.done_m / total).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let remaining = (total - self.done_m).max(0.0);
        let eta = remaining / (self.options.speed_kmh.max(0.1) / 3.6);
        RouteProgress {
            udid: udid.to_string(),
            playing: self.playing,
            paused: !self.playing && !self.finished,
            finished: self.finished,
            position,
            heading,
            speed_kmh: (self.speed_ms() * 3.6),
            progress,
            distance_done_m: self.done_m,
            distance_total_m: total,
            elapsed_s: self.elapsed_s,
            eta_s: eta,
            loop_count: self.loop_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(lat: f64, lon: f64) -> LatLon {
        LatLon { lat, lon }
    }

    #[test]
    fn haversine_known_distance() {
        // 纽约(自由女神像附近)到大约 1km 外的点
        let d = haversine_m(p(40.6892, -74.0445), p(40.6982, -74.0445));
        assert!((d - 1000.0).abs() < 20.0, "got {d}");
    }

    #[test]
    fn build_single_point() {
        let path = RoutePath::build(&[p(31.23, 121.47)]).unwrap();
        assert_eq!(path.total_m, 0.0);
        assert_eq!(path.samples.len(), 1);
        let pos = path.sample_at(10.0);
        assert!((pos.lat - 31.23).abs() < 1e-9);
    }

    #[test]
    fn build_and_sample_along_segment() {
        // 约 1.1km 的南北线
        let path = RoutePath::build(&[p(40.0, -74.0), p(40.01, -74.0)]).unwrap();
        assert!(path.total_m > 1000.0 && path.total_m < 1200.0);
        assert!(path.samples.len() > 100);
        let mid = path.sample_at(path.total_m / 2.0);
        assert!((mid.lat - 40.005).abs() < 0.0005, "{mid:?}");
        // 航向约 0 度(向北)
        let h = path.heading_at(path.total_m / 2.0);
        assert!(h < 5.0 || h > 355.0, "heading {h}");
    }

    #[test]
    fn playback_advances_and_finishes() {
        let path = RoutePath::build(&[p(40.0, -74.0), p(40.01, -74.0)]).unwrap();
        let total = path.total_m;
        let mut pb = RoutePlayback::new(
            path,
            RouteOptions {
                speed_kmh: 36.0, // 10 m/s -> ~110s
                jitter: false,
                loop_route: false,
                keep_final: true,
                update_ms: 200,
            },
        );
        // 模拟 200ms tick
        let mut sent = 0;
        for _ in 0..2000 {
            if pb.advance(200).is_some() {
                sent += 1;
            }
            if pb.finished {
                break;
            }
        }
        assert!(pb.finished);
        assert!((pb.done_m - total).abs() < 0.001);
        assert!(sent > 10);
        assert!(
            pb.elapsed_s > 100.0 && pb.elapsed_s < 120.0,
            "{}",
            pb.elapsed_s
        );
    }

    #[test]
    fn playback_loops() {
        let path = RoutePath::build(&[p(40.0, -74.0), p(40.001, -74.0)]).unwrap();
        let mut pb = RoutePlayback::new(
            path,
            RouteOptions {
                speed_kmh: 360.0,
                jitter: false,
                loop_route: true,
                keep_final: true,
                update_ms: 200,
            },
        );
        for _ in 0..200 {
            pb.advance(200);
        }
        assert!(!pb.finished);
        assert!(pb.loop_count >= 1);
    }
}
