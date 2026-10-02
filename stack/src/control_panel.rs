//! `ragnarok-stack cp`: the Control panel in Settings -> Tools (#230).
//!
//! One JSON request on stdin, one JSON answer on stdout, errors included, the
//! way `accounts` works:
//!
//!   {"action":"characters"}                          every player account and its characters
//!   {"action":"character","char_id":"150000"}        one character, with its equipment
//!   {"action":"reset-position","char_id":"150000","target":"save"}
//!   {"action":"reset-position","char_id":"150000","target":{"map":"prontera","x":156,"y":191}}
//!   {"action":"delete-character","char_id":"150000","name":"Bob"}
//!
//! The Database tool (database.rs) is a window onto any table, and an edit
//! there is a row edit and nothing else. This is the other kind of tool: a
//! few things a player actually asks for, each written the way the game
//! writes it, so nothing is left half-done.
//!
//! - Reads go through the database tool's read path (`tool_sql`: hex-encoded,
//!   in a read-only transaction, answered through a file), and never stop
//!   anything.
//! - Moving a character writes the same four columns the char server writes
//!   for a character's position, and only while that character's account is
//!   offline. Why that is enough without stopping the game is at
//!   `reset_statement`.
//! - Deleting a character runs rAthena's own `char_delete` statements, in its
//!   order, with the game stopped, after a backup, and puts the backup back
//!   if any statement fails -- the same guarantees as a Database tool save.
//!
//! Accounts are not made here: the panel calls `accounts create`, so there is
//! one account-creation path with one set of rules (accounts.rs).

use crate::accounts::{agent_account, AGENT_GROUP, MAX_AGENTS};
use crate::config::Config;
use crate::database::{self, field, lines, unreadable, Planned};
use crate::docker::Docker;
use crate::json::{self, Value};
use std::collections::BTreeMap;
use std::io::{self, Read};

const MAX_REQUEST: usize = 4096;
/// More than anyone runs on a single-player server; a bound, not a feature.
const MAX_ACCOUNTS: usize = 1000;
const MAX_CHARACTERS: usize = 5000;

/// rAthena gives player accounts ids from 2000000 up (`login`'s
/// AUTO_INCREMENT in main.sql); below that are the server's own (`s1`).
const FIRST_PLAYER_ACCOUNT: u32 = 2_000_000;

/// The wedding rings `char_divorce_char_sql` takes back (WEDDING_RING_M/F in
/// src/common/mmo.hpp).
const WEDDING_RINGS: [u32; 2] = [2634, 2635];

/// The `char` columns the panel reads, in this order, for both reads.
const CHAR_COLUMNS: &[&str] = &[
    "char_id", "account_id", "char_num", "name", "class", "sex", "base_level", "job_level", "base_exp", "job_exp",
    "zeny", "str", "agi", "vit", "int", "dex", "luk", "hp", "max_hp", "sp", "max_sp", "status_point", "skill_point",
    "last_map", "last_x", "last_y", "save_map", "save_x", "save_y", "online", "party_id", "guild_id", "homun_id",
    "pet_id", "elemental_id", "partner_id", "father", "mother", "hair", "hair_color", "clothes_color", "body",
    "weapon", "shield", "head_top", "head_mid", "head_bottom", "robe", "delete_date", "last_login",
];

/// Columns stored as bytes, read with `HEX(col)`; the rest are read as text.
const TEXT_COLUMNS: &[&str] = &["name", "sex", "last_map", "save_map"];

/// After the `char` columns: the account's name, its guild's and its party's.
const JOINED: &[(&str, &str)] = &[("userid", "l.`userid`"), ("guild", "g.`name`"), ("party", "p.`name`")];

/// The inventory columns of an equipped item.
const EQUIP_COLUMNS: &[&str] = &["id", "nameid", "equip", "refine", "card0", "card1", "card2", "card3", "amount", "identify", "bound"];

pub fn run(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_REQUEST as u64 + 1)
        .read_to_string(&mut input)
        .map_err(|_| "Cannot read the control panel's request")?;
    if input.len() > MAX_REQUEST {
        return Err("The control panel's request is too large".into());
    }
    let request = json::parse(&input).map_err(|e| format!("The request is not valid JSON: {e}"))?;
    let action = Action::parse(&request)?;
    // Writes queue behind every other server operation, as `sql --write` and
    // `db apply` do (main.rs). Reads take no lock: they change nothing, and
    // the panel is most wanted while something else is happening.
    let _lock = if action.writes() { Some(crate::operation_lock::acquire(&cfg.state)?) } else { None };
    // The database actually mounted, not the one settings prefer.
    crate::accounts::verify_era(cfg, dk, crate::service_credentials::era(cfg))
        .map_err(|e| if e.contains("Start this era") { "The game server is not running. Press Play in Ragnarok Offline, then try again.".to_string() } else { e })?;
    dk.require_private_sql()?;
    let out = match action {
        Action::Characters => characters(dk)?,
        Action::Character(id) => character(dk, id)?,
        Action::Reset(id, target) => reset_position(dk, id, &target)?,
        Action::Delete(id, name) => delete_character(cfg, dk, id, &name)?,
    };
    println!("{out}");
    Ok(())
}

// ---- Requests

#[derive(Debug, PartialEq)]
pub enum Target {
    /// Back to the character's save point (`save_map`, `save_x`, `save_y`).
    Save,
    Point { map: String, x: u16, y: u16 },
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Characters,
    Character(u32),
    Reset(u32, Target),
    Delete(u32, String),
}

