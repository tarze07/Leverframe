use super::*;

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lf-tasks-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn titled(title: &str) -> TaskChange {
    TaskChange {
        title: Some(title.into()),
        status: None,
    }
}

fn status(s: Status) -> TaskChange {
    TaskChange {
        title: None,
        status: Some(s),
    }
}

#[test]
fn reads_the_header_and_falls_back_to_the_file() {
    let p = Path::new("/x/7-a.md");
    let t = parse_task(
        "---\nid: 7\ntitle: \"Eksport: CSV \\\"pilne\\\" #1\"\nstatus: review # komentarz\ncreated: 2026-11-25\nlabels:\n  - a\n---\n# Inny\n",
        "7-a.md",
        p,
        Scope::Project,
    );
    assert_eq!(t.id, 7);
    assert_eq!(t.title, "Eksport: CSV \"pilne\" #1");
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.created, "2026-11-25");
    assert_eq!(t.file, "7-a.md");
    assert_eq!(t.scope, Scope::Project);

    // Single quotes, CRLF, a BOM, an unknown status.
    let t = parse_task(
        "\u{feff}---\r\ntitle: 'It''s zażółć'\r\nstatus: później\r\n---\r\ntreść\r\n",
        "12-x.md",
        p,
        Scope::Global,
    );
    assert_eq!(
        (t.id, t.title.as_str(), t.status),
        (12, "It's zażółć", Status::Todo)
    );

    // No header: the first heading, else the file's name.
    let t = parse_task(
        "Wstęp\n# Poprawić logowanie\n",
        "3-cos.md",
        p,
        Scope::Global,
    );
    assert_eq!((t.id, t.title.as_str()), (3, "Poprawić logowanie"));
    let t = parse_task("", "notatki_na-pozniej.md", p, Scope::Global);
    assert_eq!((t.id, t.title.as_str()), (0, "notatki na pozniej"));
    // An unfinished header is text.
    let t = parse_task("---\ntitle: x\n", "5-y.md", p, Scope::Global);
    assert_eq!(t.title, "y");
}

