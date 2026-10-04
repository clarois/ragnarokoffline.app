//! `ragnarok-stack db ...`: the database browser in Settings -> Tools (#200).
//!
//!   db tables                  every table, with its row count and key
//!   db describe <table>        its columns
//!   db rows    (JSON on stdin) one page of rows: filters, order, limit, offset
//!   db apply   (JSON on stdin) a batch of edits, saved together
//!
//! The structured counterpart of `sql`: answers are JSON, so the page never
//! parses text, and the page never sends SQL for a write. `apply` takes a list
//! of `{ table, key, set }` / `{ table, insert }` / `{ table, key, delete }`
//! and builds every statement here, against the table's own column list.
//!
//! Values cross in both directions hex-encoded. Reads select `HEX(column)`,
//! so a tab, a newline or a stray byte in a character name cannot break the
//! output apart, and writes carry `X'...'` literals, so nothing typed into a
//! cell is ever SQL. The bytes are the bytes: rAthena stores what the client
//! sent, whatever encoding that was, and a cell that is not UTF-8 comes back
//! as `{"hex": "..."}` and goes back the same way.
//!
//! Numbers travel as strings. `inventory.unique_id` is a 64-bit unsigned
//! integer, and a JSON number in the page would round it.
//!
//! Saving works the way `sql --write` does, and for the same reason: rAthena
//! holds characters, inventories, homunculi and pets in memory and writes them
//! back, so an edit under a running map server is lost within the minute. So
//! a save takes a backup, stops the game, applies, and starts it again. Most
//! of rAthena's tables are MyISAM, where a transaction rolls nothing back, so
//! a save that fails part-way is undone by loading that backup again: the
//! game is stopped and the operation lock is held, so nothing else can have
//! written in between.

use crate::config::Config;
use crate::docker::Docker;
use crate::json::{self, Value};
use std::collections::BTreeMap;
use std::io::{self, Read};

/// A page of rows is at most this many; the page asks for 100 by default.
const MAX_PAGE: u64 = 1000;
/// One save is at most this many changes.
const MAX_CHANGES: usize = 5000;
const MAX_REQUEST: usize = 4 * 1024 * 1024;
const MAX_RAW_WHERE: usize = 4096;

pub fn run(cfg: &Config, dk: &Docker, args: &[String]) -> Result<(), String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    if !matches!(action, "tables" | "describe" | "rows" | "apply") {
        return Err("db needs one of: tables, describe <table>, rows, apply (a JSON request on stdin for the last two)".into());
    }
    // The database actually mounted, not the one settings prefer: they
    // disagree after a failed era switch.
    crate::accounts::verify_era(cfg, dk, crate::service_credentials::era(cfg))
        .map_err(|e| if e.contains("Start this era") { "The game server is not running. Press Play in Ragnarok Offline, then try again.".to_string() } else { e })?;
    dk.require_private_sql()?;
    let out = match action {
        "tables" => tables(dk)?,
        "describe" => {
            let name = args.get(1).ok_or("db describe needs a table name")?;
            describe(dk, name)?.to_json()
        }
        "rows" => rows(dk, &request()?)?,
        _ => apply(cfg, dk, &request()?)?,
    };
    println!("{out}");
    Ok(())
}

fn request() -> Result<Value, String> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_REQUEST as u64 + 1)
        .read_to_string(&mut input)
        .map_err(|e| format!("reading the request: {e}"))?;
    if input.len() > MAX_REQUEST {
        return Err("That request is too large. Save fewer changes at a time.".into());
    }
    json::parse(&input).map_err(|e| format!("The request is not valid JSON: {e}"))
}

// ---- Reading the schema

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    /// `int(11) unsigned`, `varchar(30)`, `enum('M','F')`: for showing.
    pub column_type: String,
    /// `int`, `varchar`, `enum`: for deciding how a value is written.
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub auto_increment: bool,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
}

impl Table {
    fn column(&self, name: &str) -> Result<&Column, String> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| format!("`{}` has no column called {name}", self.name))
    }

    fn to_json(&self) -> String {
        let columns: Vec<String> = self
            .columns
            .iter()
            .map(|c| {
                format!(
                    "{{\"name\":{},\"type\":{},\"dataType\":{},\"nullable\":{},\"default\":{},\"autoIncrement\":{},\"numeric\":{},\"primary\":{}}}",
                    json::quote(&c.name),
                    json::quote(&c.column_type),
                    json::quote(&c.data_type),
                    c.nullable,
                    c.default.as_deref().map(json::quote).unwrap_or_else(|| "null".into()),
                    c.auto_increment,
                    kind(&c.data_type) == Kind::Number,
                    self.primary_key.contains(&c.name),
                )
            })
            .collect();
        let key: Vec<String> = self.primary_key.iter().map(|k| json::quote(k)).collect();
        format!(
            "{{\"table\":{},\"columns\":[{}],\"primaryKey\":[{}]}}",
            json::quote(&self.name),
            columns.join(","),
            key.join(",")
        )
    }
}

/// How a column's values are written into a statement.
#[derive(Debug, PartialEq, Clone, Copy)]
enum Kind {
    /// Inlined after checking it is a number and nothing else.
    Number,
    /// `X'...'`: the bytes as given, into the column's own encoding.
    Bytes,
    /// Dates, enums, sets: `CONVERT(X'...' USING utf8mb4)`, so the server
    /// parses them as text.
    Text,
}

fn kind(data_type: &str) -> Kind {
    match data_type.to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal" | "numeric" | "float"
        | "double" | "real" | "year" | "bit" => Kind::Number,
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "binary" | "varbinary"
        | "tinyblob" | "blob" | "mediumblob" | "longblob" => Kind::Bytes,
        _ => Kind::Text,
    }
}

/// A table or column name, checked before it goes anywhere near a statement.
/// rAthena's are all letters, digits and underscores.
fn ident(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("{name:?} is not a table or column name this tool can use"));
    }
    Ok(format!("`{name}`"))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not hex".into());
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string())).collect()
}

/// A `HEX(...)` field of mariadb's batch output: `NULL`, or the value's bytes.
pub(crate) fn field(text: &str) -> Result<Option<Vec<u8>>, String> {
    if text == "NULL" {
        return Ok(None);
    }
    unhex(text).map(Some).map_err(|_| "The database answered in a form this tool does not read".to_string())
}

