# Rivmux Transmux Fixtures

## `h264-aac.flv`

Repository-generated test media; it does not contain third-party content.

- Generator: FFmpeg `7.1.5-0+deb13u1`
- Duration: 2.99 seconds
- Video: H.264 Constrained Baseline, 320x240, 30 fps, no B-frames
- Audio: AAC-LC, 44.1 kHz, stereo, 64 kbit/s
- Size: 222370 bytes
- SHA-256: `2231083b1af0354efe4d6481ab49ca99e210446953db9cff6608b8dbde784ce8`

Regenerate from the repository root:

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

After regeneration, verify the recorded size and checksum before committing.
