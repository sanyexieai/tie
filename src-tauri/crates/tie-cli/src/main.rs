use clap::{Parser, Subcommand};
use serde::Serialize;
use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;
use tie_local::{LocalWorkspace, WritePageInput};

#[derive(Parser, Debug)]
#[command(name = "tie", version, about = "Tie local-first knowledge CLI")]
struct Cli {
    /// Workspace root containing pages/
    #[arg(long, env = "TIE_WORKSPACE", global = true)]
    workspace: Option<PathBuf>,

    /// Default storage_source_id when pages omit it
    #[arg(long, env = "TIE_SOURCE_ID", global = true)]
    source_id: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum FormatCmd {
    /// Parse every pages/*.md and report errors
    Check,
}

#[derive(Subcommand, Debug)]
enum FilesCmd {
    /// List registered files
    List {
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        ext: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Get one registered file by id
    Get {
        file_id: String,
    },
    /// Resolve open path for a file id
    OpenHint {
        file_id: String,
    },
    /// Register a path (`link` absolute, or `copy` into `.tie/files/`)
    Ingest {
        path: PathBuf,
        #[arg(long, default_value = "link")]
        mode: String,
        #[arg(long)]
        title: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Create pages/ under a workspace root
    Init {
        /// Directory to initialize (default: --workspace / cwd)
        path: Option<PathBuf>,
    },
    /// Read a page by id or exact title
    Get {
        id_or_title: String,
    },
    /// Search pages by query and/or tag
    Search {
        #[arg(default_value = "")]
        query: String,
        #[arg(long)]
        tag: Option<String>,
        #[arg(long, default_value_t = 12)]
        limit: usize,
    },
    /// List recently updated pages
    Recent {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        tag: Option<String>,
    },
    /// Show outgoing/incoming links, children, same-tag neighbors
    Related {
        id_or_title: String,
    },
    /// Print the page tree (JSON)
    Tree {
        /// Optional root page id or title (default: all top-level pages)
        root: Option<String>,
    },
    /// File registry under .tie/files
    Files {
        #[command(subcommand)]
        action: FilesCmd,
    },
    /// Validate page Markdown frontmatter (tie_version: 1)
    Format {
        #[command(subcommand)]
        action: FormatCmd,
    },
    /// Create or update a page (auto frontmatter + history)
    Write {
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        page_id: Option<String>,
        /// Markdown body; if omitted, read stdin when piped
        #[arg(long)]
        markdown: Option<String>,
        #[arg(long)]
        tag: Vec<String>,
        #[arg(long)]
        parent_id: Option<String>,
        #[arg(long)]
        parent_title: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        icon: Option<String>,
        #[arg(long, default_value_t = false)]
        match_title: bool,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init { path } => {
            let target = path
                .or_else(|| cli.workspace.clone())
                .unwrap_or_else(|| PathBuf::from("."));
            let source = cli.source_id.as_deref().unwrap_or("");
            let ws = LocalWorkspace::init(&target, source)?;
            print_json(&serde_json::json!({
                "workspace": ws.root().display().to_string(),
                "sourceId": ws.default_source_id(),
            }))
        }
        other => {
            let root = cli
                .workspace
                .clone()
                .ok_or("请通过 --workspace 或 TIE_WORKSPACE 指定工作区根目录（含 pages/）")?;
            let ws = LocalWorkspace::open(&root, cli.source_id.as_deref())?;
            match other {
                Commands::Get { id_or_title } => {
                    let page = ws
                        .resolve(&id_or_title)?
                        .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
                    print_json(&page)
                }
                Commands::Search { query, tag, limit } => {
                    let results = ws.search(&query, tag.as_deref(), limit, false)?;
                    print_json(&serde_json::json!({
                        "workspace": ws.root().display().to_string(),
                        "results": results,
                    }))
                }
                Commands::Recent { limit, tag } => {
                    print_json(&ws.list_recent(limit, tag.as_deref())?)
                }
                Commands::Related { id_or_title } => print_json(&ws.related(&id_or_title)?),
                Commands::Tree { root } => print_json(&ws.tree(root.as_deref())?),
                Commands::Files { action } => match action {
                    FilesCmd::List { query, ext, limit } => {
                        print_json(&ws.files().list(query.as_deref(), ext.as_deref(), limit)?)
                    }
                    FilesCmd::Get { file_id } => {
                        let meta = ws
                            .files()
                            .get(&file_id)?
                            .ok_or_else(|| format!("文件资源不存在：{file_id}"))?;
                        print_json(&meta)
                    }
                    FilesCmd::OpenHint { file_id } => print_json(&ws.files().open_hint(&file_id)?),
                    FilesCmd::Ingest { path, mode, title } => {
                        print_json(&ws.files().ingest(&mode, &path, title.as_deref())?)
                    }
                },
                Commands::Format { action } => match action {
                    FormatCmd::Check => {
                        let report = ws.check_format()?;
                        print_json(&report)?;
                        if !report.errors.is_empty() {
                            return Err(format!(
                                "format check 失败：{} 个文件有问题",
                                report.errors.len()
                            ));
                        }
                        Ok(())
                    }
                },
                Commands::Write {
                    title,
                    page_id,
                    markdown,
                    tag,
                    parent_id,
                    parent_title,
                    kind,
                    icon,
                    match_title,
                } => {
                    let body = match markdown {
                        Some(text) => Some(text),
                        None => read_markdown_stdin()?,
                    };
                    let tags = if tag.is_empty() { None } else { Some(tag) };
                    let result = ws.write_page(WritePageInput {
                        title,
                        markdown: body,
                        page_id,
                        tags,
                        parent_id: parent_id.map(Some),
                        parent_title,
                        kind,
                        match_title,
                        icon,
                    })?;
                    print_json(&result)
                }
                Commands::Init { .. } => unreachable!(),
            }
        }
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Read body from stdin only when piped with real content.
/// `/dev/null` (stdio ignore) is not a terminal but yields empty — treat as omitted.
fn read_markdown_stdin() -> Result<Option<String>, String> {
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Ok(None);
    }
    let mut buf = String::new();
    stdin
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.is_empty() {
        Ok(None)
    } else {
        Ok(Some(buf))
    }
}

