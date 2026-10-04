//! Database backups across app versions.
//!
//! Every `.sql` the app writes is stamped with the version that made it, in a
//! comment near the top:
//!
//! ```text
//! -- Ragnarok Offline backup: app 1.4.4, era renewal, packetver 20221005, made 2026-10-02T19:38:22Z
//! ```
//!
//! - `app`: the version that made it, which decides the migrations it gets;
//! - `era`: whose database it is, so a pre-renewal backup is never loaded into
//!   the renewal database or the other way round;
//! - `packetver`: the client version the server ran for it -- not needed to
//!   load it, but the first thing to ask about a world that misbehaves after;
//! - `made`: when, in UTC.
//!
//! `key value` pairs, comma separated, so a later version can add one and an
//! older reader skips what it does not know. A comment, so the dump stays a
//! plain MariaDB dump that any client loads. Backups made before 1.4.4 have no
//! stamp; they are read as "older than the first migration that needs to know".
//!
//! Before a backup is restored, `prepare` reads the stamp and runs every
//! migration whose `since` is newer than the backup, in order, over the dump's
//! text. Each turns something an older app wrote into what this one expects,
//! and says what it did, which the restore prints and logs.
//!
//! ## Adding a migration
//!
//! When a release changes what a backup must contain to load correctly --
//! a table the app now relies on, a column it renamed, rows it now writes
//! differently -- add an entry to `MIGRATIONS`, at the end:
//!
//! - `since`: the first app version whose backups no longer need the change.
//!   A backup stamped at or after it is left alone.
//! - `what`: one line for the restore log.
//! - `apply`: the change, given the whole dump. Return `None` when there was
//!   nothing to do. It also runs on unstamped backups, so it must check the
//!   text rather than trust the version alone, and be harmless on a dump that
//!   is already right.
//!
//! The SQL a migration adds goes at the end of the dump, where the dump's own
//! `USE ragnarok` is in effect and every table it creates exists.

use std::fs;
use std::path::{Path, PathBuf};

use crate::config::Config;

/// How the stamp line starts. Read back by `read_stamp`.
pub const STAMP: &str = "-- Ragnarok Offline backup: ";

/// What a backup says about itself. Every field is optional: a stamp from a
/// later version may lack one this reads, and a backup from before 1.4.4 has
/// none at all.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct BackupStamp {
    pub app: Option<String>,
    pub era: Option<String>,
    pub packetver: Option<String>,
    pub made: Option<String>,
}

/// The line written into each backup.
///
/// The era is the one of the database that is *open*, which is not always the
/// running one: "Back up everything" dumps the other era too, by opening its
/// volume (`with_era_database`), which records it in `.db-volume`.
pub fn stamp_line(cfg: &Config) -> String {
    let version = cfg.app_version.as_deref().unwrap_or("unknown");
    let era = match fs::read_to_string(cfg.state.join(".db-volume")).unwrap_or_default().trim() {
        "ragnarokmac-db-prere" => "prerenewal",
        "ragnarokmac-db" => "renewal",
        _ => crate::service_credentials::era(cfg),
    };
    let packetver = crate::packetver::chosen(cfg).unwrap_or("unknown");
    let made = crate::world::rfc3339(std::time::SystemTime::now());
    format!("{STAMP}app {version}, era {era}, packetver {packetver}, made {made}\n")
}

/// The stamp near the top of a dump, if it has one.
pub fn read_stamp(text: &str) -> Option<BackupStamp> {
    let rest = text.lines().take(20).find_map(|l| l.strip_prefix(STAMP))?;
    let mut stamp = BackupStamp::default();
    for pair in rest.split(',') {
        let Some((key, value)) = pair.trim().split_once(' ') else { continue };
        let value = value.trim();
        if value.is_empty() || value == "unknown" {
            continue;
        }
        let slot = match key {
            "app" => &mut stamp.app,
            "era" => &mut stamp.era,
            "packetver" => &mut stamp.packetver,
            "made" => &mut stamp.made,
            _ => continue,
        };
        *slot = Some(value.to_string());
    }
    Some(stamp)
}

/// Put the stamp into a dump file, in place.
///
/// After the first line when that is MariaDB's sandbox marker
/// (`/*M!999999\- enable the sandbox mode */`), which the client reads as a
/// command and is written first by mariadb-dump; at the top otherwise. A dump
/// that already carries a stamp is left as it is.
pub fn stamp_file(path: &Path, line: &str) -> Result<(), String> {
    let body = fs::read(path).map_err(|e| format!("reading {} to stamp it: {e}", path.display()))?;
    if read_stamp(&String::from_utf8_lossy(&body[..body.len().min(4096)])).is_some() {
        return Ok(());
    }
    let at = if body.starts_with(b"/*M!999999") {
        body.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(body.len())
    } else {
        0
    };
    let mut out = Vec::with_capacity(body.len() + line.len());
    out.extend_from_slice(&body[..at]);
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(&body[at..]);
    fs::write(path, out).map_err(|e| format!("stamping {}: {e}", path.display()))
}

