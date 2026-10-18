//! Generates the Rust types in `bragi-model` from the bundled JSON Schema.
//!
//! Driven by `pnpm schemas:gen` (`packages/schemas/codegen/gen.mjs`); it is never run by hand and
//! its output (`crates/bragi-model/src/generated/mod.rs`) is never edited by hand
//! (`specs/13-agent-guide.md` §1). Everything in the schema becomes a type with the same name here
//! as in TypeScript and Python, which is the point of keeping the schemas in `packages/schemas`.
//!
//! Usage: `cargo run -p bragi-schemas-codegen -- <bundle.schema.json> <out.rs>`

use std::{env, error::Error, fs, path::Path};

use typify::{TypeSpace, TypeSpaceSettings};

/// Arguments: the bundled JSON Schema and the file to write the Rust source to.
fn main() -> Result<(), Box<dyn Error>> {
    const USAGE: &str = "usage: bragi-schemas-codegen <bundle.schema.json> <out.rs>";
    let mut args = env::args().skip(1);
    let input = args.next().ok_or(USAGE)?;
    let output = args.next().ok_or(USAGE)?;

    // The bundle is JSON Schema 2020-12; `schemars`' `RootSchema` reads `$defs` through an alias,
    // and typify walks every definition, so no type is left behind.
    let schema: schemars::schema::RootSchema = serde_json::from_str(&fs::read_to_string(input)?)?;

    let settings = TypeSpaceSettings::default();
    let mut types = TypeSpace::new(&settings);
    types.add_root_schema(schema)?;

    let file = syn::parse2::<syn::File>(types.to_stream())?;
    if let Some(parent) = Path::new(&output).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, prettyplease::unparse(&file))?;
    Ok(())
}
