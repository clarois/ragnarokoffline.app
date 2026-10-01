//! `ragnarok-stack export-table <name>`: one of the server's tables as the
//! running server sees it, for the tools in Settings -> Tools (#195).
//!
//! The base table is read out of the map container (it lives in the image),
//! and the mods' `db/import` copy (state/modbuild/db, which is what the
//! container mounts there) is laid over it the way rAthena does: an entry
//! whose `Id` already exists has the fields it names replaced, and a new `Id`
//! is added. So a mod's monster or item shows up in the tools, and a mod's
//! change to a stock one does too.
//!
//! Field-level at the top of each entry, except the two drop lists, which
//! rAthena merges entry by entry (MobDatabase::parseDropNode): an entry with
//! `Index: n` overwrites slot n (or adds it, if n is the next slot), one
//! without is appended while there is room. The result is written back as a
//! plain list, the way the base tables spell it, so a tool reading `- Item:`
//! entries sees every drop.

use crate::config::Config;
use crate::docker::Docker;
use std::fs;

/// The tables a tool may ask for: names, not paths, so nothing else in the
/// container can be read through this.
pub const TABLES: &[&str] = &["mob_db", "item_db_equip", "item_db_etc", "item_db_usable"];

pub fn export_table(cfg: &Config, dk: &Docker, name: &str) -> Result<String, String> {
    if !TABLES.contains(&name) {
        return Err(format!("unknown table {name}; one of {}", TABLES.join(", ")));
    }
    let era = if crate::cmds::is_prerenewal(cfg) { "pre-re" } else { "re" };
    // Copied out rather than `exec cat`: the bundled engine's exec does not
    // hand back a non-interactive command's output.
    let staged = cfg.state.join(format!(".export-{name}-{}.yml", std::process::id()));
    let copied = dk.copy_out("ragnarok-map", &format!("/rathena/db/{era}/{name}.yml"), &staged);
    let base = copied.and_then(|_| fs::read_to_string(&staged).map_err(|e| e.to_string()));
    let _ = fs::remove_file(&staged);
    let base = base.map_err(|e| {
        if dk.state("ragnarok-map").as_deref() == Some("running") {
            format!("Could not read the server's {name}: {e}")
        } else {
            "The game server is not running. Press Play in Ragnarok Offline, then try again.".to_string()
        }
    })?;
    let import = fs::read_to_string(cfg.state.join("modbuild").join("db").join(format!("{name}.yml"))).ok();
    Ok(match import {
        Some(overlay) => overlay_entries(&base, &overlay),
        None => base,
    })
}

/// One `  - Id: N` entry: its first line, then (key, lines) blocks for each
/// top-level field, in order.
struct Entry {
    id: Option<String>,
    head: String,
    fields: Vec<(String, Vec<String>)>,
}