pub(crate) fn field_text(text: &str) -> Result<Option<String>, String> {
    Ok(field(text)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

/// A cell, as the page gets it: text when it is UTF-8, hex when it is not.
pub(crate) fn cell_json(value: Option<&[u8]>) -> String {
    match value {
        None => "null".into(),
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => json::quote(text),
            Err(_) => format!("{{\"hex\":\"{}\"}}", hex(bytes)),
        },
    }
}

/// Rows of mariadb `--batch --skip-column-names` output.
pub(crate) fn lines(output: &str) -> impl Iterator<Item = Vec<&str>> {
    output.lines().filter(|l| !l.is_empty()).map(|l| l.split('\t').collect())
}

fn tables(dk: &Docker) -> Result<String, String> {
    let sql = "SELECT 't', HEX(TABLE_NAME), IFNULL(TABLE_ROWS, 0), HEX(IFNULL(ENGINE, '')) FROM information_schema.TABLES \
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;\n\
               SELECT 'k', HEX(TABLE_NAME), HEX(COLUMN_NAME) FROM information_schema.STATISTICS \
               WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX;\n";
    let output = dk.tool_sql(sql)?;
    let mut order = Vec::new();
    let mut info: BTreeMap<String, (String, String, Vec<String>)> = BTreeMap::new();
    for (n, row) in lines(&output).enumerate() {
        match row.as_slice() {
            ["t", name, count, engine] => {
                let name = field_text(name)?.unwrap_or_default();
                order.push(name.clone());
                info.insert(name, (count.to_string(), field_text(engine)?.unwrap_or_default(), Vec::new()));
            }
            ["k", name, column] => {
                if let Some(entry) = info.get_mut(&field_text(name)?.unwrap_or_default()) {
                    entry.2.push(field_text(column)?.unwrap_or_default());
                }
            }
            _ => return Err(unreadable(n, "a line of the table list is neither a table nor a key")),
        }
    }
    let items: Vec<String> = order
        .iter()
        .filter(|name| ident(name).is_ok())
        .map(|name| {
            let (rows, engine, key) = &info[name];
            let rows: u64 = rows.parse().unwrap_or(0);
            let key: Vec<String> = key.iter().map(|k| json::quote(k)).collect();
            format!(
                "{{\"name\":{},\"rows\":{rows},\"engine\":{},\"primaryKey\":[{}]}}",
                json::quote(name),
                json::quote(engine),
                key.join(",")
            )
        })
        .collect();
    Ok(format!("{{\"database\":\"ragnarok\",\"tables\":[{}]}}", items.join(",")))
}

pub fn describe(dk: &Docker, name: &str) -> Result<Table, String> {
    ident(name)?;
    let quoted = format!("X'{}'", hex(name.as_bytes()));
    let sql = format!(
        "SELECT 'c', HEX(COLUMN_NAME), HEX(COLUMN_TYPE), HEX(DATA_TYPE), IS_NULLABLE, HEX(COLUMN_DEFAULT), HEX(EXTRA) \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {quoted} ORDER BY ORDINAL_POSITION;\n\
         SELECT 'k', HEX(COLUMN_NAME) FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {quoted} AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX;\n"
    );
    parse_describe(name, &dk.tool_sql(&sql)?)
}

fn parse_describe(name: &str, output: &str) -> Result<Table, String> {
    let mut table = Table { name: name.to_string(), columns: Vec::new(), primary_key: Vec::new() };
    for (n, row) in lines(output).enumerate() {
        match row.as_slice() {
            ["c", column, column_type, data_type, nullable, default, extra] => {
                let column = field_text(column)?.unwrap_or_default();
                // Checked here, once: every later use of a column name comes
                // from this list.
                ident(&column)?;
                table.columns.push(Column {
                    name: column,
                    column_type: field_text(column_type)?.unwrap_or_default(),
                    data_type: field_text(data_type)?.unwrap_or_default(),
                    nullable: *nullable == "YES",
                    default: field_text(default)?,
                    auto_increment: field_text(extra)?.unwrap_or_default().to_ascii_lowercase().contains("auto_increment"),
                });
            }
            ["k", column] => table.primary_key.push(field_text(column)?.unwrap_or_default()),
            _ => return Err(unreadable(n, "a line of the column list is neither a column nor a key")),
        }
    }
    if table.columns.is_empty() {
        return Err(format!("There is no table called {name}"));
    }
    Ok(table)
}

// ---- Values

/// A value from the page: `null`, a string, or `{"hex": "..."}` for bytes
/// that are not UTF-8. Numbers come as strings; a JSON number is taken too,
/// when it is a whole one that survived the trip.
fn value_bytes(value: &Value) -> Result<Option<Vec<u8>>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.as_bytes().to_vec())),
        Value::Number(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => Ok(Some(format!("{}", *n as i64).into_bytes())),
        Value::Object(_) => match value.str("hex") {
            Some(h) => unhex(h).map(Some).map_err(|_| "A binary value is not valid hex".to_string()),
            None => Err("A value must be text, null, or {\"hex\": ...}".into()),
        },
        other => Err(format!("A value must be text or null, not {other}")),
    }
}

/// A plain decimal number, and nothing a statement could be hidden in.
fn is_number(text: &str) -> bool {
    let body = text.strip_prefix('-').or_else(|| text.strip_prefix('+')).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match fraction {
        None => digits(whole),
        Some(f) => (digits(whole) || whole.is_empty()) && (digits(f) || (f.is_empty() && digits(whole))),
    };
    let exponent_ok = match exponent {
        None => true,
        Some(e) => digits(e.strip_prefix('-').or_else(|| e.strip_prefix('+')).unwrap_or(e)),
    };
    mantissa_ok && exponent_ok && text.len() <= 80
}

/// A value as a SQL literal for `column`.
pub fn literal(column: &Column, value: &Value) -> Result<String, String> {
    let Some(bytes) = value_bytes(value)? else {
        if column.nullable {
            return Ok("NULL".into());
        }
        return Err(format!("{} cannot be empty (NULL)", column.name));
    };
    Ok(match kind(&column.data_type) {
        Kind::Number => {
            let text = String::from_utf8(bytes).unwrap_or_default();
            let text = text.trim();
            if !is_number(text) {
                return Err(format!("{} takes a number, and {text:?} is not one", column.name));
            }
            text.to_string()
        }
        Kind::Bytes => format!("X'{}'", hex(&bytes)),
        Kind::Text => format!("CONVERT(X'{}' USING utf8mb4)", hex(&bytes)),
    })
}

/// `a = ... AND b = ...` for a row's primary key. Exact: the literals are
/// bytes, so the comparison is too.
fn key_condition(table: &Table, key: &Value) -> Result<String, String> {
    if table.primary_key.is_empty() {
        return Err(format!("`{}` has no primary key, so its rows cannot be told apart to be edited", table.name));
    }
    let Value::Object(given) = key else {
        return Err("A change needs its row's key as an object".into());
    };
    if given.len() != table.primary_key.len() {
        return Err(format!("A change to `{}` must name its row by {}", table.name, table.primary_key.join(", ")));
    }
    let mut parts = Vec::new();
    for name in &table.primary_key {
        let column = table.column(name)?;
        let value = given.get(name).ok_or_else(|| format!("A change to `{}` must name its row by {}", table.name, table.primary_key.join(", ")))?;
        if matches!(value, Value::Null) {
            return Err(format!("{name} is part of the key and cannot be empty"));
        }
        parts.push(format!("{} = {}", ident(name)?, literal(column, value)?));
    }
    Ok(parts.join(" AND "))
}

