//! Helpers shared by tests.

use std::path::PathBuf;

/// A program from `examples/` (fake agent, fake docker CLI), built by plain `cargo test`.
///
/// Examples are built into target/<profile>/examples. The test binary is somewhere below
/// target/<profile> – in deps/ up to Cargo 1.99, in build/<package>/<hash>/out/ with the
/// build-dir layout of 1.100 – so the nearest ancestor with the example wins.
pub fn example(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().unwrap();
    let found = exe
        .ancestors()
        .skip(1)
        .map(|dir| dir.join("examples").join(&file))
        .find(|p| p.exists());
    found.unwrap_or_else(|| {
        panic!(
            "{file} is missing next to {}: plain `cargo test` builds it; with a test name filter or `--lib`, run `cargo build --example {name}` first",
            exe.display()
        )
    })
}
