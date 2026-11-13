//! What main keeps in `wings.storage` for the sidebar: the state of the check and the board of the last one. Main writes
//! them and tells the sidebar, which reads them, so the board is read once however many pages show it.

use crate::{
    check::{Report, Snapshot},
    settings::Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wings_plugin::settings::Setting;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Loading,
    Setup,
    SignedOut,
    Error,
    Ready,
}

/// What main knows: the phase, the settings and the last check without its board, which has its own key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Published {
    pub phase: Phase,
    pub settings: Settings,
    pub missing: Vec<String>,
    pub result: Option<Report>,
    pub error: Option<String>,
    pub running: bool,
}

/// The sidebar asks main for the board to be read again.
pub const REFRESH: &str = "refresh";

pub fn published() -> Setting<Option<Published>> {
    Setting::new("state", None, |stored| serde_json::from_value(stored.clone()).ok().map(Some), |state| serde_json::to_value(state).unwrap_or(Value::Null))
}

/// The board of the last check, kept for the next start: it shows while the first check runs.
pub fn board() -> Setting<Option<Snapshot>> {
    Setting::new("board", None, |stored| serde_json::from_value(stored.clone()).ok().map(Some), |board| serde_json::to_value(board).unwrap_or(Value::Null))
}