fn key_label(key: &Value) -> String {
    match key {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| match value_bytes(v) {
                Ok(Some(b)) => format!("{k}={}", String::from_utf8_lossy(&b)),
                _ => format!("{k}=?"),
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => "?".into(),
    }
}

// ---- Rows

/// What reads a column's value out, hex-encoded: the stored bytes for text,
/// the value as text for everything else.
fn select_expr(column: &Column) -> String {
    let name = format!("`{}`", column.name);
    match (kind(&column.data_type), column.data_type.to_ascii_lowercase().as_str()) {
        (Kind::Bytes, _) => format!("HEX({name})"),
        (_, "bit") => format!("HEX(CAST({name} + 0 AS CHAR))"),
        _ => format!("HEX(CAST({name} AS CHAR))"),
    }
}

/// One of the simple filters: `name contains Agent`, `class = 4252`.
fn filter_condition(table: &Table, filter: &Value) -> Result<String, String> {
    let column = table.column(filter.str("column").ok_or("A filter needs a column")?)?;
    let name = ident(&column.name)?;
    let op = filter.str("op").ok_or("A filter needs an operator")?;
    let value = filter.get("value").cloned().unwrap_or(Value::Null);
    // Filters compare as text, case-insensitively, the way someone searching
    // expects; a number column compares as a number.
    let text = |v: &Value| -> Result<String, String> {
        let bytes = value_bytes(v)?.unwrap_or_default();
        Ok(format!("CONVERT(X'{}' USING utf8mb4)", hex(&bytes)))
    };
    let operand = |v: &Value| -> Result<String, String> {
        if kind(&column.data_type) == Kind::Number {
            let bytes = value_bytes(v)?.unwrap_or_default();
            let t = String::from_utf8(bytes).unwrap_or_default();
            let t = t.trim();
            if !is_number(t) {
                return Err(format!("{} is a number column, and {t:?} is not a number", column.name));
            }
            Ok(t.to_string())
        } else {
            text(v)
        }
    };
    let like = |prefix: &str, suffix: &str| -> Result<String, String> {
        let raw = String::from_utf8(value_bytes(&value)?.unwrap_or_default()).unwrap_or_default();
        let escaped: String = raw.chars().flat_map(|c| if matches!(c, '\\' | '%' | '_') { vec!['\\', c] } else { vec![c] }).collect();
        Ok(format!(
            "CAST({name} AS CHAR) LIKE CONVERT(X'{}' USING utf8mb4)",
            hex(format!("{prefix}{escaped}{suffix}").as_bytes())
        ))
    };
    Ok(match op {
        "=" | "!=" | "<" | "<=" | ">" | ">=" => {
            let sql_op = if op == "!=" { "<>" } else { op };
            format!("{name} {sql_op} {}", operand(&value)?)
        }
        "contains" => like("%", "%")?,
        "starts" => like("", "%")?,
        "ends" => like("%", "")?,
        "null" => format!("{name} IS NULL"),
        "notnull" => format!("{name} IS NOT NULL"),
        other => return Err(format!("Unknown filter {other:?}")),
    })
}

/// The advanced filter: a raw `WHERE` typed by the player. It is placed
/// inside parentheses in a read-only transaction, and it has to stay there:
/// no `;`, no comment that could swallow the closing parenthesis, no
/// unbalanced parentheses, no unterminated string. The assembled script is
/// then checked statement by statement, so a condition that somehow became a
/// second statement is refused rather than run.
fn check_raw_where(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_RAW_WHERE {
        return Err("That WHERE is too long".into());
    }
    let refuse = |why: &str| Err(format!("The WHERE condition was not run: {why}"));
    let chars: Vec<char> = raw.chars().collect();
    let mut depth: i32 = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                loop {
                    let Some(&d) = chars.get(i) else { return refuse("a quote is not closed") };
                    if d == '\\' && c != '`' {
                        i += 2;
                        continue;
                    }
                    if d == c {
                        if chars.get(i + 1) == Some(&c) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            ';' => return refuse("it contains `;`, and it has to be a single condition"),
            '#' => return refuse("it contains a comment"),
            '/' if chars.get(i + 1) == Some(&'*') => return refuse("it contains a comment"),
            '-' if chars.get(i + 1) == Some(&'-') => return refuse("it contains a comment"),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return refuse("its parentheses do not balance");
                }
            }
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return refuse("its parentheses do not balance");
    }
    Ok(())
}

pub struct RowsQuery {
    pub sql: String,
}

/// The read script for one page of rows, and its count.
pub fn rows_query(table: &Table, request: &Value) -> Result<RowsQuery, String> {
    let from = ident(&table.name)?;
    let mut conditions = Vec::new();
    if let Some(Value::Array(filters)) = request.get("filters") {
        for filter in filters {
            conditions.push(format!("({})", filter_condition(table, filter)?));
        }
    }
    if let Some(raw) = request.str("where") {
        if !raw.trim().is_empty() {
            check_raw_where(raw)?;
            conditions.push(format!("(\n{raw}\n)"));
        }
    }
    let condition = if conditions.is_empty() { String::new() } else { format!(" WHERE {}", conditions.join(" AND ")) };
    let number = |key: &str, default: u64| -> Result<u64, String> {
        match request.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => Ok(*n as u64),
            Some(_) => Err(format!("{key} must be a whole number")),
        }
    };
    let limit = number("limit", 100)?.clamp(1, MAX_PAGE);
    let offset = number("offset", 0)?;
    let mut order = String::new();
    if let Some(column) = request.str("orderBy").filter(|c| !c.is_empty()) {
        let column = table.column(column)?;
        let direction = if matches!(request.get("desc"), Some(Value::Bool(true))) { "DESC" } else { "ASC" };
        order = format!(" ORDER BY {} {direction}", ident(&column.name)?);
    }
    // After the chosen order, the key: a stable order, so paging neither
    // repeats nor skips a row.
    let keyed: Vec<String> = table.primary_key.iter().filter_map(|k| ident(k).ok()).collect();
    if !keyed.is_empty() {
        order = if order.is_empty() { format!(" ORDER BY {}", keyed.join(", ")) } else { format!("{order}, {}", keyed.join(", ")) };
    }
    let columns: Vec<String> = table.columns.iter().map(select_expr).collect();
    let sql = format!(
        "START TRANSACTION READ ONLY;\n\
         SELECT 'c', COUNT(*) FROM {from}{condition};\n\
         SELECT 'r', {} FROM {from}{condition}{order} LIMIT {limit} OFFSET {offset};\n\
         ROLLBACK;\n",
        columns.join(", ")
    );
    // Four statements in, four statements out: nothing in the condition
    // became a fifth.
    let words: Vec<String> = crate::cmds::leading_words(&sql).into_iter().map(|w| w.to_ascii_uppercase()).collect();
    if words != ["START", "SELECT", "SELECT", "ROLLBACK"] {
        return Err("The WHERE condition was not run: it does not read as a single condition".into());
    }
    Ok(RowsQuery { sql })
}