impl Action {
    pub fn parse(request: &Value) -> Result<Action, String> {
        match request.str("action").ok_or("The request names no action")? {
            "characters" => Ok(Action::Characters),
            "character" => Ok(Action::Character(char_id(request)?)),
            "reset-position" => Ok(Action::Reset(char_id(request)?, target(request.get("target"))?)),
            "delete-character" => {
                let name = request.str("name").ok_or("Type the character's name to confirm deleting it")?;
                if name.is_empty() || name.len() > 30 {
                    return Err("Type the character's name to confirm deleting it".into());
                }
                Ok(Action::Delete(char_id(request)?, name.to_string()))
            }
            other => Err(format!("The control panel has no action called {other:?}")),
        }
    }

    fn writes(&self) -> bool {
        matches!(self, Action::Reset(..) | Action::Delete(..))
    }
}

/// A character id: a whole number, as a string (the panel's way, like the
/// Database tool's) or a JSON number. Never anything that reaches SQL as text.
fn char_id(request: &Value) -> Result<u32, String> {
    let parsed = match request.get("char_id") {
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit()) => s.parse::<u32>().ok(),
        Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0 && *n <= u32::MAX as f64 => Some(*n as u32),
        _ => None,
    };
    parsed.filter(|id| *id > 0).ok_or_else(|| "Which character? char_id must be a character's id".into())
}

/// The largest coordinate accepted. rAthena's largest maps are a few hundred
/// cells across; this only keeps the number sensible.
const MAX_COORDINATE: u16 = 1023;

fn target(value: Option<&Value>) -> Result<Target, String> {
    match value {
        Some(Value::String(s)) if s == "save" => Ok(Target::Save),
        Some(point @ Value::Object(_)) => {
            let map = point.str("map").ok_or("Which map?")?.trim().to_ascii_lowercase();
            map_name(&map)?;
            let coordinate = |key: &str| -> Result<u16, String> {
                let n = match point.get(key) {
                    Some(Value::Number(n)) if n.fract() == 0.0 => *n,
                    Some(Value::String(s)) if !s.is_empty() && s.len() <= 5 && s.bytes().all(|b| b.is_ascii_digit()) => s.parse::<f64>().unwrap_or(-1.0),
                    _ => -1.0,
                };
                if !(0.0..=MAX_COORDINATE as f64).contains(&n) {
                    return Err(format!("{key} must be a whole number from 0 to {MAX_COORDINATE}"));
                }
                Ok(n as u16)
            };
            Ok(Target::Point { map, x: coordinate("x")?, y: coordinate("y")? })
        }
        _ => Err("Move it where? Give \"save\" or a map with x and y".into()),
    }
}

/// A map name as rAthena writes them: lowercase letters, digits, `_` and `-`,
/// at most 11 characters (`char.last_map` is a varchar(11); MAP_NAME_LENGTH
/// is 12 with its terminator). Instance maps (`1@tower`) are refused: a
/// character can only be in one through its instance.
///
/// Whether the map is one the server has loaded is not checked here -- the
/// supervisor has no list of them. The char server copes with one it has not:
/// a character whose last map no map server has is sent to a major city
/// (`chclif_parse_charselect`, src/char/char_clif.cpp), and coordinates off
/// the map, or 0,0, become a random walkable cell (`pc_setpos`,
/// src/map/pc.cpp).
fn map_name(map: &str) -> Result<(), String> {
    if map.is_empty() || map.len() > 11 || !map.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-') {
        return Err(format!("{map:?} is not a map name: use the map's file name, like prontera or prt_fild08"));
    }
    Ok(())
}

// ---- Reading

/// Accounts a player plays on. Not the server's own (`s1`, sex S, below
/// 2000000), and not the AI agents' (#187): those are the app's, found by
/// name and group the way accounts.rs finds them.
fn player_accounts(alias: &str) -> String {
    let agents: Vec<String> = (1..=MAX_AGENTS).map(|n| format!("X'{}'", database::hex(agent_account(n).as_bytes()))).collect();
    format!(
        "{alias}.`sex` <> 'S' AND {alias}.`account_id` >= {FIRST_PLAYER_ACCOUNT} AND NOT ({alias}.`group_id` = {AGENT_GROUP} AND {alias}.`userid` IN ({}))",
        agents.join(", ")
    )
}

fn char_select() -> String {
    let mut parts: Vec<String> = CHAR_COLUMNS
        .iter()
        .map(|c| if TEXT_COLUMNS.contains(c) { format!("HEX(c.`{c}`)") } else { format!("HEX(CAST(c.`{c}` AS CHAR))") })
        .collect();
    parts.extend(JOINED.iter().map(|(_, expr)| format!("HEX({expr})")));
    parts.join(", ")
}

const CHAR_FROM: &str = "FROM `char` AS c JOIN `login` AS l ON l.`account_id` = c.`account_id` \
                         LEFT JOIN `guild` AS g ON g.`guild_id` = c.`guild_id` LEFT JOIN `party` AS p ON p.`party_id` = c.`party_id`";

/// The read behind the account list: one `a` line per account, one `c` line
/// per character. One statement per line, like every script here.
pub fn characters_sql() -> String {
    format!(
        "START TRANSACTION READ ONLY;\n\
         SELECT 'a', HEX(CAST(l.`account_id` AS CHAR)), HEX(l.`userid`), HEX(CAST(l.`group_id` AS CHAR)), HEX(CAST(l.`state` AS CHAR)) FROM `login` AS l WHERE {} ORDER BY l.`account_id` LIMIT {};\n\
         SELECT 'c', {} {CHAR_FROM} WHERE {} ORDER BY c.`account_id`, c.`char_num`, c.`char_id` LIMIT {};\n\
         ROLLBACK;\n",
        player_accounts("l"),
        MAX_ACCOUNTS + 1,
        char_select(),
        player_accounts("l"),
        MAX_CHARACTERS + 1,
    )
}

