use std::time::Instant;

pub(crate) struct StateSyncTiming {
    pub session: String,
    pub page: u64,
    pub pages: u64,
    pub compartments: usize,
    pub tags: usize,
    pub bytes: usize,
    pub decode_ms: f64,
    pub stage_page_ms: f64,
    pub assemble_series_ms: f64,
    pub import_ms: f64,
    pub ack_started: Option<Instant>,
}

impl Drop for StateSyncTiming {
    fn drop(&mut self) {
        let ack_ms = self
            .ack_started
            .map_or(0.0, |start| start.elapsed().as_secs_f64() * 1000.0);
        tracing::info!(target: "perf", "mc-state-sync-timing side=module session={} page={} pages={} compartments={} tags={} bytes={} decode_ms={:.3} stage_page_ms={:.3} assemble_series_ms={:.3} import_ms={:.3} ack_ms={:.3}", self.session, self.page, self.pages, self.compartments, self.tags, self.bytes, self.decode_ms, self.stage_page_ms, self.assemble_series_ms, self.import_ms, ack_ms);
    }
}