fn rows(dk: &Docker, request: &Value) -> Result<String, String> {
    let table = describe(dk, request.str("table").ok_or("Which table?")?)?;
    let query = rows_query(&table, request)?;
    let output = dk.tool_sql(&query.sql).map_err(|e| format!("The database refused that: {}", db_error(&e)))?;
    parse_rows(&table, &output)
}

/// A page of rows, from the `c` (count) and `r` (row) lines of the read
/// script, as the JSON the page gets.
pub fn parse_rows(table: &Table, output: &str) -> Result<String, String> {
    let mut total = None;
    let mut out_rows = Vec::new();
    for (n, row) in lines(output).enumerate() {
        match row.first() {
            Some(&"c") if row.len() == 2 => total = Some(row[1].parse::<u64>().map_err(|_| unreadable(n, "its row count is not a number"))?),
            Some(&"r") if row.len() == table.columns.len() + 1 => {
                let cells: Result<Vec<String>, String> =
                    row[1..].iter().map(|v| field(v).map(|b| cell_json(b.as_deref()))).collect();
                out_rows.push(format!("[{}]", cells.map_err(|_| unreadable(n, "a value is not in the encoding asked for"))?.join(",")));
            }
            Some(&"r") => {
                return Err(unreadable(n, &format!("a row has {} values, and `{}` has {} columns", row.len() - 1, table.name, table.columns.len())))
            }
            _ => return Err(unreadable(n, "a line is neither the count nor a row")),
        }
    }
    let total = total.ok_or_else(|| unreadable(0, "it has no row count"))?;
    Ok(format!("{{\"table\":{},\"total\":{total},\"rows\":[{}]}}", json::quote(&table.name), out_rows.join(",")))
}

/// The one error for an answer this tool cannot read, saying where and why,
/// so a report of it can be acted on.
pub(crate) fn unreadable(line: usize, why: &str) -> String {
    format!("The database answered in a form this tool does not read (line {}: {why})", line + 1)
}

// ---- Saving

/// One change, with its statement and what has to be true before it runs.
#[derive(Debug)]
pub struct Planned {
    pub label: String,
    pub statement: String,
    /// For an edit or a delete: the SELECT that finds the row, with the
    /// values the page last saw for the columns being changed.
    pub check: Option<(String, Vec<Option<Vec<u8>>>)>,
    /// For an insert that names its whole key: the row must not exist yet.
    pub absent: Option<String>,
}

/// Build every statement of a save from the change list. Nothing here runs
/// anything; it is the part the tests read.
pub fn plan(tables: &BTreeMap<String, Table>, changes: &[Value]) -> Result<Vec<Planned>, String> {
    let mut out = Vec::new();
    for (n, change) in changes.iter().enumerate() {
        let which = |e: String| format!("Change {} of {}: {e}", n + 1, changes.len());
        let name = change.str("table").ok_or_else(|| which("it names no table".into()))?;
        let table = tables.get(name).ok_or_else(|| which(format!("there is no table called {name}")))?;
        let from = ident(&table.name)?;
        if let Some(values) = change.get("insert") {
            let Value::Object(values) = values else { return Err(which("insert must be an object".into())) };
            if values.is_empty() {
                return Err(which("an added row has no values".into()));
            }
            let mut names = Vec::new();
            let mut literals = Vec::new();
            // In the table's column order, so the statement reads like the table.
            for column in &table.columns {
                if let Some(v) = values.get(&column.name) {
                    names.push(ident(&column.name)?);
                    literals.push(literal(column, v).map_err(which)?);
                }
            }
            for key in values.keys() {
                table.column(key).map_err(which)?;
            }
            // Refused here rather than by the server, which would only say so
            // after the game had been stopped.
            if let Some(missing) = table.columns.iter().find(|c| !c.nullable && c.default.is_none() && !c.auto_increment && !values.contains_key(&c.name)) {
                return Err(which(format!("an added row in {} needs a value for {}", table.name, missing.name)));
            }
            let has_key = !table.primary_key.is_empty() && table.primary_key.iter().all(|k| values.get(k).is_some_and(|v| !matches!(v, Value::Null)));
            let absent = if has_key {
                let key: BTreeMap<String, Value> = table.primary_key.iter().map(|k| (k.clone(), values[k].clone())).collect();
                Some(format!("SELECT COUNT(*) FROM {from} WHERE {}", key_condition(table, &Value::Object(key)).map_err(which)?))
            } else {
                None
            };
            let label = if has_key {
                let key: BTreeMap<String, Value> = table.primary_key.iter().map(|k| (k.clone(), values[k].clone())).collect();
                format!("new row in {} ({})", table.name, key_label(&Value::Object(key)))
            } else {
                format!("new row in {}", table.name)
            };
            out.push(Planned {
                label,
                statement: format!("INSERT INTO {from} ({}) VALUES ({});", names.join(", "), literals.join(", ")),
                check: None,
                absent,
            });
            continue;
        }
        let key = change.get("key").ok_or_else(|| which("it names no row".into()))?;
        let condition = key_condition(table, key).map_err(which)?;
        let label = format!("{} ({})", table.name, key_label(key));
        if matches!(change.get("delete"), Some(Value::Bool(true))) {
            out.push(Planned {
                label: format!("delete {label}"),
                statement: format!("DELETE FROM {from} WHERE {condition} LIMIT 1;"),
                check: Some((format!("SELECT 1 FROM {from} WHERE {condition}"), Vec::new())),
                absent: None,
            });
            continue;
        }
        let Some(Value::Object(set)) = change.get("set") else {
            return Err(which("it is not an edit, an insert or a delete".into()));
        };
        if set.is_empty() {
            return Err(which("an edit changes nothing".into()));
        }
        let mut assignments = Vec::new();
        let mut watched = Vec::new();
        let mut expected = Vec::new();
        for column in &table.columns {
            let Some(v) = set.get(&column.name) else { continue };
            if table.primary_key.contains(&column.name) {
                return Err(which(format!("{} is part of the row's key; add a new row and delete this one instead", column.name)));
            }
            assignments.push(format!("{} = {}", ident(&column.name)?, literal(column, v).map_err(which)?));
            if let Some(old) = change.get("old").and_then(|o| o.get(&column.name)) {
                watched.push(select_expr(column));
                expected.push(value_bytes(old).map_err(which)?);
            }
        }
        for key in set.keys() {
            table.column(key).map_err(which)?;
        }
        let select = if watched.is_empty() { "1".to_string() } else { watched.join(", ") };
        out.push(Planned {
            label: format!("edit {label}"),
            statement: format!("UPDATE {from} SET {} WHERE {condition} LIMIT 1;", assignments.join(", ")),
            check: Some((format!("SELECT {select} FROM {from} WHERE {condition}"), expected)),
            absent: None,
        });
    }
    Ok(out)
}

