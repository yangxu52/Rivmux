//! Serde helpers shared by event, sample, and codec types.
//!
//! The WASM adapter serializes events with `serde-wasm-bindgen`, whose default
//! `Serializer` turns `Vec<u8>` into a plain JavaScript array (`seq`), i.e. one
//! JS number per byte. Routing byte payloads through `serialize_bytes` makes the
//! boundary produce a `Uint8Array` instead, which the runtime already accepts.

pub(crate) mod bytes {
    use serde::Serializer;

    /// Serializes a byte payload as `serialize_bytes` so the WASM boundary
    /// yields a `Uint8Array` rather than a numeric JavaScript array.
    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(value)
    }
}

#[cfg(test)]
mod tests {
    use crate::codec::aac::AacConfig;
    use crate::codec::avc::AvcConfig;
    use crate::codec::{AudioCodecConfig, VideoCodecConfig};
    use crate::event::{CoreEvent, InitSegment, MediaSegment, TrackKind};
    use crate::metadata::MetadataEvent;
    use crate::sample::{EncodedSample, SampleTiming};
    use crate::track::TrackId;
    use serde::Serialize;
    use serde::ser::{self, Impossible, Serializer};
    use std::fmt::Display;

    /// Counts `serialize_bytes` calls and fails when a byte payload is emitted
    /// through `serialize_seq`. `serde-wasm-bindgen` maps the former to
    /// `Uint8Array` and the latter to a numeric JavaScript array.
    #[derive(Default)]
    struct ByteShapeProbe {
        bytes_calls: usize,
    }

    #[derive(Debug)]
    struct BytesLeakedThroughSeq;

    impl Display for BytesLeakedThroughSeq {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a byte payload was serialized as a sequence")
        }
    }

    impl std::error::Error for BytesLeakedThroughSeq {}

    impl ser::Error for BytesLeakedThroughSeq {
        fn custom<T: Display>(_: T) -> Self {
            Self
        }
    }

    impl Serializer for &mut ByteShapeProbe {
        type Ok = ();
        type Error = BytesLeakedThroughSeq;
        type SerializeSeq = Impossible<(), BytesLeakedThroughSeq>;
        type SerializeTuple = Impossible<(), BytesLeakedThroughSeq>;
        type SerializeTupleStruct = Impossible<(), BytesLeakedThroughSeq>;
        type SerializeTupleVariant = Impossible<(), BytesLeakedThroughSeq>;
        type SerializeMap = Impossible<(), BytesLeakedThroughSeq>;
        type SerializeStruct = Self;
        type SerializeStructVariant = Self;

        fn serialize_bytes(self, _: &[u8]) -> Result<Self::Ok, Self::Error> {
            self.bytes_calls += 1;
            Ok(())
        }

        fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
            Err(BytesLeakedThroughSeq)
        }

        fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }

        fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Self::Ok, Self::Error> {
            value.serialize(self)
        }

        fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }

        fn serialize_unit_struct(self, _: &'static str) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }

        fn serialize_unit_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
        ) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }

        fn serialize_newtype_struct<T: ?Sized + Serialize>(
            self,
            _: &'static str,
            value: &T,
        ) -> Result<Self::Ok, Self::Error> {
            value.serialize(self)
        }

        fn serialize_newtype_variant<T: ?Sized + Serialize>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            value: &T,
        ) -> Result<Self::Ok, Self::Error> {
            value.serialize(self)
        }

        fn serialize_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStruct, Self::Error> {
            Ok(self)
        }

        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStructVariant, Self::Error> {
            Ok(self)
        }

        fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Self::Error> {
            Err(BytesLeakedThroughSeq)
        }
        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleStruct, Self::Error> {
            Err(BytesLeakedThroughSeq)
        }
        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleVariant, Self::Error> {
            Err(BytesLeakedThroughSeq)
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
            Err(BytesLeakedThroughSeq)
        }

        fn serialize_bool(self, _: bool) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_i8(self, _: i8) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_i16(self, _: i16) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_i32(self, _: i32) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_i64(self, _: i64) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_u8(self, _: u8) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_u16(self, _: u16) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_u32(self, _: u32) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_u64(self, _: u64) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_f32(self, _: f32) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_f64(self, _: f64) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_char(self, _: char) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
        fn serialize_str(self, _: &str) -> Result<Self::Ok, Self::Error> {
            Ok(())
        }
    }

    impl ser::SerializeStruct for &mut ByteShapeProbe {
        type Ok = ();
        type Error = BytesLeakedThroughSeq;
        fn serialize_field<T: ?Sized + Serialize>(
            &mut self,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(&mut **self)
        }
        fn end(self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    impl ser::SerializeStructVariant for &mut ByteShapeProbe {
        type Ok = ();
        type Error = BytesLeakedThroughSeq;
        fn serialize_field<T: ?Sized + Serialize>(
            &mut self,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(&mut **self)
        }
        fn end(self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    fn assert_byte_payload<T: Serialize>(value: &T, expected_bytes: usize) {
        let mut probe = ByteShapeProbe::default();
        match value.serialize(&mut probe) {
            Ok(()) => assert_eq!(
                probe.bytes_calls, expected_bytes,
                "byte payload must use serialize_bytes so the WASM boundary emits Uint8Array",
            ),
            Err(_) => panic!("byte payload was serialized as a sequence (numeric JS array)"),
        }
    }

    #[test]
    fn init_and_media_segment_bytes_use_serialize_bytes() {
        assert_byte_payload(
            &CoreEvent::InitSegment(InitSegment {
                track: TrackKind::Video,
                codec: "avc1.42E01E".to_string(),
                timescale: 1_000,
                bytes: vec![1, 2, 3],
            }),
            1,
        );
        assert_byte_payload(
            &CoreEvent::MediaSegment(MediaSegment {
                track: TrackKind::Video,
                dts_start_ms: 0,
                dts_end_ms: 33,
                keyframe: true,
                bytes: vec![1, 2, 3],
            }),
            1,
        );
    }

    #[test]
    fn sample_and_metadata_bytes_use_serialize_bytes() {
        assert_byte_payload(
            &CoreEvent::Sample(EncodedSample::Video {
                track_id: TrackId::VIDEO,
                timing: SampleTiming { dts: 0, pts: 0 },
                duration: Some(33),
                is_sync: true,
                data: vec![1, 2, 3],
            }),
            1,
        );
        assert_byte_payload(
            &CoreEvent::Sample(EncodedSample::Audio {
                track_id: TrackId::AUDIO,
                timing: SampleTiming { dts: 0, pts: 0 },
                duration: 1024,
                data: vec![1, 2, 3],
            }),
            1,
        );
        assert_byte_payload(
            &CoreEvent::Metadata(MetadataEvent::FlvScriptData {
                timestamp_ms: 0,
                bytes: vec![1, 2, 3],
            }),
            1,
        );
    }

    #[test]
    fn codec_configuration_bytes_use_serialize_bytes() {
        assert_byte_payload(
            &VideoCodecConfig::Avc(AvcConfig {
                codec_string: "avc1.42E01E".to_string(),
                width: Some(320),
                height: Some(240),
                nal_length_size: 4,
                avcc: vec![1, 2, 3],
            }),
            1,
        );
        assert_byte_payload(
            &AudioCodecConfig::Aac(AacConfig {
                codec_string: "mp4a.40.2".to_string(),
                object_type: 2,
                sample_rate: 44_100,
                channel_count: 2,
                audio_specific_config: vec![1, 2, 3],
            }),
            1,
        );
    }
}
