#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "type", content = "data", rename_all = "camelCase")
)]
pub enum MetadataEvent {
    FlvScriptData {
        timestamp_ms: i64,
        #[cfg_attr(
            feature = "serde",
            serde(serialize_with = "crate::serde_util::bytes::serialize")
        )]
        bytes: Vec<u8>,
    },
}