/// The save, as one script: strict, so a value that does not fit is refused
/// rather than cut short, and one statement per line, so an error's line
/// number says which change it was.
pub fn save_script(planned: &[Planned]) -> String {
    let mut script = String::from(SAVE_PREAMBLE);
    for p in planned {
        script.push_str(&p.statement);
        script.push('\n');
    }
    script.push_str("COMMIT;\n");
    script
}

const SAVE_PREAMBLE: &str = "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@sql_mode, ''), 'STRICT_ALL_TABLES');\nSTART TRANSACTION;\n";

/// What mariadb said, without the statement it echoes back: `ERROR 1054
/// (42S22) at line 2: Unknown column 'x'` becomes `Unknown column 'x'`.
pub fn db_error(error: &str) -> String {
    let Some(line) = error.lines().rev().find(|l| l.starts_with("ERROR ")) else { return error.trim().to_string() };
    match line.find(": ") {
        Some(i) => line[i + 2..].trim().to_string(),
        None => line.trim().to_string(),
    }
}

/// Which change a mariadb error names, from its `at line N`.
pub fn failed_change(error: &str, count: usize) -> Option<usize> {
    let rest = &error[error.find(" at line ")? + " at line ".len()..];
    let line: usize = rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    let first = SAVE_PREAMBLE.lines().count() + 1;
    (line >= first && line < first + count).then(|| line - first)
}

/// Everything that can be checked before anything is stopped or written:
/// each edited or deleted row is there, still holds what the page showed, and
/// each added row's key is free.
fn preflight(dk: &Docker, planned: &[Planned]) -> Result<(), String> {
    let mut script = String::new();
    for (i, p) in planned.iter().enumerate() {
        if let Some((select, _)) = &p.check {
            script.push_str(&format!("SELECT {i}, x.* FROM ({select} LIMIT 2) AS x;\n"));
        }
        if let Some(select) = &p.absent {
            script.push_str(&format!("SELECT {i}, ({select}) AS n;\n"));
        }
    }
    if script.is_empty() {
        return Ok(());
    }
    let output = dk.tool_sql(&script).map_err(|e| format!("Nothing was saved: checking the rows failed: {}", db_error(&e)))?;
    let mut seen: BTreeMap<usize, Vec<Vec<String>>> = BTreeMap::new();
    for (n, row) in lines(&output).enumerate() {
        let i: usize = row[0].parse().map_err(|_| format!("Nothing was saved: {}", unreadable(n, "a check names no change")))?;
        seen.entry(i).or_default().push(row[1..].iter().map(|s| s.to_string()).collect());
    }
    for (i, p) in planned.iter().enumerate() {
        let found = seen.get(&i).map(Vec::as_slice).unwrap_or(&[]);
        if let Some((_, expected)) = &p.check {
            if found.len() != 1 {
                return Err(format!("Nothing was saved: {} is no longer there. Reload and try again.", p.label));
            }
            if !expected.is_empty() {
                let now: Result<Vec<Option<Vec<u8>>>, String> = found[0].iter().map(|v| field(v)).collect();
                if &now.map_err(|e| format!("Nothing was saved: {e}"))? != expected {
                    return Err(format!(
                        "Nothing was saved: {} changed since it was loaded (the game may have saved over it). Reload and try again.",
                        p.label
                    ));
                }
            }
        }
        if p.absent.is_some() && found.first().and_then(|r| r.first()).map(String::as_str) != Some("0") {
            return Err(format!("Nothing was saved: {} already exists.", p.label));
        }
    }
    Ok(())
}