pub struct Migration {
    pub since: &'static str,
    pub what: &'static str,
    pub apply: fn(&str) -> Option<String>,
}

/// In order of `since`. See the module comment before adding one.
pub const MIGRATIONS: &[Migration] = &[Migration {
    since: "1.4.0",
    what: "cleared the sign-in tables, which backups from before 1.4 do not have",
    apply: clear_missing_session_tables,
}];

/// Tables the app keeps in the game database and recreates, empty, on every
/// start, which hold sign-ins for particular account ids.
pub const SESSION_TABLES: [&str; 3] = ["login_tokens", "app_sign_in_identities", "app_remembered_logins"];

/// A dump drops and recreates only the tables it has. Without these, the
/// previous world's sign-ins would stay, pointing at whoever has those account
/// ids in the restored one.
fn clear_missing_session_tables(dump: &str) -> Option<String> {
    let missing: Vec<&str> = SESSION_TABLES
        .into_iter()
        .filter(|t| !dump.contains(&format!("CREATE TABLE `{t}` (")))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = dump.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n-- Added by Ragnarok Offline when restoring: sign-in tables this backup does not have.\n");
    for t in missing {
        out.push_str(&format!("DROP TABLE IF EXISTS `{t}`;\n"));
    }
    Some(out)
}

/// Every migration a backup made by `version` needs, applied in order.
/// Returns the new text, if anything changed, and what was done.
pub fn migrate(dump: &str, version: Option<&str>) -> (Option<String>, Vec<String>) {
    let mut text: Option<String> = None;
    let mut done = Vec::new();
    for m in MIGRATIONS {
        let needed = match version {
            Some(v) => crate::mods::compare_versions(v, m.since) == std::cmp::Ordering::Less,
            None => true,
        };
        if !needed {
            continue;
        }
        if let Some(changed) = (m.apply)(text.as_deref().unwrap_or(dump)) {
            text = Some(changed);
            done.push(format!("{} (for backups before {})", m.what, m.since));
        }
    }
    (text, done)
}

/// What a backup is, and the file to load for it: the backup itself, or a
/// migrated copy under `state/private` that the caller removes.
pub struct Prepared {
    pub load: PathBuf,
    pub temporary: bool,
    pub version: Option<String>,
    pub stamp: Option<BackupStamp>,
    pub done: Vec<String>,
}

impl Prepared {
    pub fn describe_version(&self) -> String {
        let Some(stamp) = &self.stamp else {
            return "made before 1.4.4 (no version recorded)".into();
        };
        let mut out = match &self.version {
            Some(v) => format!("made by Ragnarok Offline {v}"),
            None => "made by an unknown version".into(),
        };
        if let Some(era) = &stamp.era {
            out.push_str(&format!(", {} database", era_words(era)));
        }
        if let Some(p) = &stamp.packetver {
            out.push_str(&format!(", client version {p}"));
        }
        if let Some(made) = &stamp.made {
            out.push_str(&format!(", on {made}"));
        }
        out
    }

    /// Refuse a backup of the other era: the tables are the same, so it would
    /// load, and the world would then be wrong in ways nobody would trace back
    /// to the restore.
    pub fn check_era(&self, into: &str) -> Result<(), String> {
        match self.stamp.as_ref().and_then(|s| s.era.as_deref()) {
            Some(era) if era != into => Err(format!(
                "This is a backup of the {} database, and the {} one is running. Nothing was changed. \
                 Switch Settings → General → Game era to {}, then restore it.",
                era_words(era),
                era_words(into),
                if era == "prerenewal" { "Pre-renewal" } else { "Renewal" }
            )),
            _ => Ok(()),
        }
    }

    pub fn cleanup(&self) {
        if self.temporary {
            let _ = fs::remove_file(&self.load);
        }
    }
}

