// A stand-in for docker-slim, for tests/full-backup.test.cjs.
//
// It models just enough of one MariaDB container to drive a whole-world
// backup and restore: which volume `ragnarok-db` was started on, each volume's
// "database" as a file, and dumps and loads through /backups. Every call is
// appended to <fixture>/calls.
use std::{env, fs, io::{self, Read, Write}, path::{Path, PathBuf}};

fn main() {
    let root = PathBuf::from(env::var_os("RO_BACKUP_FIXTURE").unwrap());
    let state = PathBuf::from(env::var_os("RAGNAROKMAC_STATE").unwrap());
    let args: Vec<String> = env::args().skip(1).collect();
    let mut calls = fs::OpenOptions::new().create(true).append(true).open(root.join("calls")).unwrap();
    writeln!(calls, "{}", args.join(" ")).unwrap();
    let volumes = root.join("volumes");
    fs::create_dir_all(&volumes).unwrap();
    let running = root.join("db-running");
    let current = || fs::read_to_string(root.join("current")).unwrap_or_default();
    // Where the container's /backups is: the bind-mounted state/backups on
    // Unix, a named volume (here, a folder) on Windows.
    let backups = if cfg!(windows) { root.join("container-backups") } else { state.join("backups") };
    fs::create_dir_all(&backups).unwrap();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["capabilities"] => println!("exec-stdin-eof-v1"),
        ["inspect", "-f", _, "ragnarok-db"] if running.exists() => println!("running"),
        ["inspect", "ragnarok-db"] if running.exists() => println!(
            "[{{\"State\":{{\"Status\":\"running\"}},\"Mounts\":[{{\"Type\":\"volume\",\"Name\":\"{}\",\"Destination\":\"/var/lib/mysql\"}}]}}]",
            current()
        ),
        ["volume", "inspect", name] if volumes.join(format!("{name}.sql")).exists() => println!("[{{}}]"),
        ["ps", "-aq", "--filter", f] if *f == "name=ragnarok-db" && running.exists() => println!("db0"),
        ["ps", ..] => {}
        ["stop", .., "ragnarok-db"] => { let _ = fs::remove_file(&running); }
        ["rm", "-f", _] | ["start", _] => {}
        ["run", "-d", rest @ ..] | ["create", rest @ ..] => {
            let volume = rest.windows(2)
                .find_map(|w| if w[0] == "-v" { w[1].strip_suffix(":/var/lib/mysql") } else { None })
                .expect("the database volume");
            let data = volumes.join(format!("{volume}.sql"));
            if !data.exists() { fs::write(&data, format!("-- fresh {volume}\n")).unwrap(); }
            fs::write(root.join("current"), volume).unwrap();
            fs::write(&running, "").unwrap();
        }
        // load_dump streams a backup into the container's /tmp on stdin.
        ["exec", "-i", "ragnarok-db", "sh", "-c", script] if script.contains("cat > '/tmp/") => {
            let name = script.rsplit('/').next().unwrap().trim_end_matches('\'');
            let tmp = root.join("container-tmp");
            fs::create_dir_all(&tmp).unwrap();
            let mut body = Vec::new();
            io::stdin().read_to_end(&mut body).unwrap();
            fs::write(tmp.join(name), body).unwrap();
        }
        ["exec", "-i", "ragnarok-db", ..] => {
            let mut sql = String::new();
            io::stdin().read_to_string(&mut sql).unwrap();
            let mut log = fs::OpenOptions::new().create(true).append(true).open(root.join("sql")).unwrap();
            writeln!(log, "{}: {}", current(), sql.trim()).unwrap();
            println!("1");
        }
        ["exec", "ragnarok-db", "sh", "-c", script] => {
            let data = volumes.join(format!("{}.sql", current()));
            if let Some((_, file)) = script.split_once("wc -c < '/tmp/") {
                let name = file.trim().trim_end_matches('\'');
                println!("{}", fs::metadata(root.join("container-tmp").join(name)).unwrap().len());
            } else if let Some((_, file)) = script.split_once("< /tmp/") {
                // The app's version stamp is a comment the real database skips,
                // and what a migration appends is statements it runs: neither is
                // part of the data this fake keeps.
                let dump = fs::read_to_string(root.join("container-tmp").join(file.trim())).unwrap();
                let added = dump.find("\n\n-- Added by Ragnarok Offline when restoring:").unwrap_or(dump.len());
                let kept: String = dump[..added]
                    .lines()
                    .filter(|l| !l.starts_with("-- Ragnarok Offline backup: "))
                    .map(|l| format!("{l}\n"))
                    .collect();
                fs::write(&data, kept).unwrap();
            } else if let Some((_, file)) = script.split_once("> /tmp/") {
                // The container's own /tmp: `docker cp` brings the dump out.
                let tmp = root.join("container-tmp");
                fs::create_dir_all(&tmp).unwrap();
                fs::copy(&data, tmp.join(file.trim())).unwrap();
            } else if let Some((_, file)) = script.split_once("> /backups/") {
                fs::copy(&data, backups.join(file.trim())).unwrap();
            } else if let Some((_, file)) = script.split_once("< /backups/") {
                fs::copy(backups.join(file.trim()), &data).unwrap();
            } else {
                std::process::exit(2);
            }
        }
        ["exec", "ragnarok-db", "rm", "-f", _] => {}
        ["exec", "ragnarok-db", "rm", "-rf", _] => {}
        // Windows: the dump comes out, or the staged backups go in, by `cp`.
        ["cp", from, to] if from.starts_with("ragnarok-db:/tmp/") => {
            let name = from.rsplit('/').next().unwrap();
            fs::copy(root.join("container-tmp").join(name), Path::new(to)).unwrap();
        }
        ["cp", from, to] if from.starts_with("ragnarok-db:/backups/") => {
            let name = from.rsplit('/').next().unwrap();
            fs::copy(backups.join(name), Path::new(to)).unwrap();
        }
        ["cp", from, to] if to.starts_with("ragnarok-db:") => {
            if let Ok(rd) = fs::read_dir(from) {
                if to.ends_with("/backups") {
                    for e in rd.flatten() { fs::copy(e.path(), backups.join(e.file_name())).unwrap(); }
                }
            }
        }
        _ => std::process::exit(1),
    }
}
