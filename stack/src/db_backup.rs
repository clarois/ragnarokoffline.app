//! Back up database / Restore database: the characters and accounts of both
//! eras, in one `.sql` file. Settings and mods are "Back up everything"'s
//! (world.rs).
//!
//! The file is each era's dump one after the other, each beginning with its
//! own stamp (`-- Ragnarok Offline backup: app …, era …`, see
//! dump_migrations.rs), which is where restore splits it. A `.sql` with no
//! stamp -- every database backup from 1.4.3 and before -- is one database,
//! and restores into the era that is set now.
//!
//! The parts are only meaningful to this app: fed to `mariadb` by hand, the
//! second era's dump would replace the first, since both are the `ragnarok`
//! database of their own volume.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::cmds::StepLog;
use crate::config::Config;
use crate::docker::Docker;
use crate::dump_migrations::{read_stamp, STAMP};

/// One era's dump inside a database backup.
pub struct Section {
    /// The era its stamp names; `None` for an unstamped (pre-1.4.4) file.
    pub era: Option<String>,
    pub text: String,
}

/// Split a database backup into its eras' dumps, at the stamps. A stamp is
/// preceded by its dump's MariaDB sandbox line, which belongs to it.
pub fn sections(text: &str) -> Vec<Section> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let stamps: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.starts_with(STAMP)).map(|(i, _)| i).collect();
    if stamps.is_empty() {
        return vec![Section { era: None, text: text.to_string() }];
    }
    let starts: Vec<usize> = stamps
        .iter()
        .enumerate()
        .map(|(k, &i)| {
            if k == 0 {
                0
            } else if i > 0 && lines[i - 1].starts_with("/*M!999999") {
                i - 1
            } else {
                i
            }
        })
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(k, &from)| {
            let to = starts.get(k + 1).copied().unwrap_or(lines.len());
            let text: String = lines[from..to].concat();
            let era = read_stamp(&text).and_then(|s| s.era);
            Section { era, text }
        })
        .collect()
}

/// Every era's database, stamped, into one file.
pub fn backup(cfg: &Config, dk: &Docker, dest: &str) -> Result<(), String> {
    let mut log = StepLog::open(cfg, "backup");
    let era = crate::service_credentials::era(cfg);
    log.record(&format!(
        "backing up the databases to {dest}, made by Ragnarok Offline {}",
        cfg.app_version.as_deref().unwrap_or("(unknown version)")
    ));
    let result: Result<String, String> = (|| {
        crate::accounts::verify_era(cfg, dk, era)?;
        let scratch = crate::world::Scratch::new(cfg)?;
        log.record("stopping the game services");
        let dumps = crate::accounts::with_servers_stopped(cfg, dk, "backup", || crate::world::dump_all(cfg, dk, &scratch.0, era))?;
        crate::private_fs::export_with(Path::new(dest), |out| {
            for (_, path) in &dumps {
                let body = fs::read(path).map_err(|e| format!("reading the {} dump: {e}", path.display()))?;
                out.write_all(&body).and_then(|()| out.write_all(b"\n")).map_err(|e| format!("writing {dest}: {e}"))?;
            }
            Ok(())
        })?;
        let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let names: Vec<&str> = dumps.iter().map(|(e, _)| crate::world::era_name(e)).collect();
        Ok(format!("wrote {dest} ({}): the {} database{}", crate::cmds::human(size), names.join(" and "), if names.len() == 1 { "" } else { "s" }))
    })();
    match &result {
        Ok(line) => {
            log.record(&format!("done: {line}"));
            println!("{line}");
        }
        Err(e) => log.record(&format!("failed: {e}")),
    }
    result.map(|_| ()).map_err(|e| with_log(e, &log))
}

fn with_log(e: String, log: &StepLog) -> String {
    match &log.path {
        Some(path) => format!("{e}\n(Every step is in {}.)", path.display()),
        None => e,
    }
}