#[test]
fn changes_only_the_header_and_keeps_unknown_keys() {
    let d = temp("update");
    let text = "---\nid: 4\ntitle: Stary\nowner: jan # mój\nstatus: todo\n---\n# Stary\n\nOpis: bez zmian\n---\nkoniec\n";
    std::fs::write(d.join("4-stary.md"), text).unwrap();
    let t = update(&d, Scope::Project, "4-stary.md", &titled("Nowy: \"tytuł\"")).unwrap();
    assert_eq!(t.title, "Nowy: \"tytuł\"");
    let t = update(&d, Scope::Project, "4-stary.md", &status(Status::Doing)).unwrap();
    assert_eq!(t.status, Status::Doing);
    assert_eq!(
        std::fs::read_to_string(d.join("4-stary.md")).unwrap(),
        "---\nid: 4\ntitle: \"Nowy: \\\"tytuł\\\"\"\nowner: jan # mój\nstatus: doing\n---\n# Stary\n\nOpis: bez zmian\n---\nkoniec\n"
    );
    assert!(update(&d, Scope::Project, "4-stary.md", &titled("  ")).is_err());

    // A file without a header gets one; CRLF stays.
    std::fs::write(d.join("9-luzem.md"), "# Luźne\r\ntreść\r\n").unwrap();
    let t = update(&d, Scope::Project, "9-luzem.md", &status(Status::Done)).unwrap();
    assert_eq!(
        (t.id, t.title.as_str(), t.status),
        (9, "Luźne", Status::Done)
    );
    assert_eq!(
        std::fs::read_to_string(d.join("9-luzem.md")).unwrap(),
        "---\r\nid: 9\r\ntitle: \"Luźne\"\r\nstatus: done\r\n---\r\n# Luźne\r\ntreść\r\n"
    );

    for bad in ["../x.md", "a/b.md", "x.txt", ".md", "nie-ma.md", "a\\b.md"] {
        assert!(
            update(&d, Scope::Project, bad, &status(Status::Done)).is_err(),
            "{bad}"
        );
    }
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn creates_numbered_tasks_and_lists_them() {
    let root = temp("create");
    let dir = root.join(".leverframe").join("tasks");
    assert!(list(&dir, Scope::Project).unwrap().is_empty());
    let a = create(&dir, Scope::Project, "Dodać eksport CSV").unwrap();
    assert_eq!((a.id, a.file.as_str()), (1, "1-dodac-eksport-csv.md"));
    assert_eq!(a.created, today());
    let b = create(&dir, Scope::Project, "  Zażółć gęślą jaźń: ŁÓDŹ!  ").unwrap();
    assert_eq!((b.id, b.file.as_str()), (2, "2-zazolc-gesla-jazn-lodz.md"));
    assert_eq!(b.title, "Zażółć gęślą jaźń: ŁÓDŹ!");
    assert!(std::fs::read_to_string(&b.path)
        .unwrap()
        .contains("# Zażółć gęślą jaźń: ŁÓDŹ!\n\n## Opis"));
    // Numbers continue after the highest, also one from a hand-made file.
    std::fs::write(dir.join("10-recznie.md"), "# Ręcznie\n").unwrap();
    std::fs::write(dir.join("notatka.txt"), "nie zadanie").unwrap();
    std::fs::create_dir_all(dir.join("folder.md")).unwrap();
    let c = create(&dir, Scope::Project, "???").unwrap();
    assert_eq!((c.id, c.file.as_str()), (11, "11-zadanie.md"));
    assert!(create(&dir, Scope::Project, " ").is_err());

    let all = list(&dir, Scope::Project).unwrap();
    assert_eq!(
        all.iter()
            .map(|t| (t.id, t.title.as_str()))
            .collect::<Vec<_>>(),
        [
            (1, "Dodać eksport CSV"),
            (2, "Zażółć gęślą jaźń: ŁÓDŹ!"),
            (10, "Ręcznie"),
            (11, "???")
        ]
    );
    assert!(all.iter().all(|t| t.status == Status::Todo));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn moves_between_scopes_and_deletes() {
    let root = temp("move");
    let project = root.join("p");
    let global = root.join("g");
    let a = create(&project, Scope::Project, "Pierwsze").unwrap();
    create(&global, Scope::Global, "Globalne").unwrap();
    update(&project, Scope::Project, &a.file, &status(Status::Doing)).unwrap();
    let moved = move_task(&project, Scope::Project, &a.file, &global, Scope::Global).unwrap();
    assert_eq!((moved.id, moved.file.as_str()), (2, "2-pierwsze.md"));
    assert_eq!((moved.scope, moved.status), (Scope::Global, Status::Doing));
    assert!(list(&project, Scope::Project).unwrap().is_empty());
    assert_eq!(list(&global, Scope::Global).unwrap().len(), 2);
    assert!(move_task(
        &global,
        Scope::Global,
        "2-pierwsze.md",
        &global,
        Scope::Global
    )
    .is_err());

    delete(&global, "2-pierwsze.md", true).unwrap();
    assert_eq!(list(&global, Scope::Global).unwrap().len(), 1);
    assert!(delete(&global, "2-pierwsze.md", true).is_err());
    assert!(delete(&global, "../p.md", true).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn keeps_the_tasks_folder_out_of_git_once() {
    let root = temp("git");
    // Not a repository: nothing.
    let plain = root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert_eq!(exclude_from_git(&plain).unwrap(), None);

    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".git").join("info")).unwrap();
    std::fs::write(
        repo.join(".git/info/exclude"),
        "# git ls-files --others\n*.log",
    )
    .unwrap();
    let file = exclude_from_git(&repo).unwrap().unwrap();
    assert_eq!(exclude_from_git(&repo).unwrap(), None);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.starts_with("# git ls-files --others\n*.log\n# Zadania"),
        "{text}"
    );
    assert_eq!(text.lines().filter(|l| *l == "/.leverframe/").count(), 1);
    assert!(!repo.join(".gitignore").exists());

    // A project inside the repository; a repository without `info/`.
    let sub = repo.join("apps").join("web");
    std::fs::create_dir_all(&sub).unwrap();
    exclude_from_git(&sub).unwrap().unwrap();
    assert!(std::fs::read_to_string(&file)
        .unwrap()
        .contains("\n/apps/web/.leverframe/\n"));
    let bare = root.join("bare");
    std::fs::create_dir_all(bare.join(".git")).unwrap();
    exclude_from_git(&bare).unwrap().unwrap();
    assert!(bare.join(".git/info/exclude").is_file());

    // A worktree: `.git` is a file; the common folder's exclude is used.
    let wt = root.join("wt");
    let wt_git = root.join("main").join(".git").join("worktrees").join("wt");
    std::fs::create_dir_all(&wt_git).unwrap();
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
    exclude_from_git(&wt).unwrap().unwrap();
    let common = std::fs::read_to_string(wt_git.join("../../info/exclude")).unwrap();
    assert_eq!(common.lines().filter(|l| *l == "/.leverframe/").count(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn slugs_and_dates() {
    assert_eq!(slug("Napraw błąd #12 w API"), "napraw-blad-12-w-api");
    assert_eq!(slug("---"), "zadanie");
    assert!(slug(&"bardzo długi tytuł ".repeat(10)).len() <= 40);
    assert_eq!(civil_date(0), "1970-01-01");
    assert_eq!(civil_date(20_782), "2026-11-25");
    assert_eq!(civil_date(11_016), "2000-02-29");
    assert_eq!(
        template(3, "A \"b\"", "2026-01-02")
            .lines()
            .take(6)
            .collect::<Vec<_>>(),
        [
            "---",
            "id: 3",
            "title: \"A \\\"b\\\"\"",
            "status: todo",
            "created: 2026-01-02",
            "---"
        ]
    );
}

#[test]
fn notes_runs_in_the_header_and_reads_them_back() {
    let d = temp("runs");
    let t = create(&d, Scope::Global, "Zadanie z historią").unwrap();
    let first = TaskRun {
        at: "2026-11-25T14:00:00.000Z".into(),
        agent: "claude".into(),
        profile: "local:bash".into(),
        mode: "chat".into(),
        cwd: Some("/home/jan/sklep, \"główny\"".into()),
        remote: None,
    };
    let after = add_run(&d, Scope::Global, &t.file, &first).unwrap();
    assert_eq!(after.status, Status::Doing);
    assert_eq!(after.runs, std::slice::from_ref(&first));
    let second = TaskRun {
        at: "2026-11-25T15:00:00.000Z".into(),
        agent: "opencode".into(),
        profile: "docker:api".into(),
        mode: "terminal".into(),
        cwd: Some("/workspace".into()),
        remote: Some("/root/api/.leverframe/tasks/1-zadanie-z-historia.md".into()),
    };
    // Status changed in between: the list stays one list, other keys stay.
    update(&d, Scope::Global, &t.file, &status(Status::Review)).unwrap();
    let after = add_run(&d, Scope::Global, &t.file, &second).unwrap();
    assert_eq!(after.runs, [first, second]);
    assert_eq!(after.status, Status::Doing);
    let text = std::fs::read_to_string(&t.path).unwrap();
    assert_eq!(text.matches("runs:").count(), 1);
    assert!(
        text.contains("\nruns:\n  - {at: \"2026-11-25T14:00:00.000Z\", agent: \"claude\""),
        "{text}"
    );
    assert!(text.contains("# Zadanie z historią\n"));
    // Status set after the runs: the list is kept.
    let t2 = update(&d, Scope::Global, &t.file, &status(Status::Done)).unwrap();
    assert_eq!(t2.runs.len(), 2);

    let bad = TaskRun {
        mode: "inny".into(),
        ..TaskRun::default()
    };
    assert!(add_run(&d, Scope::Global, &t.file, &bad).is_err());
    // Lines that are not runs are skipped.
    assert_eq!(TaskRun::parse("  - zwykły punkt"), None);
    assert_eq!(TaskRun::parse("  - {agent: \"x\"}"), None);
    let _ = std::fs::remove_dir_all(d);
}