/// One character, its equipped items, and how many items it has where.
pub fn character_sql(id: u32) -> String {
    let equip: Vec<String> = EQUIP_COLUMNS.iter().map(|c| format!("HEX(CAST(i.`{c}` AS CHAR))")).collect();
    format!(
        "START TRANSACTION READ ONLY;\n\
         SELECT 'c', {} {CHAR_FROM} WHERE c.`char_id` = {id} AND {};\n\
         SELECT 'e', {} FROM `inventory` AS i WHERE i.`char_id` = {id} AND i.`equip` <> 0 ORDER BY i.`equip`, i.`id`;\n\
         SELECT 'n', (SELECT COUNT(*) FROM `inventory` WHERE `char_id` = {id}), (SELECT COUNT(*) FROM `cart_inventory` WHERE `char_id` = {id}), (SELECT COUNT(*) FROM `storage` WHERE `account_id` = (SELECT `account_id` FROM `char` WHERE `char_id` = {id}));\n\
         ROLLBACK;\n",
        char_select(),
        player_accounts("l"),
        equip.join(", "),
    )
}

/// A character as read: its columns by name, as bytes.
#[derive(Debug, Clone, Default)]
pub struct Character {
    values: BTreeMap<String, Option<Vec<u8>>>,
}

impl Character {
    fn from_fields(fields: &[&str]) -> Result<Character, String> {
        let names = CHAR_COLUMNS.iter().copied().chain(JOINED.iter().map(|(k, _)| *k));
        let mut values = BTreeMap::new();
        for (name, text) in names.zip(fields) {
            values.insert(name.to_string(), field(text)?);
        }
        Ok(Character { values })
    }

    fn bytes(&self, key: &str) -> Option<&[u8]> {
        self.values.get(key).and_then(|v| v.as_deref())
    }

    pub fn text(&self, key: &str) -> String {
        self.bytes(key).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
    }

    /// A number column. They are all unsigned and read back as digits.
    pub fn num(&self, key: &str) -> u64 {
        self.text(key).parse().unwrap_or(0)
    }

    fn to_json(&self) -> String {
        let names = CHAR_COLUMNS.iter().copied().chain(JOINED.iter().map(|(k, _)| *k));
        let parts: Vec<String> = names.map(|k| format!("{}:{}", json::quote(k), database::cell_json(self.bytes(k)))).collect();
        format!("{{{}}}", parts.join(","))
    }
}

/// The expected number of fields on a line, after its tag.
fn expect(row: &[&str], n: usize, line: usize, what: &str) -> Result<(), String> {
    if row.len() != n + 1 {
        return Err(unreadable(line, &format!("{what} has {} values, not {n}", row.len() - 1)));
    }
    Ok(())
}

pub fn parse_characters(output: &str) -> Result<String, String> {
    let char_fields = CHAR_COLUMNS.len() + JOINED.len();
    let mut accounts: Vec<(String, String)> = Vec::new();
    let mut by_account: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut characters = 0;
    for (n, row) in lines(output).enumerate() {
        match row.first() {
            Some(&"a") => {
                expect(&row, 4, n, "an account")?;
                let id = String::from_utf8_lossy(&field(row[1])?.unwrap_or_default()).into_owned();
                let account = format!(
                    "\"id\":{},\"username\":{},\"group\":{},\"state\":{}",
                    json::quote(&id),
                    database::cell_json(field(row[2])?.as_deref()),
                    database::cell_json(field(row[3])?.as_deref()),
                    database::cell_json(field(row[4])?.as_deref()),
                );
                accounts.push((id, account));
            }
            Some(&"c") => {
                expect(&row, char_fields, n, "a character")?;
                let c = Character::from_fields(&row[1..])?;
                by_account.entry(c.text("account_id")).or_default().push(c.to_json());
                characters += 1;
            }
            _ => return Err(unreadable(n, "a line is neither an account nor a character")),
        }
    }
    if accounts.len() > MAX_ACCOUNTS || characters > MAX_CHARACTERS {
        return Err(format!("The control panel shows at most {MAX_ACCOUNTS} accounts and {MAX_CHARACTERS} characters."));
    }
    let items: Vec<String> = accounts
        .iter()
        .map(|(id, account)| {
            let list = by_account.get(id).map(|v| v.join(",")).unwrap_or_default();
            format!("{{{account},\"characters\":[{list}]}}")
        })
        .collect();
    Ok(format!("{{\"accounts\":[{}]}}", items.join(",")))
}

