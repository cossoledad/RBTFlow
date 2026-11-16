"""Run only through rb-site manage ... shell, inside the local lab site."""
import os
from pathlib import Path

from django.contrib.auth.models import User
from django.contrib.sites.models import Site
from djblets.siteconfig.models import SiteConfiguration
from reviewboard.reviews.models import Group
from reviewboard.scmtools.models import Repository, Tool

root = Path(os.environ["RBTFLOW_ROOT"])
reviewer, created = User.objects.get_or_create(
    username="reviewer", defaults={"email": "reviewer@example.invalid", "first_name": "Demo Reviewer"})
if created:
    reviewer.set_password("rbtflow-local")
    reviewer.save()
group, _ = Group.objects.get_or_create(name="reviewers", defaults={"display_name": "Demo Reviewers"})
group.users.add(reviewer)
repository, _ = Repository.objects.get_or_create(
    name="RBTFlow Demo",
    defaults={"path": str(root / "build/repos/demo.git"),
              "tool": Tool.objects.get(name="Git"),
              "bug_tracker": "https://bugs.example.invalid/%s", "public": True})
if repository.path != str(root / "build/repos/demo.git"):
    raise RuntimeError("The existing demo repository points to another path; inspect it first.")
site = Site.objects.get_current()
site.domain = "127.0.0.1:8080"
site.name = "RBTFlow Local Lab"
site.save()
config = SiteConfiguration.objects.get_current()
config.set("site_domain_method", "http")
config.save()
print(f"Demo repository {repository.pk}; users admin/reviewer; group reviewers.")
