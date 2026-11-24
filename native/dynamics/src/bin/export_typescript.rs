use std::{env, fs, path::PathBuf, process::ExitCode};

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() > 1 || args.first().is_some_and(|arg| arg != "--check") {
        return Err("Usage: export-typescript [--check]".into());
    }
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/native-contract.gen.ts");
    let expected = batalha_dynamics::typescript_contract();
    if args.is_empty() {
        fs::write(&file, expected).map_err(|error| error.to_string())?;
        println!("Generated {}", file.display());
    } else {
        let actual = fs::read_to_string(&file).map_err(|error| error.to_string())?;
        if actual.replace("\r\n", "\n") != expected {
            return Err(
                "Native host types are out of date. Run npm run generate:native-contract.".into(),
            );
        }
        println!("Native host types match the Rust DTOs.");
    }
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