pub fn parse_character(output: &str) -> Result<(Option<Character>, String), String> {
    let char_fields = CHAR_COLUMNS.len() + JOINED.len();
    let mut found = None;
    let mut equipment = Vec::new();
    let mut counts = None;
    for (n, row) in lines(output).enumerate() {
        match row.first() {
            Some(&"c") => {
                expect(&row, char_fields, n, "a character")?;
                found = Some(Character::from_fields(&row[1..])?);
            }
            Some(&"e") => {
                expect(&row, EQUIP_COLUMNS.len(), n, "an item")?;
                let mut parts = Vec::new();
                for (name, text) in EQUIP_COLUMNS.iter().zip(&row[1..]) {
                    parts.push(format!("{}:{}", json::quote(name), database::cell_json(field(text)?.as_deref())));
                }
                equipment.push(format!("{{{}}}", parts.join(",")));
            }
            Some(&"n") => {
                expect(&row, 3, n, "the item counts")?;
                let number = |t: &str| t.parse::<u64>().map_err(|_| unreadable(n, "an item count is not a number"));
                counts = Some(format!(
                    "{{\"inventory\":{},\"cart\":{},\"storage\":{}}}",
                    number(row[1])?,
                    number(row[2])?,
                    number(row[3])?
                ));
            }
            _ => return Err(unreadable(n, "a line is neither the character, an item nor the counts")),
        }
    }
    let Some(character) = found else { return Ok((None, String::new())) };
    let counts = counts.ok_or_else(|| unreadable(0, "it has no item counts"))?;
    let out = format!("{{\"character\":{},\"equipment\":[{}],\"counts\":{counts}}}", character.to_json(), equipment.join(","));
    Ok((Some(character), out))
}

fn read_error(e: String) -> String {
    format!("The database refused that: {}", database::db_error(&e))
}

fn characters(dk: &Docker) -> Result<String, String> {
    parse_characters(&dk.tool_sql(&characters_sql()).map_err(read_error)?)
}

/// One character, read; the reads before a write use it too.
fn read_character(dk: &Docker, id: u32) -> Result<(Character, String), String> {
    match parse_character(&dk.tool_sql(&character_sql(id)).map_err(read_error)?)? {
        (Some(c), out) => Ok((c, out)),
        (None, _) => Err(format!("There is no character {id} on a player account. Reload the list.")),
    }
}

fn character(dk: &Docker, id: u32) -> Result<String, String> {
    read_character(dk, id).map(|(_, out)| out)
}

/// Whether any character on this account is in the game. A count, read live.
fn account_online(dk: &Docker, account_id: u64) -> Result<u64, String> {
    let out = dk
        .tool_sql(&format!("SELECT 'o', COUNT(*) FROM `char` WHERE `account_id` = {account_id} AND `online` <> 0;"))
        .map_err(read_error)?;
    for (n, row) in lines(&out).enumerate() {
        if let ["o", count] = row.as_slice() {
            return count.parse().map_err(|_| unreadable(n, "the count is not a number"));
        }
    }
    Err(unreadable(0, "it has no count"))
}

// ---- Moving a character

/// The one statement that moves a character, and the count that says whether
/// it did.
///
/// Why this is safe with the game running, which is the whole point of it:
///
/// The char server keeps a copy of a character only while it is in the game.
/// Selecting a character sets `online` to 1 *before* loading it ("set char as
/// online prior to loading its data so 3rd party applications will realise
/// the sql data is not reliable", `chclif_parse_charselect`,
/// src/char/char_clif.cpp), and the copy goes into `char_db`, the char
/// server's cache (`char_mmo_char_fromsql`, src/char/char.cpp). Leaving the
/// game is a final save from the map server (`chmapif_parse_reqsavechar`,
/// src/char/char_mapif.cpp), which writes the character and then calls
/// `char_set_char_offline` (src/char/char.cpp): that erases the character
/// from `char_db` and only then writes `online` = 0. So a character whose row
/// says `online` = 0 has no copy anywhere that could be written back over this
/// change, and the next time it is selected it is loaded from these columns.
/// That is the state the game itself leaves every character in when its
/// player logs out.
///
/// The check is in the statement, not before it: the row is only changed if it
/// is still offline at the moment it is written, so a player who selects the
/// character in between gets the old position and this reports that nothing
/// moved. A character on an account with *any* character in the game is left
/// alone too, so nobody is moved from under someone who is playing.
///
/// It writes the columns `char_mmo_char_tosql` writes for a position --
/// `last_map`, `last_x`, `last_y`, `last_instanceid` -- and nothing else. The
/// instance is cleared: it belonged to the map being left.
pub fn reset_statement(id: u32, target: &Target) -> String {
    let set = match target {
        Target::Save => "c.`last_map` = c.`save_map`, c.`last_x` = c.`save_x`, c.`last_y` = c.`save_y`".to_string(),
        Target::Point { map, x, y } => format!("c.`last_map` = X'{}', c.`last_x` = {x}, c.`last_y` = {y}", database::hex(map.as_bytes())),
    };
    format!(
        "UPDATE `char` AS c LEFT JOIN `char` AS o ON o.`account_id` = c.`account_id` AND o.`online` <> 0 \
         SET {set}, c.`last_instanceid` = 0 WHERE c.`char_id` = {id} AND c.`online` = 0 AND o.`char_id` IS NULL;\n\
         SELECT 'n', ROW_COUNT();\n"
    )
}

