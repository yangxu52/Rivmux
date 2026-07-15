# Rivmux Transmux Core

Rust transmux core for Rivmux container parsing and fragmented MP4 generation.

## 内部媒体契约

- 解复用器必须先发出 `TrackConfig`，再发出属于该轨道的 `EncodedSample`。
- `TrackClock` 同时保存输入容器与 fMP4 的时标。当前 FLV 视频保持 `1000 -> 1000`，AAC 保持 `1000 -> sample_rate`；未来 MPEG-TS 可使用 `90000` 输入时标而不改变 fMP4 + MSE 输出路径。
- `VideoCodecConfig` 和 `AudioCodecConfig` 是可扩展的判别联合。具体 codec 配置不依赖容器，fMP4 sample entry 由 codec 专属实现生成。
