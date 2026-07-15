# Rivmux Transmux Core

Rust transmux core for Rivmux container parsing and fragmented MP4 generation.

## 内部媒体契约

- 解复用器必须先发出 `TrackConfig`，再发出属于该轨道的 `EncodedSample`。
- `TrackClock` 同时保存输入容器与 fMP4 的时标。当前 FLV 视频保持 `1000 -> 1000`，AAC 保持 `1000 -> sample_rate`；未来 MPEG-TS 可使用 `90000` 输入时标而不改变 fMP4 + MSE 输出路径。
- `VideoCodecConfig` 和 `AudioCodecConfig` 是可扩展的判别联合。具体 codec 配置不依赖容器，fMP4 sample entry 由 codec 专属实现生成。
- 解复用器将容器载荷交给视频或音频归一化器；归一化器只产出 codec 配置和 `EncodedSample`，不依赖 fMP4 事件。当前支持 AVC length-prefixed NAL/Annex-B 与 AAC raw access unit/ADTS；未来容器只需构造相同的归一化输入。
