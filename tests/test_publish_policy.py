import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "publish-policy.py"
SPEC = importlib.util.spec_from_file_location("publish_policy", SCRIPT)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class PublishPolicyTests(unittest.TestCase):
    def test_minor_and_major_releases_submit_to_stores(self):
        for tag in ("v1.4.0", "v1.10.0", "v2.0.0"):
            with self.subTest(tag=tag):
                self.assertTrue(policy.publish_stores(tag))

    def test_patch_releases_do_not_submit_to_stores(self):
        for tag in ("v1.3.1", "v1.4.1", "v1.4.10", "v2.0.1"):
            with self.subTest(tag=tag):
                self.assertFalse(policy.publish_stores(tag))

    def test_prereleases_and_invalid_tags_do_not_submit_to_stores(self):
        for tag in ("v1.4.0-beta.1", "v2.0.0-rc.1", "1.4.0", "v1.4", "v01.4.0", "v1.04.0", "v1.4.00", "v1.4.0\n", ""):
            with self.subTest(tag=tag):
                self.assertFalse(policy.publish_stores(tag))

    def test_cli_outputs_github_actions_boolean(self):
        for tag, value in (("v1.4.0", "true"), ("v1.3.1", "false"), ("v1.4.0-beta.1", "false")):
            with self.subTest(tag=tag):
                result = subprocess.run([sys.executable, "-B", str(SCRIPT), tag], check=True, capture_output=True, text=True)
                self.assertEqual(result.stdout, f"publish_stores={value}\n")


if __name__ == "__main__":
    unittest.main()
