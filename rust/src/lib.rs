//! Your team's current Azure DevOps sprint in a sidebar: items by state with their tasks, details and comments, and board
//! checks with a proposed fix for each. Read-only.
//!
//! The crate builds two frames. The main script (`--features main`, `main_frame.rs`) reads the board in the background,
//! keeps its state for the sidebar, sets the title bar label and answers Claude's `board_check` tool. The sidebar
//! (`--features sidebar`, `sidebar/`) draws the board and an item, runs `az` itself for what the board doesn't have, and
//! walks you through the settings.

// Each frame uses its own part of the crate.
#![allow(dead_code)]

mod az;
mod check;
mod html;
#[cfg(feature = "main")]
mod main_frame;
mod markdown;
#[cfg(feature = "sidebar")]
mod sidebar;
mod settings;
mod state;
#[cfg(test)]
mod testing;