fn apply(cfg: &Config, dk: &Docker, request: &Value) -> Result<String, String> {
    let Some(Value::Array(changes)) = request.get("changes") else {
        return Err("A save needs a list of changes".into());
    };
    if changes.is_empty() {
        return Err("There is nothing to save".into());
    }
    if changes.len() > MAX_CHANGES {
        return Err(format!("That is {} changes; save at most {MAX_CHANGES} at a time.", changes.len()));
    }
    let mut tables = BTreeMap::new();
    for change in changes {
        if let Some(name) = change.str("table") {
            if !tables.contains_key(name) {
                tables.insert(name.to_string(), describe(dk, name)?);
            }
        }
    }
    let planned = plan(&tables, changes)?;
    let script = save_script(&planned);
    if script.len() > crate::docker::TOOL_SQL_LIMIT {
        return Err("That save is too large. Save fewer changes at a time.".into());
    }
    // Checked once before anything is stopped, so a stale page is refused
    // without disconnecting anybody, and again once the game is stopped,
    // since it may have saved in between.
    preflight(dk, &planned)?;
    let era = crate::service_credentials::era(cfg);
    let backup = cfg.state.join("backups").join(format!("before-db-browser-{era}-{}.sql", crate::private_fs::random_hex(8)?));
    let saved = std::cell::Cell::new(false);
    crate::accounts::with_servers_stopped(cfg, dk, "save", || {
        crate::cmds::backup_snapshot(cfg, dk, &backup.to_string_lossy(), false)
            .map_err(|e| format!("Nothing was saved: the backup taken before saving failed: {e}"))?;
        preflight(dk, &planned)?;
        if let Err(raw) = dk.tool_sql(&script) {
            let error = db_error(&raw);
            let which = failed_change(&raw, planned.len())
                .map(|i| format!("{} failed", planned[i].label))
                .unwrap_or_else(|| "The save failed".into());
            let undone = crate::cmds::load_dump(cfg, dk, &backup);
            return Err(match undone {
                Ok(()) => format!("{which}: {error}. Nothing was saved: the database was put back as it was."),
                Err(e) => format!(
                    "{which}: {error}. Putting the database back failed too ({e}); restore {} from Settings before playing.",
                    backup.display()
                ),
            });
        }
        saved.set(true);
        Ok(())
    })
    .map_err(|e| {
        // Saved, but the game did not come back: say that it was saved, or
        // the page keeps the changes staged and a retry fails on rows that
        // are already gone.
        if saved.get() {
            format!("Saved: your changes are in the database (backup: {}). {e}", backup.display())
        } else {
            e
        }
    })?;
    Ok(format!("{{\"applied\":{},\"backup\":{}}}", planned.len(), json::quote(&backup.to_string_lossy())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str, nullable: bool) -> Column {
        Column { name: name.into(), column_type: data_type.into(), data_type: data_type.into(), nullable, default: None, auto_increment: false }
    }

    fn char_table() -> Table {
        Table {
            name: "char".into(),
            columns: vec![
                col("char_id", "int", false),
                col("name", "varchar", false),
                col("zeny", "int", false),
                col("sex", "enum", false),
                col("delete_date", "int", true),
            ],
            primary_key: vec!["char_id".into()],
        }
    }

    fn tables() -> BTreeMap<String, Table> {
        let mut t = BTreeMap::new();
        t.insert("char".to_string(), char_table());
        t.insert(
            "mapreg".to_string(),
            Table { name: "mapreg".into(), columns: vec![col("varname", "varchar", false), col("value", "varchar", false)], primary_key: vec![] },
        );
        t
    }

    fn changes(src: &str) -> Vec<Value> {
        match json::parse(src).unwrap() {
            Value::Array(v) => v,
            _ => panic!(),
        }
    }

    #[test]
    fn text_is_written_as_bytes_and_never_as_sql() {
        let name = col("name", "varchar", false);
        let attack = "x'; DROP TABLE `char`; -- \\";
        let sql = literal(&name, &Value::String(attack.into())).unwrap();
        assert_eq!(sql, format!("X'{}'", hex(attack.as_bytes())));
        assert!(sql[2..sql.len() - 1].bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(literal(&name, &Value::String(String::new())).unwrap(), "X''");
        // Korean, and bytes that are not UTF-8, go through untouched.
        assert_eq!(literal(&name, &Value::String("포링".into())).unwrap(), format!("X'{}'", hex("포링".as_bytes())));
        let raw = json::parse(r#"{"hex":"B0A1FF"}"#).unwrap();
        assert_eq!(literal(&name, &raw).unwrap(), "X'B0A1FF'");
        assert!(literal(&name, &json::parse(r#"{"hex":"B0'"}"#).unwrap()).is_err());
    }

    #[test]
    fn numbers_are_checked_and_nothing_else_gets_inlined() {
        let zeny = col("zeny", "int", false);
        for ok in ["0", "-5", "18446744073709551615", "1.5", "2e3", " 42 "] {
            assert!(literal(&zeny, &Value::String(ok.into())).is_ok(), "{ok}");
        }
        for bad in ["", "1 OR 1=1", "0x10", "1;", "--1", "1e", ".", "abc", "1,2"] {
            assert!(literal(&zeny, &Value::String(bad.into())).is_err(), "{bad}");
        }
        // A 64-bit id stays exact as a string.
        assert_eq!(literal(&col("unique_id", "bigint", false), &Value::String("18446744073709551615".into())).unwrap(), "18446744073709551615");
    }

    #[test]
    fn null_only_where_the_column_allows_it() {
        assert_eq!(literal(&col("delete_date", "int", true), &Value::Null).unwrap(), "NULL");
        assert!(literal(&col("zeny", "int", false), &Value::Null).is_err());
    }

    #[test]
    fn dates_and_enums_are_parsed_by_the_server_as_text() {
        assert_eq!(literal(&col("sex", "enum", false), &Value::String("M".into())).unwrap(), "CONVERT(X'4D' USING utf8mb4)");
    }

    #[test]
    fn an_edit_a_delete_and_an_insert_become_one_statement_each() {
        let planned = plan(
            &tables(),
            &changes(r#"[
                {"table":"char","key":{"char_id":"150000"},"set":{"zeny":"1000","name":"Bob'"},"old":{"zeny":"5","name":"Bob"}},
                {"table":"char","key":{"char_id":"150001"},"delete":true},
                {"table":"char","insert":{"char_id":"150002","name":"New","zeny":"0","sex":"F"}}
            ]"#),
        )
        .unwrap();
        assert_eq!(planned.len(), 3);
        assert_eq!(planned[0].statement, format!("UPDATE `char` SET `name` = X'{}', `zeny` = 1000 WHERE `char_id` = 150000 LIMIT 1;", hex(b"Bob'")));
        let (check, expected) = planned[0].check.as_ref().unwrap();
        assert!(check.starts_with("SELECT HEX(`name`), HEX(CAST(`zeny` AS CHAR)) FROM `char` WHERE `char_id` = 150000"), "{check}");
        assert_eq!(expected, &vec![Some(b"Bob".to_vec()), Some(b"5".to_vec())]);
        assert_eq!(planned[1].statement, "DELETE FROM `char` WHERE `char_id` = 150001 LIMIT 1;");
        assert_eq!(
            planned[2].statement,
            format!("INSERT INTO `char` (`char_id`, `name`, `zeny`, `sex`) VALUES (150002, X'{}', 0, CONVERT(X'46' USING utf8mb4));", hex(b"New"))
        );
        assert!(planned[2].absent.as_deref().unwrap().ends_with("WHERE `char_id` = 150002"));
        let script = save_script(&planned);
        assert!(script.starts_with(SAVE_PREAMBLE) && script.ends_with("COMMIT;\n"));
        // No statement spans lines, so a line number names a change.
        assert_eq!(script.lines().count(), SAVE_PREAMBLE.lines().count() + 3 + 1);
    }

    #[test]
    fn names_that_are_not_the_tables_own_are_refused() {
        let bad = [
            r#"[{"table":"char; DROP","key":{"char_id":"1"},"delete":true}]"#,
            r#"[{"table":"char","key":{"char_id":"1"},"set":{"zeny`=1,`name":"x"}}]"#,
            r#"[{"table":"char","key":{"char_id":"1"},"set":{"no_such":"x"}}]"#,
            r#"[{"table":"char","insert":{"char_id":"1","evil`":"x"}}]"#,
            r#"[{"table":"char","key":{"name":"x"},"delete":true}]"#,
            r#"[{"table":"char","key":{"char_id":"1"},"set":{"char_id":"2"}}]"#,
            r#"[{"table":"char","key":{"char_id":"1 OR 1=1"},"delete":true}]"#,
            r#"[{"table":"char","key":{"char_id":"1"},"set":{}}]"#,
            r#"[{"table":"char","key":{"char_id":"1"}}]"#,
        ];
        for src in bad {
            assert!(plan(&tables(), &changes(src)).is_err(), "{src}");
        }
    }

    #[test]
    fn a_table_without_a_primary_key_cannot_be_edited() {
        let err = plan(&tables(), &changes(r#"[{"table":"mapreg","key":{},"set":{"value":"1"}}]"#)).unwrap_err();
        assert!(err.contains("no primary key"), "{err}");
        // It can still be added to.
        assert!(plan(&tables(), &changes(r#"[{"table":"mapreg","insert":{"varname":"a","value":"1"}}]"#)).is_ok());
    }

    #[test]
    fn an_added_row_must_fill_every_column_that_has_no_default() {
        let err = plan(&tables(), &changes(r#"[{"table":"char","insert":{"char_id":"1","name":"x"}}]"#)).unwrap_err();
        assert!(err.contains("needs a value for zeny"), "{err}");
        // A nullable column and an automatic key can be left out.
        let mut t = tables();
        t.get_mut("char").unwrap().columns[0].auto_increment = true;
        assert!(plan(&t, &changes(r#"[{"table":"char","insert":{"name":"x","zeny":"0","sex":"M"}}]"#)).is_ok());
    }

    #[test]
    fn an_error_line_names_its_change() {
        let first = SAVE_PREAMBLE.lines().count() + 1;
        assert_eq!(failed_change(&format!("ERROR 1406 (22001) at line {first}: Data too long"), 3), Some(0));
        assert_eq!(failed_change(&format!("ERROR 1062 (23000) at line {}: Duplicate entry", first + 2), 3), Some(2));
        assert_eq!(failed_change("ERROR 1 (x) at line 1: no", 3), None);
        assert_eq!(failed_change(&format!("ERROR at line {}: commit", first + 3), 3), None);
        assert_eq!(failed_change("something else", 3), None);
        let echoed = "--------------\nUPDATE `char` SET ...\n--------------\n\nERROR 1406 (22001) at line 3: Data too long for column 'name' at row 1";
        assert_eq!(db_error(echoed), "Data too long for column 'name' at row 1");
        assert_eq!(failed_change(echoed, 1), Some(0));
    }

    #[test]
    fn filters_build_conditions_from_the_tables_own_columns() {
        let t = char_table();
        let q = rows_query(&t, &json::parse(r#"{"filters":[{"column":"name","op":"contains","value":"Ag%ent"},{"column":"zeny","op":">=","value":"100"}],"orderBy":"zeny","desc":true,"limit":50,"offset":100}"#).unwrap()).unwrap();
        assert!(q.sql.contains(&format!("CAST(`name` AS CHAR) LIKE CONVERT(X'{}' USING utf8mb4)", hex(b"%Ag\\%ent%"))), "{}", q.sql);
        assert!(q.sql.contains("(`zeny` >= 100)"), "{}", q.sql);
        assert!(q.sql.contains("ORDER BY `zeny` DESC, `char_id` LIMIT 50 OFFSET 100"), "{}", q.sql);
        assert!(q.sql.starts_with("START TRANSACTION READ ONLY;"));
        for bad in [
            r#"{"filters":[{"column":"zeny","op":"=","value":"1 OR 1=1"}]}"#,
            r#"{"filters":[{"column":"nope","op":"=","value":"1"}]}"#,
            r#"{"filters":[{"column":"name","op":"; DROP","value":"1"}]}"#,
            r#"{"orderBy":"zeny; DROP"}"#,
            r#"{"limit":-1}"#,
        ] {
            assert!(rows_query(&t, &json::parse(bad).unwrap()).is_err(), "{bad}");
        }
        // A page is bounded whatever is asked for.
        let big = rows_query(&t, &json::parse(r#"{"limit":1000000}"#).unwrap()).unwrap();
        assert!(big.sql.contains(&format!("LIMIT {MAX_PAGE} ")), "{}", big.sql);
    }

    #[test]
    fn a_raw_where_stays_a_single_condition() {
        let t = char_table();
        let q = |w: &str| rows_query(&t, &Value::Object(BTreeMap::from([("where".to_string(), Value::String(w.into()))])));
        for ok in ["zeny > 100 AND name LIKE 'A%'", "name = 'semi;colon'", "(a = 1) OR (b = 2)", "name = 'it''s'", "class IN (SELECT 1)"] {
            assert!(q(ok).is_ok(), "{ok}");
        }
        for bad in [
            "1); DROP TABLE `char`; SELECT (1",
            "1) UNION SELECT * FROM login -- ",
            "1 -- ",
            "1 # x",
            "1 /*! ; DELETE FROM login */",
            "name = 'unterminated",
            "1)",
            "(1",
            "1; UPDATE `char` SET zeny = 0",
        ] {
            assert!(q(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn describe_output_is_read_back_from_hex() {
        let out = format!(
            "c\t{}\t{}\t{}\tNO\tNULL\t{}\nc\t{}\t{}\t{}\tYES\t{}\t\nk\t{}\n",
            hex(b"char_id"), hex(b"int(11) unsigned"), hex(b"int"), hex(b"auto_increment"),
            hex(b"name"), hex(b"varchar(30)"), hex(b"varchar"), hex(b""),
            hex(b"char_id")
        );
        let t = parse_describe("char", &out).unwrap();
        assert_eq!(t.primary_key, ["char_id"]);
        assert!(t.columns[0].auto_increment && !t.columns[0].nullable && t.columns[0].default.is_none());
        assert_eq!(t.columns[1].default.as_deref(), Some(""));
        assert!(t.to_json().contains("\"primaryKey\":[\"char_id\"]"));
        assert!(parse_describe("nope", "").is_err());
        // A column name this tool cannot quote safely is refused, not used.
        assert!(parse_describe("x", &format!("c\t{}\t{}\t{}\tNO\tNULL\t\n", hex(b"a`b"), hex(b"int"), hex(b"int"))).is_err());
    }

    #[test]
    fn cells_are_text_when_they_can_be_and_hex_when_they_cannot() {
        assert_eq!(cell_json(None), "null");
        assert_eq!(cell_json(Some(b"a\tb\n\"")), "\"a\\u0009b\\u000a\\\"\"");
        assert_eq!(cell_json(Some(&[0xB0, 0xA1])), "{\"hex\":\"B0A1\"}");
        assert_eq!(field("NULL").unwrap(), None);
        assert_eq!(field("").unwrap(), Some(vec![]));
        assert!(field("ZZ").is_err());
    }

    // ---- The `char` table, as rAthena creates it (#200 follow-up)

    /// rAthena's `char` table, read from its CREATE TABLE the way `describe`
    /// would read it from information_schema.
    pub(crate) fn rathena_char() -> Table {
        let sql = include_str!("../../tests/fixtures/rathena-char-table.sql");
        let mut columns = Vec::new();
        for line in sql.lines().filter(|l| l.starts_with("  `")) {
            let (name, rest) = line[3..].split_once('`').unwrap();
            let rest = rest.trim();
            let lower = rest.to_ascii_lowercase();
            let type_word = lower.split_whitespace().next().unwrap();
            let data_type = type_word.split('(').next().unwrap().to_string();
            let column_type = if lower.contains(" unsigned") { format!("{type_word} unsigned") } else { type_word.to_string() };
            let default = lower.find("default ").map(|i| {
                let d = &rest[i + "default ".len()..];
                let d = d.trim_end_matches(',');
                d.trim_matches('\'').to_string()
            });
            columns.push(Column {
                name: name.to_string(),
                column_type,
                data_type,
                nullable: !lower.contains("not null"),
                default: default.filter(|d| d != "NULL"),
                auto_increment: lower.contains("auto_increment"),
            });
        }
        Table { name: "char".into(), columns, primary_key: vec!["char_id".into()] }
    }

    /// 38 characters, the size of the reported table: long names, Korean
    /// ones, a population-engine companion, the largest 64-bit experience,
    /// never-logged-in (NULL) and zero dates.
    pub(crate) fn char_rows(table: &Table) -> Vec<Vec<Option<String>>> {
        let names = ["Agent", "포링마스터", "ACompanionWithALongName", "[PE] Aria the Archer", "Tab\tIn\\Name", "x"];
        (0..38)
            .map(|i| {
                table
                    .columns
                    .iter()
                    .map(|c| {
                        Some(match c.name.as_str() {
                            "char_id" => (150000 + i).to_string(),
                            "account_id" => (2000000 + i / 3).to_string(),
                            "name" => format!("{}{i}", names[i % names.len()]),
                            "base_exp" | "job_exp" if i == 7 => "18446744073709551615".into(),
                            "zeny" => "4294967295".into(),
                            "last_map" | "save_map" => "prontera".into(),
                            "sex" => (if i % 2 == 0 { "M" } else { "F" }).into(),
                            "last_login" => match i % 3 {
                                0 => return None,
                                1 => "0000-00-00 00:00:00".into(),
                                _ => "2026-09-30 21:14:05".into(),
                            },
                            _ => (i * 37 % 1000).to_string(),
                        })
                    })
                    .collect()
            })
            .collect()
    }

    /// The read script's answer, exactly as mariadb --batch --raw writes it:
    /// every value hex-encoded, then the end marker.
    pub(crate) fn rows_answer(rows: &[Vec<Option<String>>]) -> String {
        let mut out = format!("c\t{}\n", rows.len());
        for row in rows {
            let cells: Vec<String> = row.iter().map(|v| v.as_deref().map(|s| hex(s.as_bytes())).unwrap_or_else(|| "NULL".into())).collect();
            out.push_str(&format!("r\t{}\n", cells.join("\t")));
        }
        out.push_str(crate::docker::END_MARKER);
        out.push('\n');
        out
    }

    /// What `docker-slim exec` (nebula's slim-client, at the pinned commit)
    /// prints for a process that wrote `bytes`: the daemon frames each chunk
    /// it reads from the process as [stream,0,0,0,len BE] + payload, and the
    /// client reads its socket 8 KiB at a time and demultiplexes each read on
    /// its own, dropping a frame that does not fit in the read it started in.
    fn through_docker_slim_exec(bytes: &[u8], chunk: usize) -> Vec<u8> {
        let mut wire = Vec::new();
        for payload in bytes.chunks(chunk) {
            wire.push(1);
            wire.extend_from_slice(&[0, 0, 0]);
            wire.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            wire.extend_from_slice(payload);
        }
        let mut out = Vec::new();
        for read in wire.chunks(8192) {
            // slim-client/src/http.rs demux_stdcopy, as it is.
            let mut i = 0;
            while i + 8 <= read.len() {
                let stream = read[i];
                let len = u32::from_be_bytes([read[i + 4], read[i + 5], read[i + 6], read[i + 7]]) as usize;
                i += 8;
                if i + len > read.len() {
                    break;
                }
                if stream != 2 {
                    out.extend_from_slice(&read[i..i + len]);
                }
                i += len;
            }
        }
        out
    }

    #[test]
    fn a_page_of_char_is_read_whole() {
        let table = rathena_char();
        assert_eq!(table.columns.len(), 80);
        assert_eq!(table.columns.iter().find(|c| c.name == "base_exp").unwrap().column_type, "bigint(20) unsigned");
        let rows = char_rows(&table);
        let answer = rows_answer(&rows);
        let body = crate::docker::strip_end_marker(&answer).unwrap();
        let page = parse_rows(&table, body).unwrap();
        let parsed = json::parse(&page).unwrap();
        assert_eq!(parsed.get("total").and_then(|t| if let Value::Number(n) = t { Some(*n) } else { None }), Some(38.0));
        let Some(Value::Array(got)) = parsed.get("rows") else { panic!("{page}") };
        assert_eq!(got.len(), 38);
        // A 64-bit value stays exact, a tab in a name stays a tab, and NULL
        // stays NULL rather than becoming the text "NULL".
        assert!(page.contains("\"18446744073709551615\""));
        assert!(page.contains("\"Tab\\u0009In\\\\Name4\""), "{page}");
        let Value::Array(first) = &got[0] else { panic!() };
        let login = table.columns.iter().position(|c| c.name == "last_login").unwrap();
        assert_eq!(first[login], Value::Null);
        assert_eq!(first.len(), 80);
    }

    /// The reported bug. A page of `char` is ~23 KiB hex-encoded; through
    /// docker-slim's exec stream it arrived cut off after the first frame,
    /// mid-row, and the reader said "answered in a form this tool does not
    /// read" over an empty grid. The rows are fine; the transport lost them.
    #[test]
    fn a_page_of_char_does_not_survive_docker_slim_exec_stdout() {
        let table = rathena_char();
        let answer = rows_answer(&char_rows(&table));
        assert!(answer.len() > 8192, "{} bytes", answer.len());
        // mariadb writes a pipe 4 KiB at a time.
        let cut = String::from_utf8_lossy(&through_docker_slim_exec(answer.as_bytes(), 4096)).into_owned();
        assert!(cut.len() < answer.len() && answer.starts_with(&cut), "{} of {}", cut.len(), answer.len());
        // What the old reader did with it: the message in the report.
        let err = parse_rows(&table, &cut).unwrap_err();
        assert!(err.contains("does not read"), "{err}");
        // What happens now: the marker is missing, so it is called incomplete,
        // never parsed as a shorter table.
        assert!(crate::docker::strip_end_marker(&cut).unwrap_err().contains("incomplete"));
        // A small table's answer fits in one frame and one read, which is why
        // every other table loaded.
        let small = "c\t1\nr\t3135\nragnarok-db-answer-complete\n";
        assert_eq!(through_docker_slim_exec(small.as_bytes(), 4096), small.as_bytes());
    }

    #[test]
    fn rows_that_do_not_match_the_table_say_why() {
        let table = rathena_char();
        let err = parse_rows(&table, "c\t1\nr\t30\t31\n").unwrap_err();
        assert!(err.contains("2 values") && err.contains("80 columns") && err.contains("line 2"), "{err}");
        assert!(parse_rows(&table, "").unwrap_err().contains("no row count"));
        assert!(parse_rows(&table, "c\t0\n").unwrap().contains("\"rows\":[]"));
    }

    #[test]
    fn deleting_a_character_is_one_keyed_delete_of_one_row() {
        let mut tables = BTreeMap::new();
        tables.insert("char".to_string(), rathena_char());
        let planned = plan(&tables, &changes(r#"[{"table":"char","key":{"char_id":"150012"},"delete":true}]"#)).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].statement, "DELETE FROM `char` WHERE `char_id` = 150012 LIMIT 1;");
        assert_eq!(planned[0].check.as_ref().unwrap().0, "SELECT 1 FROM `char` WHERE `char_id` = 150012");
        assert_eq!(planned[0].label, "delete char (char_id=150012)");
    }
}