pub fn prepare(cfg: &Config, src: &Path) -> Result<Prepared, String> {
    let bytes = fs::read(src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let stamp = read_stamp(&text);
    let version = stamp.as_ref().and_then(|s| s.app.clone());
    let (migrated, done) = migrate(&text, version.as_deref());
    let Some(migrated) = migrated else {
        return Ok(Prepared { load: src.to_path_buf(), temporary: false, version, stamp, done });
    };
    let private = cfg.state.join("private");
    crate::private_fs::directory(&private)?;
    let load = private.join(format!("migrated-{}.sql", crate::private_fs::random_hex(12)?));
    fs::write(&load, migrated).map_err(|e| format!("writing the migrated backup: {e}"))?;
    crate::private_fs::protect(&load, false)?;
    Ok(Prepared { load, temporary: true, version, stamp, done })
}

fn era_words(era: &str) -> &'static str {
    if era == "prerenewal" { "pre-renewal" } else { "renewal" }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "/*M!999999\\- enable the sandbox mode */\n-- MariaDB dump 10.19\nUSE `ragnarok`;\n\
        CREATE TABLE `char` (\n  `char_id` int\n);\nCREATE TABLE `login` (\n  `account_id` int\n);\n-- Dump completed on 2026-10-02\n";

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ro-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The stamp goes after MariaDB's sandbox marker, which has to stay the
    /// first line, and reads back as the version; stamping twice is once.
    #[test]
    fn a_backup_is_stamped_once_and_reads_back() {
        let f = tmp("stamp").join("b.sql");
        fs::write(&f, DUMP).unwrap();
        let line = format!("{STAMP}app 1.4.4, era prerenewal, packetver 20221005, made 2026-10-02T19:38:22Z\n");
        stamp_file(&f, &line).unwrap();
        stamp_file(&f, &line).unwrap();
        let body = fs::read_to_string(&f).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert!(lines[0].starts_with("/*M!999999"));
        assert_eq!(lines[1], "-- Ragnarok Offline backup: app 1.4.4, era prerenewal, packetver 20221005, made 2026-10-02T19:38:22Z");
        assert_eq!(body.matches(STAMP).count(), 1);
        assert_eq!(
            read_stamp(&body),
            Some(BackupStamp {
                app: Some("1.4.4".into()),
                era: Some("prerenewal".into()),
                packetver: Some("20221005".into()),
                made: Some("2026-10-02T19:38:22Z".into()),
            })
        );
        // A later version's extra keys are skipped; a missing one is None.
        let later = read_stamp(&format!("{STAMP}app 1.6.0, era renewal, shards 3\n")).unwrap();
        assert_eq!((later.app.as_deref(), later.era.as_deref(), later.packetver), (Some("1.6.0"), Some("renewal"), None));

        let plain = tmp("stamp-plain").join("b.sql");
        fs::write(&plain, "-- MariaDB dump\nUSE `ragnarok`;\n").unwrap();
        stamp_file(&plain, &line).unwrap();
        assert!(fs::read_to_string(&plain).unwrap().starts_with(STAMP));
        assert_eq!(read_stamp(DUMP), None);
        assert_eq!(read_stamp(&format!("{STAMP}app unknown, era renewal\n")).unwrap().app, None);
    }

    /// An unstamped or older backup gets the sign-in tables cleared; one
    /// stamped at or after 1.4.0, or that has the tables, is left alone.
    #[test]
    fn migrations_run_for_older_and_unstamped_backups_only() {
        let (text, done) = migrate(DUMP, None);
        let text = text.expect("an unstamped pre-1.4 dump is migrated");
        for t in SESSION_TABLES {
            assert!(text.contains(&format!("DROP TABLE IF EXISTS `{t}`;")), "{t}");
        }
        assert_eq!(done.len(), 1);
        assert!(done[0].contains("before 1.4.0"), "{done:?}");

        assert!(migrate(DUMP, Some("1.3.9")).0.is_some());
        assert_eq!(migrate(DUMP, Some("1.4.0")), (None, vec![]));
        assert_eq!(migrate(DUMP, Some("1.4.4")), (None, vec![]));

        let with_tables = SESSION_TABLES
            .iter()
            .fold(DUMP.to_string(), |d, t| d + &format!("CREATE TABLE `{t}` (\n  `x` int\n);\n"));
        assert_eq!(migrate(&with_tables, None), (None, vec![]));
    }

    /// A backup of one era is never loaded into the other; one without a
    /// stamp cannot say, and is let through.
    #[test]
    fn a_backup_of_the_other_era_is_refused() {
        let prepared = |era: Option<&str>| Prepared {
            load: PathBuf::new(),
            temporary: false,
            version: Some("1.4.4".into()),
            stamp: Some(BackupStamp { era: era.map(String::from), ..BackupStamp::default() }),
            done: vec![],
        };
        assert!(prepared(Some("renewal")).check_era("renewal").is_ok());
        let e = prepared(Some("prerenewal")).check_era("renewal").unwrap_err();
        assert!(e.contains("pre-renewal database") && e.contains("Nothing was changed"), "{e}");
        assert!(prepared(None).check_era("renewal").is_ok());
        let unstamped = Prepared { stamp: None, version: None, ..prepared(None) };
        assert!(unstamped.check_era("prerenewal").is_ok());
        assert_eq!(unstamped.describe_version(), "made before 1.4.4 (no version recorded)");
    }

    /// Every migration names a version, and they are in order of it.
    #[test]
    fn migrations_are_in_version_order() {
        for pair in MIGRATIONS.windows(2) {
            assert_ne!(crate::mods::compare_versions(pair[0].since, pair[1].since), std::cmp::Ordering::Greater);
        }
        assert!(MIGRATIONS.iter().all(|m| !m.what.is_empty() && m.since.split('.').count() == 3));
    }
}
