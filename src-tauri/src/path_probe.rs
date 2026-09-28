//! Best-effort attachment availability, never an authorization or write check.
//! stat() can wait indefinitely on disconnected mounts. Bound both caller wait
//! and outstanding OS calls; do not spawn a new stuck thread on every render.
use std::{
    fs::Metadata,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, OnceLock,
    },
    time::Duration,
};

struct ProbeLimit(Arc<AtomicUsize>);
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl ProbeLimit {
    fn new() -> Self {
        Self(Arc::new(AtomicUsize::new(0)))
    }
    fn run<T: Send + 'static>(
        &self,
        timeout: Duration,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
            })
            .ok()?;
        let permit = Permit(self.0.clone());
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("tie-path-probe".into())
            .spawn(move || {
                let _permit = permit;
                let _ = send.send(work());
            })
            .ok()?;
        receive.recv_timeout(timeout).ok()
    }
}

// Reading mountinfo does not touch the mount. A real filesystem mounted over
// an autofs trigger is usable; never canonicalize/stat the trigger to decide.
#[cfg(target_os = "linux")]
fn inactive_automount(path: &std::path::Path, mounts: &str) -> bool {
    let mut best = 0;
    let mut inactive = false;
    for line in mounts.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let Some(raw) = left.split_whitespace().nth(4) else {
            continue;
        };
        let mount = raw
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\");
        let mount = std::path::Path::new(&mount);
        if !path.starts_with(mount) {
            continue;
        }
        let depth = mount.components().count();
        let autofs = right.split_whitespace().next() == Some("autofs");
        if depth > best {
            best = depth;
            inactive = autofs;
        } else if depth == best && !autofs {
            inactive = false;
        }
    }
    inactive
}

pub(crate) fn metadata(path: PathBuf) -> Option<Metadata> {
    #[cfg(target_os = "linux")]
    if let Ok(mounts) = std::fs::read_to_string("/proc/self/mountinfo") {
        if inactive_automount(&path, &mounts) {
            return None;
        }
    }
    static LIMIT: OnceLock<ProbeLimit> = OnceLock::new();
    LIMIT
        .get_or_init(ProbeLimit::new)
        .run(Duration::from_millis(150), move || {
            std::fs::metadata(path).ok()
        })
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hung_probes_timeout_and_cannot_spawn_unbounded_threads() {
        let limit = ProbeLimit::new();
        let (release, wait) = mpsc::channel::<()>();
        let wait = Arc::new(std::sync::Mutex::new(wait));
        for _ in 0..4 {
            let wait = wait.clone();
            assert_eq!(
                limit.run(Duration::from_millis(5), move || {
                    wait.lock().unwrap().recv().unwrap();
                    true
                }),
                None
            );
        }
        assert_eq!(
            limit.run(Duration::from_millis(5), || panic!("limit ignored")),
            None::<()>
        );
        for _ in 0..4 {
            release.send(()).unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while limit.0.load(Ordering::Acquire) != 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert_eq!(limit.run(Duration::from_secs(1), || true), Some(true));
    }
    #[test]
    fn reads_existing_and_missing_paths() {
        assert!(metadata(std::env::temp_dir()).unwrap().is_dir());
        assert!(
            metadata(std::env::temp_dir().join(format!("tie-missing-{}", std::process::id())))
                .is_none()
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn skips_only_inactive_mounts_and_respects_component_boundaries() {
        let mounts = "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:1 / /media/日常 rw - autofs systemd-1 rw\n3 1 0:2 / /mnt/code\\040disk rw - autofs systemd-1 rw\n4 3 8:2 / /mnt/code\\040disk rw - exfat /dev/disk rw\n";
        assert!(inactive_automount(
            std::path::Path::new("/media/日常/books/a.pdf"),
            mounts
        ));
        assert!(!inactive_automount(
            std::path::Path::new("/media/日常-backup/a.pdf"),
            mounts
        ));
        assert!(!inactive_automount(
            std::path::Path::new("/mnt/code disk/a.pdf"),
            mounts
        ));
        assert!(!inactive_automount(
            std::path::Path::new("/home/user/a.pdf"),
            mounts
        ));
        let mounted = format!("{mounts}5 2 8:3 / /media/日常 rw - exfat /dev/reconnected rw\n");
        assert!(!inactive_automount(
            std::path::Path::new("/media/日常/a.pdf"),
            &mounted
        ));
    }
}
