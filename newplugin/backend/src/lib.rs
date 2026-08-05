//! Codeg Layer-2 plugin backend (`newplugin`).
//!
//! Layer-1 core (`src-tauri`) performs I/O and execution; this crate owns the
//! *decisions* for new functionality, as plain, dependency-free logic that core
//! calls with plain data. Nothing here may depend on the `codeg` crate — core
//! is the adapter that fetches rows and applies the returned decision.

pub mod launch_target;
pub mod target_kind;
