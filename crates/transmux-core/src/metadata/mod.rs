#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataEvent {
    FlvScriptData { timestamp_ms: i64, bytes: Vec<u8> },
}
