# Rivmux Transmux Fixtures

## `h264-aac.flv`

仓库内生成的测试媒体，不包含第三方内容。

- 生成工具：FFmpeg `7.1.5-0+deb13u1`
- 时长：2.99 秒
- 视频：H.264 Constrained Baseline，320x240，30 fps，无 B 帧
- 音频：AAC-LC，44.1 kHz，双声道，64 kbit/s
- 大小：222370 bytes
- SHA-256: `2231083b1af0354efe4d6481ab49ca99e210446953db9cff6608b8dbde784ce8`

在仓库根目录执行以下命令重新生成：

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'testsrc2=size=320x240:rate=30' \
  -f lavfi -i 'sine=frequency=1000:sample_rate=44100' \
  -t 3 \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -profile:v baseline -level:v 3.0 \
  -pix_fmt yuv420p -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 \
  -preset veryfast -tune zerolatency -threads:v 1 \
  -c:a aac -profile:a aac_low -ar 44100 -ac 2 -b:a 64k \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  -flvflags no_duration_filesize \
  -f flv crates/transmux-fixtures/fixtures/h264-aac.flv
```

重新生成后，提交前必须核对文件大小和摘要。

## `hevc-aac.flv`

仓库内生成的 Enhanced FLV 测试媒体，不包含第三方内容。

- 生成工具：FFmpeg `7.1.5-0+deb13u1`（使用 `libx265`，不要求 `libfdk`）
- 时长：3.018 秒
- 视频：HEVC Main，160x90，10 fps，固定 10 帧 GOP，单线程，无 scenecut
- 音频：AAC-LC，44.1 kHz，单声道，48 kbit/s
- 大小：53650 bytes
- SHA-256: `03d0cc20c1f2fb3c867a5c16ee5c662fb9450f3cda35d7ac7b06cc91f8b86e73`

在仓库根目录执行以下命令重新生成。命令有意让 FLV muxer 自行写入 codec tag，不要增加 `-tag:v hvc1`：

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'testsrc2=size=160x90:rate=10' \
  -f lavfi -i 'sine=frequency=1000:sample_rate=44100' \
  -t 3 \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx265 -profile:v main -pix_fmt yuv420p \
  -g 10 -keyint_min 10 -bf 0 -preset medium -threads:v 1 \
  -x265-params 'pools=none:frame-threads=1:wpp=0:keyint=10:min-keyint=10:scenecut=0:bframes=0:repeat-headers=0:log-level=error' \
  -c:a aac -profile:a aac_low -ar 44100 -ac 1 -b:a 48k -threads:a 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1 \
  -flvflags no_duration_filesize -f flv crates/transmux-fixtures/fixtures/hevc-aac.flv
```

`ffprobe` 必须报告 `format_name=flv`；HEVC 为 `profile=Main`、`width=160`、`height=90`、`r_frame_rate=10/1`；AAC 为 `profile=LC`、`sample_rate=44100`、`channels=1`。