fn reset_position(dk: &Docker, id: u32, target: &Target) -> Result<String, String> {
    let (c, _) = read_character(dk, id)?;
    let name = c.text("name");
    // Said here, before anything is written, so the panel can say which.
    if c.num("online") != 0 {
        return Err(format!("{name} is in the game. Log out to the character select screen or quit, then try again."));
    }
    if account_online(dk, c.num("account_id"))? != 0 {
        return Err(format!("Another character on {}'s account is in the game. Log out first, then try again.", c.text("userid")));
    }
    let (map, x, y) = match target {
        Target::Save => {
            let map = c.text("save_map");
            if map.is_empty() {
                return Err(format!("{name} has no save point."));
            }
            (map, c.num("save_x"), c.num("save_y"))
        }
        Target::Point { map, x, y } => (map.clone(), *x as u64, *y as u64),
    };
    let answer = |moved: bool| {
        format!("{{\"moved\":{moved},\"char_id\":\"{id}\",\"map\":{},\"x\":{x},\"y\":{y}}}", json::quote(&map))
    };
    // ROW_COUNT() counts rows changed, not matched: a character already there
    // would read as "nothing moved". It is where it was asked to be.
    if c.text("last_map") == map && c.num("last_x") == x && c.num("last_y") == y {
        return Ok(answer(false));
    }
    let out = dk.tool_sql(&reset_statement(id, target)).map_err(|e| format!("Nothing was moved: {}", database::db_error(&e)))?;
    let changed = lines(&out).find_map(|row| match row.as_slice() {
        ["n", count] => count.parse::<u64>().ok(),
        _ => None,
    });
    match changed {
        Some(1) => Ok(answer(true)),
        Some(_) => Err(format!("Nothing was moved: {name} or another character on the account went into the game just now. Log out, then try again.")),
        None => Err(format!("Nothing was moved: {}", unreadable(0, "it has no row count"))),
    }
}

// ---- Deleting a character

/// What `char_del_restriction` refuses by default (CHAR_DEL_RESTRICT_ALL,
/// `char_config_init`, src/char/char.cpp), checked before anything stops, and
/// again once the game has: a character in a guild or a party, or one that
/// leads a guild (a guild master is in that guild, but a guild row naming it
/// is checked as well, because `char_delete` would break that guild up).
fn refusal(c: &Character, typed: &str, masters: u64) -> Option<String> {
    let name = c.text("name");
    if c.bytes("name") != Some(typed.as_bytes()) {
        return Some(format!("The name typed does not match: the character is called {name}."));
    }
    if c.num("guild_id") != 0 || masters != 0 {
        return Some(format!("{name} is in a guild. Leave the guild in the game first; rAthena will not delete a character that is in one."));
    }
    if c.num("party_id") != 0 {
        return Some(format!("{name} is in a party. Leave the party in the game first; rAthena will not delete a character that is in one."));
    }
    None
}

/// `char_delete` (src/char/char.cpp, at the pinned rAthena), as statements,
/// in its order, for a character that passed `refusal`. Each is the same
/// statement against the same table; where it calls out to a helper the
/// helper's statements are inlined and named. Its party and guild steps are
/// left out because a character in either is refused above, and the map
/// server notifications because the game is stopped.
pub fn delete_statements(c: &Character) -> Vec<Planned> {
    let id = c.num("char_id");
    let account = c.num("account_id");
    let mut out = Vec::new();
    let mut add = |label: &str, statement: String| out.push(Planned { label: label.into(), statement, check: None, absent: None });
    // char_divorce_char_sql
    let partner = c.num("partner_id");
    if partner != 0 {
        add("divorce", format!("UPDATE `char` SET `partner_id` = 0 WHERE `char_id` = {id} OR `char_id` = {partner} LIMIT 2;"));
        add(
            "the wedding rings",
            format!(
                "DELETE FROM `inventory` WHERE (`nameid` = {} OR `nameid` = {}) AND (`char_id` = {id} OR `char_id` = {partner}) LIMIT 2;",
                WEDDING_RINGS[0], WEDDING_RINGS[1]
            ),
        );
    }
    // De-adopt: the parents lose the child and its skill (410, WE_CALLBABY).
    let (father, mother) = (c.num("father"), c.num("mother"));
    if father != 0 || mother != 0 {
        add("the adoption", format!("UPDATE `char` SET `child` = 0 WHERE `char_id` = {father} OR `char_id` = {mother};"));
        add("the parents' Call Baby skill", format!("DELETE FROM `skill` WHERE `id` = 410 AND (`char_id` = {father} OR `char_id` = {mother});"));
    }
    add("the hatched pet", format!("DELETE FROM `pet` WHERE `char_id` = {id} AND `incubate` = 0;"));
    for table in ["inventory", "cart_inventory"] {
        add(
            "pets in eggs",
            format!("DELETE FROM `pet` USING `pet` JOIN `{table}` ON `pet_id` = `card1`|`card2`<<16 WHERE `{table}`.char_id = {id} AND card0 = 256;"),
        );
    }
    // mapif_homunculus_delete (src/char/int_homun.cpp)
    let homun = c.num("homun_id");
    if homun != 0 {
        for table in ["skillcooldown_homunculus", "skill_homunculus", "homunculus"] {
            add("the homunculus", format!("DELETE FROM `{table}` WHERE `homun_id` = {homun};"));
        }
    }
    // mapif_elemental_delete (src/char/int_elemental.cpp)
    let elemental = c.num("elemental_id");
    if elemental != 0 {
        add("the elemental", format!("DELETE FROM `elemental` WHERE `ele_id` = {elemental};"));
    }
    // mercenary_owner_delete (src/char/int_mercenary.cpp)
    add(
        "the mercenary",
        format!("DELETE FROM `skillcooldown_mercenary` WHERE `mer_id` IN ( SELECT `merc_id` FROM `mercenary_owner` WHERE `char_id` = {id} );"),
    );
    add("the mercenary", format!("DELETE FROM `mercenary_owner` WHERE `char_id` = {id};"));
    add("the mercenary", format!("DELETE FROM `mercenary` WHERE `char_id` = {id};"));
    add("friends", format!("DELETE FROM `friends` WHERE `char_id` = {id};"));
    add("friends", format!("DELETE FROM `friends` WHERE `friend_id` = {id};"));
    // HOTKEY_SAVING is defined (src/common/mmo.hpp).
    add("hotkeys", format!("DELETE FROM `hotkey` WHERE `char_id` = {id};"));
    add("the inventory", format!("DELETE FROM `inventory` WHERE `char_id` = {id};"));
    add("the cart", format!("DELETE FROM `cart_inventory` WHERE `char_id` = {id};"));
    add("memo points", format!("DELETE FROM `memo` WHERE `char_id` = {id};"));
    add("variables", format!("DELETE FROM `char_reg_str` WHERE `char_id` = {id};"));
    add("variables", format!("DELETE FROM `char_reg_num` WHERE `char_id` = {id};"));
    add("skills", format!("DELETE FROM `skill` WHERE `char_id` = {id};"));
    add("mail", format!("DELETE FROM `mail` WHERE `dest_id` = {id};"));
    add("mail", format!("UPDATE `mail` SET `send_id` = 0 WHERE `send_id` = {id};"));
    // ENABLE_SC_SAVING is defined (src/common/mmo.hpp).
    add("status changes", format!("DELETE FROM `sc_data` WHERE `account_id` = {account} AND `char_id` = {id};"));
    add("bonus scripts", format!("DELETE FROM `bonus_script` WHERE `char_id` = {id};"));
    add("quests", format!("DELETE FROM `quest` WHERE `char_id` = {id};"));
    add("achievements", format!("DELETE FROM `achievement` WHERE `char_id` = {id};"));
    // log_char is on in the shipped char_athena.conf.
    add(
        "the character log",
        format!(
            "INSERT INTO `charlog` (`time`, `account_id`, `char_num`, `char_msg`, `name`) VALUES (NOW(), {account}, 0, 'Deleted char (CID {id})', X'{}');",
            database::hex(c.bytes("name").unwrap_or_default())
        ),
    );
    add("the character", format!("DELETE FROM `char` WHERE `char_id` = {id};"));
    out
}