/// Split an rAthena YAML table into what comes before its entries, the
/// entries, and what comes after them (the `Footer:`).
fn split(text: &str) -> (Vec<String>, Vec<Entry>, Vec<String>) {
    let mut head = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    let mut foot = Vec::new();
    let mut in_body = false;
    let mut in_foot = false;
    for line in text.lines() {
        if in_foot {
            foot.push(line.to_string());
            continue;
        }
        if !in_body {
            head.push(line.to_string());
            if line.trim_end() == "Body:" {
                in_body = true;
            }
            continue;
        }
        if !line.starts_with(' ') && !line.trim().is_empty() && !line.starts_with('#') {
            // A top-level key after the body: the footer and everything below.
            in_foot = true;
            foot.push(line.to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("  - ") {
            let id = rest.strip_prefix("Id:").map(|v| v.trim().to_string());
            entries.push(Entry { id, head: line.to_string(), fields: Vec::new() });
            continue;
        }
        let Some(entry) = entries.last_mut() else {
            head.push(line.to_string());
            continue;
        };
        let is_field = line.starts_with("    ")
            && !line.starts_with("     ")
            && line.trim_start().split_once(':').is_some()
            && !line.trim_start().starts_with('-')
            && !line.trim_start().starts_with('#');
        if is_field {
            let key = line.trim_start().split(':').next().unwrap_or("").to_string();
            entry.fields.push((key, vec![line.to_string()]));
        } else if let Some((_, lines)) = entry.fields.last_mut() {
            lines.push(line.to_string());
        } else {
            // A comment or blank line straight after the entry's first line.
            entry.fields.push((String::new(), vec![line.to_string()]));
        }
    }
    (head, entries, foot)
}

/// rAthena's limits on a monster's drop lists (src/map/mob.hpp).
const MAX_MOB_DROP: usize = 10;
const MAX_MVP_DROP: usize = 3;

/// The entries of a drop list block (its `    Drops:` line first), each as its
/// `Key: value` lines, comments and blank lines left out.
fn drop_items(block: &[String]) -> Vec<Vec<String>> {
    let mut items: Vec<Vec<String>> = Vec::new();
    for line in block.iter().skip(1) {
        let t = line.trim_start();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(first) = t.strip_prefix("- ") {
            items.push(vec![first.trim_end().to_string()]);
        } else if let Some(item) = items.last_mut() {
            item.push(t.trim_end().to_string());
        }
    }
    items
}

/// rAthena's merge of one drop list over another, written back plainly.
fn merge_drops(base: &[String], overlay: &[String], max: usize) -> Vec<String> {
    let header = base.first().cloned().unwrap_or_else(|| "    Drops:".to_string());
    let mut drops = drop_items(base);
    for item in drop_items(overlay) {
        let index = item.iter().find_map(|l| l.strip_prefix("Index:")).and_then(|v| v.trim().parse::<usize>().ok());
        let plain: Vec<String> = item.into_iter().filter(|l| !l.starts_with("Index:")).collect();
        match index {
            Some(n) if n < drops.len() => drops[n] = plain,
            Some(n) if n == drops.len() && n < max => drops.push(plain),
            Some(_) => {}
            None if drops.len() < max => drops.push(plain),
            None => {}
        }
    }
    let mut out = vec![header];
    for item in drops {
        // The slot is the position now; an Index line would only restate it.
        let item: Vec<String> = item.into_iter().filter(|l| !l.starts_with("Index:")).collect();
        for (i, line) in item.iter().enumerate() {
            out.push(if i == 0 { format!("      - {line}") } else { format!("        {line}") });
        }
    }
    out
}

/// `base` with `overlay`'s entries laid over it, as rAthena reads an import.
pub fn overlay_entries(base: &str, overlay: &str) -> String {
    let (head, mut entries, foot) = split(base);
    let (_, extra, _) = split(overlay);
    for add in extra {
        let found = add.id.as_ref().and_then(|id| entries.iter_mut().find(|e| e.id.as_ref() == Some(id)));
        match found {
            Some(entry) => {
                for (key, lines) in add.fields {
                    if key.is_empty() {
                        continue;
                    }
                    let max = match key.as_str() { "Drops" => Some(MAX_MOB_DROP), "MvpDrops" => Some(MAX_MVP_DROP), _ => None };
                    match (entry.fields.iter_mut().find(|(k, _)| *k == key), max) {
                        (Some(slot), Some(max)) => slot.1 = merge_drops(&slot.1, &lines, max),
                        (Some(slot), None) => slot.1 = lines,
                        (None, Some(max)) => entry.fields.push((key.clone(), merge_drops(&[format!("    {key}:")], &lines, max))),
                        (None, None) => entry.fields.push((key, lines)),
                    }
                }
            }
            None => {
                // A new monster's drops can carry `Index:` too; spell them plainly.
                let mut add = add;
                for (key, lines) in add.fields.iter_mut() {
                    let max = match key.as_str() { "Drops" => Some(MAX_MOB_DROP), "MvpDrops" => Some(MAX_MVP_DROP), _ => None };
                    if let Some(max) = max {
                        *lines = merge_drops(&[format!("    {key}:")], lines, max);
                    }
                }
                entries.push(add);
            }
        }
    }
    let mut out = String::new();
    for line in &head {
        out.push_str(line);
        out.push('\n');
    }
    for entry in &entries {
        out.push_str(&entry.head);
        out.push('\n');
        for (_, lines) in &entry.fields {
            for line in lines {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    for line in &foot {
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "Header:\n  Type: MOB_DB\n  Version: 4\n\nBody:\n  - Id: 1002\n    AegisName: PORING\n    Name: Poring\n    Level: 1\n    Drops:\n      - Item: Jellopy\n        Rate: 7000\n  - Id: 1113\n    AegisName: DROPS\n    Name: Drops\n    Level: 2\n\nFooter:\n  Imports:\n  - Path: db/re/mob_db.yml\n";

    #[test]
    fn a_mod_changes_a_stock_entry_field_by_field_and_adds_its_own() {
        let overlay = "Header:\n  Type: MOB_DB\n  Version: 4\n\nBody:\n  - Id: 1002\n    Level: 99\n    Drops:\n      - Item: Apple\n        Rate: 100\n  - Id: 30001\n    AegisName: ISLAND_CRAB\n    Name: Island Crab\n    Level: 5\n";
        let out = overlay_entries(BASE, overlay);
        // The Poring keeps its name and takes the mod's level; the mod's drop,
        // having no Index, is added after its own, as rAthena does.
        let poring = &out[out.find("Id: 1002").unwrap()..out.find("Id: 1113").unwrap()];
        assert!(poring.contains("Name: Poring") && poring.contains("Level: 99"), "{poring}");
        assert!(poring.find("Item: Jellopy").unwrap() < poring.find("Item: Apple").unwrap(), "{poring}");
        assert!(!poring.contains("Level: 1\n"), "{poring}");
        // Untouched entries and the mod's new one are there; the footer stays last.
        assert!(out.contains("Name: Drops") && out.contains("Name: Island Crab"), "{out}");
        assert!(out.trim_end().ends_with("- Path: db/re/mob_db.yml"), "{out}");
        assert!(out.find("Island Crab").unwrap() < out.find("Footer:").unwrap());
    }

    /// The case a player hit: a mod sets two drops by index (the way the
    /// tougher-monsters example does), and the monster keeps the rest of its
    /// list, with every entry spelled `- Item:` so a tool reads it.
    #[test]
    fn drops_merge_slot_by_slot_as_rathena_does() {
        let base = "Header:\n  Type: MOB_DB\n\nBody:\n  - Id: 1002\n    Name: Poring\n    Level: 1\n    Drops:\n      - Item: Jellopy\n        Rate: 7000\n      - Item: Knife_\n        Rate: 100\n      - Item: Apple\n        Rate: 1000\n";
        let overlay = "Body:\n  - Id: 1002\n    Level: 8\n    # a comment\n    Drops:\n      - Index: 0\n        Item: Jellopy\n        Rate: 9000\n      - Index: 1\n        Item: Red_Potion\n        Rate: 2000\n      - Item: Sticky_Mucus\n        Rate: 400\n      - Index: 9\n        Item: Too_Far\n        Rate: 1\n";
        let out = overlay_entries(base, overlay);
        let drops = &out[out.find("Drops:").unwrap()..];
        assert!(!drops.contains("Index:"), "{drops}");
        let items: Vec<&str> = drops.lines().filter_map(|l| l.trim().strip_prefix("- Item: ")).collect();
        assert_eq!(items, ["Jellopy", "Red_Potion", "Apple", "Sticky_Mucus"], "{drops}");
        assert!(drops.contains("Rate: 9000") && !drops.contains("Rate: 7000"), "{drops}");
        assert!(out.contains("Level: 8") && !out.contains("Level: 1\n"), "{out}");
    }

    /// Two mods touching one monster apply in order, as the import is read.
    #[test]
    fn a_later_mod_wins_and_a_full_drop_list_takes_no_more() {
        let base = format!("Body:\n  - Id: 1\n    Name: X\n    Drops:\n{}", (0..10).map(|i| format!("      - Item: I{i}\n        Rate: 1\n")).collect::<String>());
        let overlay = "Body:\n  - Id: 1\n    Name: Y\n  - Id: 1\n    Name: Z\n    Drops:\n      - Item: Extra\n        Rate: 5\n";
        let out = overlay_entries(&base, overlay);
        assert!(out.contains("Name: Z") && !out.contains("Name: Y"), "{out}");
        assert!(!out.contains("Extra"), "a full list takes no appended drop: {out}");
    }

    #[test]
    fn with_nothing_to_lay_over_the_table_is_unchanged() {
        assert_eq!(overlay_entries(BASE, "Header:\n  Type: MOB_DB\n"), BASE);
    }

    #[test]
    fn only_the_listed_tables_can_be_asked_for() {
        assert!(TABLES.contains(&"mob_db"));
        assert!(!TABLES.iter().any(|t| t.contains('/') || t.contains('.')));
    }
}
