"""Create disposable Git histories. Never operate on the RBTFlow Git repository."""
import json
import os
from pathlib import Path
import subprocess


def create(build: Path) -> None:
    manifest = build / "fixtures.json"
    work = build / "workspace"
    remote = build / "repos/demo.git"
    if manifest.exists() and (work / ".git").is_dir() and remote.is_dir():
        return
    if work.exists() or remote.exists():
        raise RuntimeError("Incomplete fixtures; inspect build/workspace and build/repos first.")

    # Synthetic repos should not inherit signing, hooks, filters, or Git identity.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_DATE="2026-01-01T12:00:00+00:00",
               GIT_COMMITTER_DATE="2026-01-01T12:00:00+00:00")

    def git(*args, ok=True):
        result = subprocess.run(["git", "-C", str(work), *args], env=env,
                                capture_output=True, text=True)
        if ok and result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result

    work.mkdir(parents=True)
    remote.parent.mkdir(parents=True, exist_ok=True)
    git("-c", "init.templateDir=", "init", "--initial-branch=main")
    git("-c", "init.templateDir=", "init", "--bare", "--initial-branch=main", str(remote))
    for key, value in {"user.name": "RBTFlow Demo", "user.email": "demo@example.invalid",
                       "commit.gpgsign": "false", "core.hooksPath": str(build / "empty-hooks"),
                       "core.autocrlf": "false"}.items():
        git("config", key, value)
    git("remote", "add", "origin", str(remote))

    def commit(filename, content, message):
        (work / filename).write_text(content)
        git("add", "--", filename)
        git("commit", "-m", message)
        return git("rev-parse", "HEAD").stdout.strip()

    initial = commit("greeting.txt", "base\n", "Initial baseline")
    git("switch", "-c", "feature/linear")
    commit("feature.txt", "feature v1\n", "Add feature")
    linear = commit("greeting.txt", "feature greeting\n", "Customize greeting")
    git("switch", "main")
    upstream = commit("upstream.txt", "upstream only\n", "Advance upstream")
    git("push", "-u", "origin", "main")
    # Feature commits are deliberately NOT pushed: Review Board must use the
    # known upstream objects, including a parent diff for stacked branches.
    git("switch", "-c", "feature/merged", linear)
    git("merge", "--no-ff", "main", "-m", "Merge main into feature")
    merged = git("rev-parse", "HEAD").stdout.strip()
    git("switch", "-c", "topic/side", "main")
    commit("side.txt", "side feature\n", "Add side feature")
    git("switch", "-c", "feature/merged-side", merged)
    git("merge", "--no-ff", "topic/side", "-m", "Merge side topic")
    side = git("rev-parse", "HEAD").stdout.strip()
    git("switch", "-c", "topic/conflict", "main")
    commit("greeting.txt", "upstream greeting\n", "Change same greeting")
    git("switch", "-c", "feature/conflict-resolved", merged)
    conflict = git("merge", "--no-ff", "topic/conflict", ok=False)
    if conflict.returncode != 1 or not git("ls-files", "-u").stdout:
        raise RuntimeError("Expected a real merge conflict in the fixture.")
    resolved = commit("greeting.txt", "feature + upstream + manual resolution\n",
                      "Resolve merged greeting explicitly")
    git("switch", "-c", "feature/stacked-parent", "main")
    parent = commit("parent.txt", "unpublished parent\n", "Add parent change")
    git("switch", "-c", "feature/stacked-child")
    commit("child.txt", "child change\n", "Add child change")
    child = commit("parent.txt", "parent extended by child\n", "Extend unpublished parent")
    git("switch", "feature/merged")
    (work / ".git/info").mkdir(exist_ok=True)
    with (work / ".git/info/exclude").open("a") as f:
        f.write("\n.reviewboardrc\n")
    scenarios = {
        "linear": {"base": initial, "head": linear},
        "merged": {"base": upstream, "head": merged},
        "merged-side": {"base": upstream, "head": side},
        "conflict-resolved": {"base": upstream, "head": resolved},
        "stacked-child": {"base": parent, "head": child},
    }
    manifest.write_text(json.dumps({"upstream": upstream, "scenarios": scenarios}, indent=2) + "\n")