/// Read a database backup and say which era each part is for: its stamp, or
/// the era set now for an unstamped one. Two parts for one era is refused.
fn resolve(cfg: &Config, src: &Path) -> Result<Vec<(String, Section)>, String> {
    let bytes = fs::read(src).map_err(|e| format!("Could not read {}: {e}", src.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let current = crate::service_credentials::era(cfg);
    let mut out: Vec<(String, Section)> = Vec::new();
    for section in sections(&text) {
        let era = section.era.clone().unwrap_or_else(|| current.to_string());
        if out.iter().any(|(e, _)| *e == era) {
            return Err(format!("{} has the {} database twice, so it cannot be restored.", src.display(), crate::world::era_name(&era)));
        }
        out.push((era, section));
    }
    Ok(out)
}

/// What a database backup holds, as JSON, in the shape `inspect --full`
/// answers, for the Restore dialog. Nothing is stopped or changed.
pub fn inspect(cfg: &Config, src: &str) -> Result<(), String> {
    crate::cmds::check_dump(Path::new(src))?;
    let parts = resolve(cfg, Path::new(src))?;
    let q = |s: &str| crate::json::quote(s);
    let opt = |s: Option<&str>| s.map(q).unwrap_or_else(|| "null".into());
    let first = parts.iter().find_map(|(_, s)| read_stamp(&s.text));
    let databases: Vec<String> = parts
        .iter()
        .map(|(era, s)| {
            let (accounts, characters) = crate::world::players_and_characters(&s.text);
            format!(
                "{{\"era\": {}, \"accounts\": {accounts}, \"characters\": {characters}, \"stamped\": {}}}",
                q(era),
                s.era.is_some()
            )
        })
        .collect();
    println!(
        "{{\"kind\": \"databases\", \"app_version\": {}, \"created\": {}, \"packetver\": {}, \"databases\": [{}], \"settings\": false, \"mods\": [], \"running_era\": {}}}",
        opt(first.as_ref().and_then(|s| s.app.as_deref())),
        opt(first.as_ref().and_then(|s| s.made.as_deref())),
        opt(first.as_ref().and_then(|s| s.packetver.as_deref())),
        databases.join(", "),
        q(crate::service_credentials::era(cfg)),
    );
    Ok(())
}

/// Restore the chosen eras of a database backup -- every era it has, unless
/// `eras` names some -- each into its own database. The game is left stopped.
pub fn restore(cfg: &Config, dk: &Docker, src: &str, eras: Option<&[String]>) -> Result<(), String> {
    let mut log = StepLog::open(cfg, "restore");
    let result = restore_logged(cfg, dk, src, eras, &mut log);
    if let Err(e) = &result {
        log.record(&format!("failed: {e}"));
    }
    result.map_err(|e| with_log(e, &log))
}

fn restore_logged(cfg: &Config, dk: &Docker, src: &str, eras: Option<&[String]>, log: &mut StepLog) -> Result<(), String> {
    let current = crate::service_credentials::era(cfg);
    let dump = crate::cmds::check_dump(Path::new(src))?;
    log.say(&format!("restoring {src} ({})", crate::cmds::human(dump.size)));
    if let Some(note) = &dump.note {
        log.say(note);
    }
    let mut parts = resolve(cfg, Path::new(src))?;
    if let Some(wanted) = eras {
        if let Some(missing) = wanted.iter().find(|w| !parts.iter().any(|(e, _)| e == *w)) {
            return Err(format!("This backup has no {} database. Nothing was restored.", crate::world::era_name(missing)));
        }
        parts.retain(|(e, _)| wanted.iter().any(|w| w == e));
        if parts.is_empty() {
            return Err("Nothing was chosen to restore.".into());
        }
    }

    // Everything that could refuse is said while the game still runs.
    let private = cfg.state.join("private");
    crate::private_fs::directory(&private)?;
    let mut prepared = Vec::new();
    let cleanup = |prepared: &[(String, crate::dump_migrations::Prepared, std::path::PathBuf)]| {
        for (_, p, staged) in prepared {
            p.cleanup();
            let _ = fs::remove_file(staged);
        }
    };
    for (era, section) in &parts {
        if section.era.is_none() {
            log.say(&format!("the backup records no era, so it restores into the one set now: {}", crate::world::era_name(era)));
        }
        if era != current && !crate::cmds::era_volume_exists(dk, era) {
            cleanup(&prepared);
            return Err(format!(
                "This backup has a {} database, and this install has never run {}. Nothing was restored. \
                 Switch Settings → General → Game era to it and start the server once, then restore.",
                crate::world::era_name(era),
                crate::world::era_name(era)
            ));
        }
        let staged = private.join(format!("restore-{era}-{}.sql", crate::private_fs::random_hex(8)?));
        fs::write(&staged, &section.text).map_err(|e| format!("staging the backup: {e}"))?;
        crate::private_fs::protect(&staged, false)?;
        let info = match crate::cmds::check_dump(&staged) {
            Ok(info) => info,
            Err(e) => {
                let _ = fs::remove_file(&staged);
                cleanup(&prepared);
                return Err(format!("The {} part of the backup: {e}", crate::world::era_name(era)));
            }
        };
        let p = crate::dump_migrations::prepare(cfg, &staged)?;
        log.say(&format!("{} database ({} tables): {}", crate::world::era_name(era), info.tables.len(), p.describe_version()));
        prepared.push((era.clone(), p, staged));
    }

    let result: Result<(), String> = (|| {
        crate::accounts::verify_era(cfg, dk, current)?;
        log.say("stopping the game services");
        crate::cmds::stop_game(cfg, dk)?;
        let backups = cfg.state.join("backups");
        crate::private_fs::directory(&backups)?;
        for (era, p, _) in &prepared {
            let name = crate::world::era_name(era);
            let safety = backups.join(format!("before-restore-{era}-{}.sql", crate::private_fs::random_hex(8)?));
            log.say(&format!("backing up the {name} database as it is now, first"));
            crate::cmds::with_era_database(cfg, dk, era, || {
                crate::cmds::backup_snapshot(cfg, dk, &safety.to_string_lossy(), false)
            })
            .map_err(|e| format!("Nothing more was restored: the backup of the {name} database taken first failed: {e}"))?;
            log.say(&format!("saved it as {}", safety.display()));
            for done in &p.done {
                log.say(&format!("{name} database, migrated: {done}"));
            }
            log.say(&format!("loading the {name} database"));
            crate::cmds::with_era_database(cfg, dk, era, || {
                crate::cmds::load_dump(cfg, dk, &p.load)?;
                crate::cmds::adopt_loaded_dump(cfg, dk, era)
            })
            .map_err(|e| {
                format!(
                    "Restoring the {name} database failed: {e}\nIt may be partly restored. Game services are stopped. \
                     To put it back as it was before, restore {}.",
                    safety.display()
                )
            })?;
            log.say(&format!("{name} database restored"));
        }
        Ok(())
    })();
    cleanup(&prepared);
    result?;
    let names: Vec<&str> = prepared.iter().map(|(e, _, _)| crate::world::era_name(e)).collect();
    log.say("done");
    println!(
        "restored the {} database{} from {src}; game services are stopped. Restart the server to reconnect. A backup of what was there before was kept.",
        names.join(" and "),
        if names.len() == 1 { "" } else { "s" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(era: &str, who: &str) -> String {
        format!(
            "/*M!999999\\- enable the sandbox mode */\n{STAMP}app 1.4.4, era {era}, packetver 20221005, made 2026-10-02T20:00:00Z\n\
             -- MariaDB dump\nCREATE TABLE `char` (\n  `char_id` int\n);\nINSERT INTO `char` VALUES\n(150000,'{who}');\n-- Dump completed on 2026-10-02\n"
        )
    }

    /// Two eras in one file come apart at their stamps, each with its own
    /// sandbox line; a file with no stamp is one part, for the era set now.
    #[test]
    fn a_database_backup_splits_into_its_eras() {
        let both = format!("{}\n{}\n", dump("renewal", "Re"), dump("prerenewal", "Pre"));
        let parts = sections(&both);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].era.as_deref(), Some("renewal"));
        assert_eq!(parts[1].era.as_deref(), Some("prerenewal"));
        assert!(parts[0].text.starts_with("/*M!999999") && parts[0].text.contains("'Re'") && !parts[0].text.contains("'Pre'"));
        assert!(parts[1].text.starts_with("/*M!999999") && parts[1].text.contains("'Pre'"));
        assert_eq!(parts.iter().map(|p| p.text.len()).sum::<usize>(), both.len(), "nothing is lost between them");

        let old = "-- MariaDB dump\nCREATE TABLE `char` (\n `char_id` int\n);\n";
        let parts = sections(old);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].era, None);
        assert_eq!(parts[0].text, old);
    }
}
