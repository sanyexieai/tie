use clap::{Parser, Subcommand};
use serde::Serialize;
use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;
mod mcp;

use tie_local::{
    pack_tiez, unpack_tiez, ExportOptions, ImportStrategy, LocalWorkspace, WritePageInput,
    DEFAULT_EXPORT_DEPTH,
};

#[derive(Parser, Debug)]
#[command(name = "tie", version, about = "Tie local-first knowledge CLI")]
struct Cli {
    /// Workspace root, or a `.tie` solution file (env: TIE_WORKSPACE)
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
    List {
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        ext: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    Get {
        file_id: String,
    },
    OpenHint {
        file_id: String,
    },
    Ingest {
        path: PathBuf,
        #[arg(long, default_value = "link")]
        mode: String,
        #[arg(long)]
        title: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum HistoryCmd {
    /// List revisions for a page
    List {
        id_or_title: String,
    },
    /// Read one revision as JSON page
    Get {
        id_or_title: String,
        revision_id: String,
    },
    /// Restore a revision onto the current page (archives current first)
    Restore {
        id_or_title: String,
        revision_id: String,
    },
}

#[derive(Subcommand, Debug)]
enum SolutionCmd {
    /// Write / refresh the `.tie` solution file at the workspace root
    Write {
        #[arg(long)]
        name: Option<String>,
    },
    /// Show the solution file (or inferred metadata)
    Show,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Create pages/ + `.tie` solution under a workspace root
    Init {
        /// Directory to initialize (default: --workspace / cwd)
        path: Option<PathBuf>,
        #[arg(long)]
        name: Option<String>,
    },
    /// Resolve and print workspace info from a directory or `.tie` file
    Open {
        /// Path to workspace dir or `.tie` (default: --workspace)
        path: Option<PathBuf>,
    },
    /// Pack workspace tree into a `.tiez` archive
    Pack {
        /// Output `.tiez` path
        #[arg(long)]
        out: PathBuf,
    },
    /// Unpack a `.tiez` archive into a directory
    Unpack {
        archive: PathBuf,
        /// Output directory (must not exist or be empty)
        #[arg(long)]
        out: PathBuf,
    },
    /// Manage the text `.tie` solution file
    Solution {
        #[command(subcommand)]
        action: SolutionCmd,
    },
    /// List page summaries
    List {
        #[arg(long, default_value_t = false)]
        include_deleted: bool,
    },
    /// Soft-delete a page (recycle bin via deleted_at)
    Delete {
        id_or_title: String,
    },
    /// Restore a soft-deleted page
    Restore {
        id_or_title: String,
    },
    /// Permanently delete a page (default: must be in recycle bin)
    Purge {
        id_or_title: String,
        #[arg(long, default_value_t = false)]
        force: bool,
    },
    /// Page revision history
    History {
        #[command(subcommand)]
        action: HistoryCmd,
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
    /// Export a page closure into a directory
    Export {
        #[arg(long)]
        page: String,
        #[arg(long, default_value_t = DEFAULT_EXPORT_DEPTH)]
        depth: usize,
        #[arg(long, overrides_with = "no_children")]
        with_children: bool,
        #[arg(long, overrides_with = "with_children")]
        no_children: bool,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Import an export directory into the workspace
    Import {
        path: PathBuf,
        #[arg(long, default_value = "skip")]
        strategy: String,
    },
    /// Speak MCP on stdin/stdout. Agents launch: tie mcp
    Mcp,
    /// Create or update a page (auto frontmatter + history)
    Write {
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        page_id: Option<String>,
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
    let workspace_flag = cli.workspace.clone();
    let source_id = cli.source_id.clone();
    match cli.command {
        Commands::Init { path, name } => {
            let target = path
                .or(workspace_flag)
                .unwrap_or_else(|| PathBuf::from("."));
            let source = source_id.as_deref().unwrap_or("");
            let ws = LocalWorkspace::init(&target, source)?;
            let sol = if let Some(name) = name {
                Some(ws.write_solution_file(Some(&name))?)
            } else {
                let path = ws.solution_path();
                if path.exists() {
                    Some(path)
                } else {
                    Some(ws.write_solution_file(None)?)
                }
            };
            print_json(&serde_json::json!({
                "workspace": ws.root().display().to_string(),
                "sourceId": ws.default_source_id(),
                "solution": sol.map(|p| p.display().to_string()),
            }))
        }
        Commands::Open { path } => {
            let entry = path
                .or(workspace_flag)
                .ok_or("请指定要打开的目录或 .tie 文件")?;
            let ws = LocalWorkspace::open_entry(&entry, source_id.as_deref())?;
            print_json(&serde_json::json!({
                "workspace": ws.root().display().to_string(),
                "sourceId": ws.default_source_id(),
                "solution": ws.solution_path().display().to_string(),
                "solutionExists": ws.solution_path().is_file(),
            }))
        }
        Commands::Unpack { archive, out } => print_json(&unpack_tiez(&archive, &out)?),
        other => {
            let root = workspace_flag
                .ok_or("请通过 --workspace 或 TIE_WORKSPACE 指定工作区根目录或 .tie 解决方案")?;
            let ws = LocalWorkspace::open_entry(&root, source_id.as_deref())?;
            match other {
                Commands::Pack { out } => print_json(&pack_tiez(ws.root(), &out)?),
                Commands::Solution { action } => match action {
                    SolutionCmd::Write { name } => {
                        let path = ws.write_solution_file(name.as_deref())?;
                        print_json(&serde_json::json!({
                            "solution": path.display().to_string(),
                            "workspace": ws.root().display().to_string(),
                            "sourceId": ws.default_source_id(),
                        }))
                    }
                    SolutionCmd::Show => {
                        let path = ws.solution_path();
                        if path.is_file() {
                            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                            let sol = tie_local::parse_solution_text(&text)?;
                            print_json(&serde_json::json!({
                                "path": path.display().to_string(),
                                "solution": sol,
                            }))
                        } else {
                            print_json(&serde_json::json!({
                                "path": path.display().to_string(),
                                "exists": false,
                                "workspace": ws.root().display().to_string(),
                                "sourceId": ws.default_source_id(),
                            }))
                        }
                    }
                },
                Commands::List { include_deleted } => {
                    print_json(&ws.list_pages(include_deleted)?)
                }
                Commands::Delete { id_or_title } => print_json(&ws.soft_delete(&id_or_title)?),
                Commands::Restore { id_or_title } => {
                    print_json(&ws.restore_deleted(&id_or_title)?)
                }
                Commands::Purge { id_or_title, force } => {
                    print_json(&ws.purge_page(&id_or_title, force)?)
                }
                Commands::History { action } => match action {
                    HistoryCmd::List { id_or_title } => {
                        print_json(&ws.list_revisions(&id_or_title)?)
                    }
                    HistoryCmd::Get {
                        id_or_title,
                        revision_id,
                    } => print_json(&ws.get_revision(&id_or_title, &revision_id)?),
                    HistoryCmd::Restore {
                        id_or_title,
                        revision_id,
                    } => print_json(&ws.restore_revision(&id_or_title, &revision_id)?),
                },
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
                Commands::Export {
                    page,
                    depth,
                    with_children: _,
                    no_children,
                    out,
                } => print_json(&ws.export_closure(
                    &page,
                    &ExportOptions {
                        depth,
                        with_children: !no_children,
                        out,
                    },
                )?),
                Commands::Import { path, strategy } => {
                    let strategy: ImportStrategy = strategy.parse()?;
                    print_json(&ws.import_closure(&path, strategy)?)
                }
                Commands::Mcp => {
                    mcp::serve(&ws)?;
                    Ok(())
                }
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
                Commands::Init { .. }
                | Commands::Open { .. }
                | Commands::Unpack { .. } => unreachable!(),
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