/// How many guilds this character leads.
fn guilds_led(dk: &Docker, id: u32) -> Result<u64, String> {
    let out = dk.tool_sql(&format!("SELECT 'g', COUNT(*) FROM `guild` WHERE `char_id` = {id};")).map_err(read_error)?;
    for (n, row) in lines(&out).enumerate() {
        if let ["g", count] = row.as_slice() {
            return count.parse().map_err(|_| unreadable(n, "the count is not a number"));
        }
    }
    Err(unreadable(0, "it has no count"))
}

fn delete_character(cfg: &Config, dk: &Docker, id: u32, typed: &str) -> Result<String, String> {
    // Everything that would refuse is said before the game stops, so a
    // refusal never disconnects anybody.
    let (c, _) = read_character(dk, id)?;
    if let Some(why) = refusal(&c, typed, guilds_led(dk, id)?) {
        return Err(why);
    }
    if c.num("online") != 0 || account_online(dk, c.num("account_id"))? != 0 {
        return Err(format!("{}'s account is in the game. Log out first, then try again.", c.text("name")));
    }
    let era = crate::service_credentials::era(cfg);
    let backup = cfg.state.join("backups").join(format!("before-control-panel-{era}-{}.sql", crate::private_fs::random_hex(8)?));
    let deleted = std::cell::Cell::new(false);
    crate::accounts::with_servers_stopped(cfg, dk, "delete", || {
        crate::cmds::backup_snapshot(cfg, dk, &backup.to_string_lossy(), false)
            .map_err(|e| format!("Nothing was deleted: the backup taken first failed: {e}"))?;
        // Again, now that nothing can change it: the game saved on the way
        // down, and the player may have joined a party since.
        let (c, _) = read_character(dk, id).map_err(|e| format!("Nothing was deleted: {e}"))?;
        if let Some(why) = refusal(&c, typed, guilds_led(dk, id)?) {
            return Err(format!("Nothing was deleted: {why}"));
        }
        let planned = delete_statements(&c);
        let script = database::save_script(&planned);
        if let Err(raw) = dk.tool_sql(&script) {
            let error = database::db_error(&raw);
            let which = database::failed_change(&raw, planned.len())
                .map(|i| format!("Deleting {} failed", planned[i].label))
                .unwrap_or_else(|| "The delete failed".into());
            return Err(match crate::cmds::load_dump(cfg, dk, &backup) {
                Ok(()) => format!("{which}: {error}. Nothing was deleted: the database was put back as it was."),
                Err(_) => format!("{which}: {error}. Putting the database back failed too; restore {} from Settings before playing.", backup.display()),
            });
        }
        deleted.set(true);
        Ok(())
    })
    .map_err(|e| if deleted.get() { format!("{} was deleted (backup: {}). {e}", c.text("name"), backup.display()) } else { e })?;
    Ok(format!(
        "{{\"deleted\":\"{id}\",\"name\":{},\"backup\":{}}}",
        database::cell_json(c.bytes("name")),
        json::quote(&backup.to_string_lossy())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> Result<Action, String> {
        Action::parse(&json::parse(src).unwrap())
    }

    /// A character as the read gives it back, with these values set.
    fn character(values: &[(&str, &str)]) -> Character {
        let mut c = Character::default();
        for name in CHAR_COLUMNS.iter().chain(JOINED.iter().map(|(k, _)| k)) {
            c.values.insert(name.to_string(), Some(b"0".to_vec()));
        }
        for (k, v) in values {
            c.values.insert(k.to_string(), Some(v.as_bytes().to_vec()));
        }
        c
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        assert_eq!(parse(r#"{"action":"characters"}"#).unwrap(), Action::Characters);
        assert_eq!(parse(r#"{"action":"character","char_id":"150000"}"#).unwrap(), Action::Character(150000));
        assert_eq!(parse(r#"{"action":"character","char_id":150001}"#).unwrap(), Action::Character(150001));
        assert_eq!(parse(r#"{"action":"reset-position","char_id":"7","target":"save"}"#).unwrap(), Action::Reset(7, Target::Save));
        assert_eq!(
            parse(r#"{"action":"reset-position","char_id":"7","target":{"map":" Prontera ","x":156,"y":"191"}}"#).unwrap(),
            Action::Reset(7, Target::Point { map: "prontera".into(), x: 156, y: 191 })
        );
        assert_eq!(parse(r#"{"action":"delete-character","char_id":"7","name":"Bob"}"#).unwrap(), Action::Delete(7, "Bob".into()));
        for bad in [
            r#"{}"#,
            r#"{"action":"drop"}"#,
            r#"{"action":"character"}"#,
            r#"{"action":"character","char_id":"1 OR 1=1"}"#,
            r#"{"action":"character","char_id":"0"}"#,
            r#"{"action":"character","char_id":-1}"#,
            r#"{"action":"character","char_id":1.5}"#,
            r#"{"action":"character","char_id":"99999999999"}"#,
            r#"{"action":"reset-position","char_id":"7"}"#,
            r#"{"action":"reset-position","char_id":"7","target":"home"}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"prontera","x":156}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"prontera","x":-1,"y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"prontera","x":1024,"y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"prontera","x":"1e3","y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"prt'; DROP","x":1,"y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"1@tower","x":1,"y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"a_very_long_map","x":1,"y":5}}"#,
            r#"{"action":"reset-position","char_id":"7","target":{"map":"","x":1,"y":5}}"#,
            r#"{"action":"delete-character","char_id":"7"}"#,
            r#"{"action":"delete-character","char_id":"7","name":""}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        // Only the two writes take the operation lock.
        assert!(!Action::Characters.writes() && !Action::Character(1).writes());
        assert!(Action::Reset(1, Target::Save).writes() && Action::Delete(1, "x".into()).writes());
    }

    #[test]
    fn a_move_is_one_guarded_update_of_the_position_columns() {
        let sql = reset_statement(150000, &Target::Point { map: "prt_fild08".into(), x: 170, y: 375 });
        assert_eq!(
            sql,
            format!(
                "UPDATE `char` AS c LEFT JOIN `char` AS o ON o.`account_id` = c.`account_id` AND o.`online` <> 0 \
                 SET c.`last_map` = X'{}', c.`last_x` = 170, c.`last_y` = 375, c.`last_instanceid` = 0 \
                 WHERE c.`char_id` = 150000 AND c.`online` = 0 AND o.`char_id` IS NULL;\nSELECT 'n', ROW_COUNT();\n",
                database::hex(b"prt_fild08")
            )
        );
        let save = reset_statement(9, &Target::Save);
        assert!(save.contains("SET c.`last_map` = c.`save_map`, c.`last_x` = c.`save_x`, c.`last_y` = c.`save_y`, c.`last_instanceid` = 0 WHERE c.`char_id` = 9 AND c.`online` = 0"), "{save}");
        // Two statements, one per line, and only `char` is written.
        assert_eq!(crate::cmds::leading_words(&save).iter().map(|w| w.to_ascii_uppercase()).collect::<Vec<_>>(), ["UPDATE", "SELECT"]);
        assert!(!save.contains("save_map` ="), "the save point is never written: {save}");
    }

    #[test]
    fn reads_are_read_only_and_leave_out_the_apps_own_accounts() {
        for sql in [characters_sql(), character_sql(150000)] {
            let words: Vec<String> = crate::cmds::leading_words(&sql).into_iter().map(|w| w.to_ascii_uppercase()).collect();
            assert_eq!(words.first().map(String::as_str), Some("START"), "{sql}");
            assert_eq!(words.last().map(String::as_str), Some("ROLLBACK"), "{sql}");
            assert!(words[1..words.len() - 1].iter().all(|w| w == "SELECT"), "{sql}");
            assert!(sql.contains("START TRANSACTION READ ONLY;"));
            assert!(sql.contains(&format!("`account_id` >= {FIRST_PLAYER_ACCOUNT}")) && sql.contains("`sex` <> 'S'"));
            assert!(sql.contains(&format!("`group_id` = {AGENT_GROUP} AND l.`userid` IN (X'{}'", database::hex(b"aiagent"))), "{sql}");
            // One statement per line, which the fake database and the error
            // line numbers both rely on.
            assert!(sql.lines().all(|l| l.matches(';').count() == 1), "{sql}");
        }
        assert!(character_sql(42).contains("c.`char_id` = 42 AND"));
        assert!(character_sql(42).contains("i.`char_id` = 42 AND i.`equip` <> 0"));
    }

    #[test]
    fn the_list_groups_characters_under_their_accounts() {
        let h = |s: &str| database::hex(s.as_bytes());
        let mut out = format!("a\t{}\t{}\t{}\t{}\n", h("2000001"), h("player1"), h("0"), h("0"));
        out.push_str(&format!("a\t{}\t{}\t{}\t{}\n", h("2000002"), h("empty"), h("99"), h("0")));
        let mut row: Vec<String> = CHAR_COLUMNS.iter().map(|c| h(match *c { "account_id" => "2000001", "name" => "Bob\tTab", "base_exp" => "18446744073709551615", _ => "1" })).collect();
        row.extend(["706C6179657231".to_string(), "NULL".into(), h("Party")]);
        out.push_str(&format!("c\t{}\n", row.join("\t")));
        let answer = json::parse(&parse_characters(&out).unwrap()).unwrap();
        let Some(Value::Array(accounts)) = answer.get("accounts") else { panic!() };
        assert_eq!(accounts.len(), 2);
        let Some(Value::Array(chars)) = accounts[0].get("characters") else { panic!() };
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].str("name"), Some("Bob\tTab"));
        assert_eq!(chars[0].str("base_exp"), Some("18446744073709551615"));
        assert_eq!(chars[0].get("guild"), Some(&Value::Null));
        assert_eq!(chars[0].str("party"), Some("Party"));
        assert_eq!(accounts[1].get("characters"), Some(&Value::Array(vec![])));
        assert!(parse_characters("c\t31\n").unwrap_err().contains("not"));
        assert!(parse_characters("x\t1\n").is_err());
    }

    #[test]
    fn deleting_is_rathenas_char_delete_in_its_order() {
        let c = character(&[("char_id", "150007"), ("account_id", "2000003"), ("name", "Bob's")]);
        let planned = delete_statements(&c);
        let statements: Vec<&str> = planned.iter().map(|p| p.statement.as_str()).collect();
        let tables: Vec<String> = statements
            .iter()
            .map(|s| s.split('`').nth(1).unwrap().to_string())
            .collect();
        // The order of char_delete at the pinned rAthena, with no partner,
        // parents, homunculus or elemental.
        assert_eq!(
            tables,
            [
                "pet", "pet", "pet", "skillcooldown_mercenary", "mercenary_owner", "mercenary", "friends", "friends", "hotkey",
                "inventory", "cart_inventory", "memo", "char_reg_str", "char_reg_num", "skill", "mail", "mail", "sc_data",
                "bonus_script", "quest", "achievement", "charlog", "char",
            ]
        );
        assert_eq!(statements[0], "DELETE FROM `pet` WHERE `char_id` = 150007 AND `incubate` = 0;");
        assert_eq!(
            statements[1],
            "DELETE FROM `pet` USING `pet` JOIN `inventory` ON `pet_id` = `card1`|`card2`<<16 WHERE `inventory`.char_id = 150007 AND card0 = 256;"
        );
        assert!(statements.contains(&"DELETE FROM `friends` WHERE `friend_id` = 150007;"));
        assert!(statements.contains(&"UPDATE `mail` SET `send_id` = 0 WHERE `send_id` = 150007;"));
        assert!(statements.contains(&"DELETE FROM `sc_data` WHERE `account_id` = 2000003 AND `char_id` = 150007;"));
        // The name goes into the log as bytes, never as SQL.
        assert!(statements.iter().any(|s| s.ends_with(&format!("'Deleted char (CID 150007)', X'{}');", database::hex(b"Bob's")))));
        assert_eq!(*statements.last().unwrap(), "DELETE FROM `char` WHERE `char_id` = 150007;");
        // One statement per line, so an error's line names the step.
        let script = database::save_script(&planned);
        assert!(script.lines().all(|l| l.matches(';').count() == 1), "{script}");

        // Married, adopted, with a homunculus and an elemental: their steps
        // come first, as in char_delete.
        let c = character(&[("char_id", "5"), ("partner_id", "6"), ("father", "7"), ("mother", "8"), ("homun_id", "9"), ("elemental_id", "10")]);
        let all: Vec<String> = delete_statements(&c).into_iter().map(|p| p.statement).collect();
        assert_eq!(all[0], "UPDATE `char` SET `partner_id` = 0 WHERE `char_id` = 5 OR `char_id` = 6 LIMIT 2;");
        assert_eq!(all[1], "DELETE FROM `inventory` WHERE (`nameid` = 2634 OR `nameid` = 2635) AND (`char_id` = 5 OR `char_id` = 6) LIMIT 2;");
        assert_eq!(all[2], "UPDATE `char` SET `child` = 0 WHERE `char_id` = 7 OR `char_id` = 8;");
        assert_eq!(all[3], "DELETE FROM `skill` WHERE `id` = 410 AND (`char_id` = 7 OR `char_id` = 8);");
        let homun = all.iter().position(|s| s == "DELETE FROM `homunculus` WHERE `homun_id` = 9;").unwrap();
        assert_eq!(all[homun - 2], "DELETE FROM `skillcooldown_homunculus` WHERE `homun_id` = 9;");
        assert_eq!(all[homun + 1], "DELETE FROM `elemental` WHERE `ele_id` = 10;");
    }

    #[test]
    fn a_delete_is_refused_where_the_game_would_refuse_it() {
        let ok = character(&[("name", "Bob")]);
        assert_eq!(refusal(&ok, "Bob", 0), None);
        assert!(refusal(&ok, "bob", 0).unwrap().contains("does not match"));
        assert!(refusal(&ok, "Bob ", 0).unwrap().contains("does not match"));
        assert!(refusal(&character(&[("name", "Bob"), ("guild_id", "3")]), "Bob", 0).unwrap().contains("guild"));
        assert!(refusal(&ok, "Bob", 1).unwrap().contains("guild"), "a guild master is refused even if char.guild_id says 0");
        assert!(refusal(&character(&[("name", "Bob"), ("party_id", "2")]), "Bob", 0).unwrap().contains("party"));
    }
}
