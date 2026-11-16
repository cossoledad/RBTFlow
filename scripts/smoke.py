"""Exercise real Git -> rbt -> HTTP -> Review Board -> reconstructed files."""
from datetime import datetime, timezone
import json
import re
import subprocess
import sys
import traceback
from urllib.error import HTTPError
from urllib.parse import urlsplit

from lab import api, BIN, BUILD, ENV, URL

WORK = BUILD / "workspace"
RUN = BUILD / "smoke" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
RUN.mkdir(parents=True)
SPECS = json.loads((BUILD / "fixtures.json").read_text())["scenarios"]
REPORT = {"status": "RUNNING", "server": URL, "artifacts": str(RUN), "checks": []}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def git(*args, env=ENV):
    return subprocess.run(["git", "-C", str(WORK), *args], env=env,
                          capture_output=True, check=True).stdout


def rbt(label, *args, expect_error=False):
    command = [str(BIN / "rbt"), *args]
    p = subprocess.run(command, cwd=WORK, env=ENV, capture_output=True, timeout=60)
    (RUN / f"{label}.stdout").write_bytes(p.stdout)
    (RUN / f"{label}.stderr").write_bytes(p.stderr)
    (RUN / f"{label}.command.json").write_text(json.dumps(command, indent=2) + "\n")
    if expect_error:
        check(p.returncode != 0, f"{label}: expected rejection")
        check(b"entirely linear" in p.stderr + p.stdout, f"{label}: unexpected error; inspect artifacts")
    else:
        check(p.returncode == 0, f"{label}: rbt failed; inspect {RUN / (label + '.stderr')}")
    return p.stdout


def patch_tree(label, patch, spec):
    """Apply into a private Git index, then compare the entire target tree."""
    check(b"diff --git " in patch, f"{label}: missing patch")
    index = RUN / f"{label}.index"
    env = {**ENV, "GIT_INDEX_FILE": str(index)}
    git("read-tree", spec["base"], env=env)
    p = subprocess.run(["git", "-C", str(WORK), "apply", "--cached", "--whitespace=nowarn", "-"],
                       input=patch, env=env, capture_output=True)
    check(p.returncode == 0, f"{label}: patch failed to apply: {p.stderr.decode()}")
    check(git("write-tree", env=env) == git("rev-parse", spec["head"] + "^{tree}"),
          f"{label}: patched tree differs from selected HEAD")


def relative(href):
    check(href.startswith(URL), "Server returned a URL outside this local lab")
    return href[len(URL):]


def post(label, spec, *, mode="--squash-history", request_id=None, publish=False):
    args = ["post", "--json", mode, "--tracking-branch=origin/main",
            f"--summary=RBTFlow smoke: {label}", "--description=Local synthetic validation",
            "--testing-done=RBTFlow real Git/RBTools/API smoke",
            "--target-people=reviewer", "--target-groups=reviewers", "--bugs-closed=1234,5678",
            "--branch=main"]
    if request_id is not None:
        args += ["-r", str(request_id), "--change-description=Validate conflict resolution update"]
    if publish:
        args += ["--publish"]
    result = json.loads(rbt(label, *args, spec["base"], spec["head"]))
    check(result.get("status") == "success", f"{label}: missing success result")
    return result["review_request_id"]


def verify_review(label, request_id, spec, *, published=False, with_history=False):
    prefix = f"api/review-requests/{request_id}/"
    review = api(prefix)["review_request"]
    check(review["public"] == published, f"{label}: publication state differs")
    check(review["created_with_history"] == with_history, f"{label}: wrong review history mode")
    if published:
        details = api(prefix, user="reviewer")["review_request"]
        diffs_prefix = prefix + "diffs/"
    else:
        details = api(prefix + "draft/")["draft"]
        diffs_prefix = prefix + "draft/diffs/"
        try:
            api(prefix, user="reviewer")
        except HTTPError as exc:
            check(exc.code in (403, 404), f"{label}: unexpected draft access status")
        else:
            raise AssertionError(f"{label}: unpublished review visible to reviewer")
    check(details["branch"] == "main", f"{label}: wrong branch metadata")
    check(set(details["bugs_closed"]) == {"1234", "5678"}, f"{label}: bugs not saved")
    check({p["title"] for p in details["target_people"]} == {"reviewer"}, f"{label}: reviewer not saved")
    check({g["title"] for g in details["target_groups"]} == {"reviewers"}, f"{label}: group not saved")
    diffs = api(diffs_prefix)["diffs"]
    diff = max(diffs, key=lambda d: d["revision"])
    diff_path = relative(diff["links"]["self"]["href"])
    patch = api(diff_path, accept="text/x-patch")
    (RUN / f"{label}.server.patch").write_bytes(patch)
    patch_tree(label + "-server", patch, spec)
    files = api(diff_path + "files/")["files"]
    expected = set(git("diff", "--name-only", "-z", spec["base"], spec["head"]).decode().split("\0")) - {""}
    check({f["dest_file"] for f in files} == expected, f"{label}: uploaded file set differs")
    check("upstream.txt" not in expected, f"{label}: unrelated upstream change leaked")
    for file in files:
        filename = file["dest_file"]
        patched = api(relative(file["links"]["patched_file"]["href"]), accept="application/octet-stream")
        check(patched == git("show", f"{spec['head']}:{filename}"),
              f"{label}: server failed to reconstruct {filename}")
        if file["source_revision"] != "PRE-CREATION":
            original = api(relative(file["links"]["original_file"]["href"]), accept="application/octet-stream")
            check(original == git("show", f"{spec['base']}:{filename}"),
                  f"{label}: wrong preimage for {filename}, including parent diff")
    if with_history:
        check(diff["commit_count"] == 2, "Linear review did not preserve both commits")
    return {"review_request_id": request_id, "url": URL + f"r/{request_id}/",
            "base": spec["base"], "head": spec["head"], "files": sorted(expected),
            "diff_revision": diff["revision"], "with_history": with_history, "published": published}


