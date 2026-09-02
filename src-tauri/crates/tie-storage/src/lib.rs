//! Optional facade over Tie storage backends.
//!
//! Enable `local` and/or `s3` features to re-export the corresponding crates.

pub use tie_common::*;

#[cfg(feature = "local")]
pub use tie_local as local;

#[cfg(feature = "s3")]
pub use tie_s3 as s3;