def case(name, function):
    result = function() or {}
    REPORT["checks"].append({"name": name, "status": "PASS", **result})
    print(f"PASS {name}", flush=True)


def web():
    check(api()["capabilities"]["review_requests"]["supports_history"], "History capability missing")
    REPORT["versions"]["reviewboard"] = api("api/info/")["info"]["product"]["package_version"]
    html = api("", accept="text/html").decode()
    paths = re.findall(r'(?:href|src)="([^"]*/static/[^"?]+\.(?:css|js)(?:\?[^\"]*)?)"', html)
    selected = []
    for suffix in (".css", ".js"):
        matches = [p for p in paths if urlsplit(p).path.endswith(suffix)]
        check(bool(matches), f"HTML has no {suffix} static asset")
        selected.append(matches[0])
    for href in selected:
        parsed = urlsplit(href)
        check(not parsed.netloc or parsed.netloc == "127.0.0.1:8080", "Unexpected static asset host")
        path = parsed.path.lstrip("/") + ("?" + parsed.query if parsed.query else "")
        check(len(api(path, accept="application/octet-stream")) > 100, "Static asset unavailable")
    return {"api": "ok", "static_assets_checked": 2}


def rejected(label, request_id=None):
    spec = SPECS["merged"]
    before = api("api/review-requests/?status=all&counts-only=1")["count"]
    args = ["post", "--json", "--with-history", "--summary=Expected non-linear rejection"]
    if request_id is not None:
        # Existing history-mode requests cannot be converted by adding -S.
        args = ["post", "--json", "--squash-history", "-r", str(request_id)]
    rbt(label, *args, spec["base"], spec["head"], expect_error=True)
    after = api("api/review-requests/?status=all&counts-only=1")["count"]
    check(before == after, "Rejected post unexpectedly created a review")
    return {"expected_error": "commit histories that are entirely linear", "new_reviews": 0}


def scenario(name, with_history=False):
    spec = SPECS[name]
    patch = rbt(name + "-preview", "diff", "--color=never", spec["base"], spec["head"])
    patch_tree(name + "-preview", patch, spec)
    i = post(name, spec, mode="--with-history" if with_history else "--squash-history")
    return verify_review(name, i, spec, with_history=with_history)


def main():
    original_refs = git("show-ref")
    original_status = git("status", "--porcelain=v1", "-z")
    original_branch = git("symbolic-ref", "HEAD")
    current = "service-api-and-static"
    try:
        REPORT["versions"] = {"rbt": rbt("version", "--version").decode().strip()}
        case(current, web)
        current = "reject-non-linear-history"
        case(current, lambda: rejected("non-linear"))
        for name in SPECS:
            current = name
            case(name, lambda name=name: scenario(name, with_history=name == "linear"))
        linear = next(c for c in REPORT["checks"] if c["name"] == "linear")
        current = "reject-downgrading-existing-history-review"
        case(current, lambda: rejected("existing-history", linear["review_request_id"]))
        merged = next(c for c in REPORT["checks"] if c["name"] == "merged")
        current = "publish-baseline"

        def publish_baseline():
            i = merged["review_request_id"]
            result = json.loads(rbt("publish-baseline", "publish", "--json", str(i)))
            check(result.get("status") == "success", "Publish did not return success")
            return verify_review("published-baseline", i, SPECS["merged"], published=True)

        case(current, publish_baseline)
        current = "update-and-publish"

        def update():
            spec = SPECS["conflict-resolved"]
            i = post("update", spec, request_id=merged["review_request_id"], publish=True)
            check(i == merged["review_request_id"], "Update created a different review request")
            result = verify_review("update", i, spec, published=True)
            check(result["diff_revision"] == 2, "Expected second diff revision after update")
            return result

        case(current, update)
        current = "preserve-local-history-and-worktree"
        check(git("show-ref") == original_refs, "Local branch/commit identities changed")
        check(git("status", "--porcelain=v1", "-z") == original_status, "Worktree changed")
        check(git("symbolic-ref", "HEAD") == original_branch, "Checked-out branch changed")
        case(current, lambda: {"unchanged": True})
        REPORT["status"] = "PASS"
    except Exception as exc:
        REPORT["status"] = "FAIL"
        REPORT["checks"].append({"name": current, "status": "FAIL", "error": str(exc)})
        traceback.print_exc()
    finally:
        REPORT["finished_at"] = datetime.now(timezone.utc).isoformat()
        report = json.dumps(REPORT, indent=2) + "\n"
        (RUN / "results.json").write_text(report)
        (BUILD / "smoke/latest.json").write_text(report)
        print(f"{REPORT['status']}: {RUN / 'results.json'}", flush=True)
    return 0 if REPORT["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
