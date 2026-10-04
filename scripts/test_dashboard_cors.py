#!/usr/bin/env python3
"""Regression tests for installer-owned Moonraker CORS configuration."""

from __future__ import annotations

import unittest

from configure_dashboard_cors import BEGIN_MARKER, add_origin, remove_origin


class DashboardCorsTests(unittest.TestCase):
    def test_adds_to_existing_list_and_is_idempotent(self) -> None:
        original = """[authorization]\ntrusted_clients:\n  127.0.0.1\ncors_domains:\n  http://mainsail.local\n\n[history]\n"""
        updated, changed = add_origin(original, "http://Printer.local:7131")
        self.assertTrue(changed)
        self.assertIn("  http://printer.local:7131\n", updated)
        self.assertIn("  http://mainsail.local\n", updated)
        self.assertEqual(updated.count(BEGIN_MARKER), 1)
        repeated, changed_again = add_origin(updated, "http://printer.local:7131")
        self.assertFalse(changed_again)
        self.assertEqual(repeated, updated)

    def test_replaces_only_installer_owned_origin(self) -> None:
        first, _ = add_origin("[authorization]\ncors_domains:\n", "http://old.local:7131")
        second, changed = add_origin(first, "http://new.local:7131")
        self.assertTrue(changed)
        self.assertNotIn("old.local", second)
        self.assertIn("http://new.local:7131", second)

    def test_preserves_user_owned_matching_origin(self) -> None:
        original = "[authorization]\ncors_domains:\n  http://printer.local:7131\n"
        updated, changed = add_origin(original, "http://Printer.local:7131")
        self.assertFalse(changed)
        self.assertEqual(updated, original)
        removed, remove_changed = remove_origin(updated)
        self.assertFalse(remove_changed)
        self.assertEqual(removed, original)

    def test_creates_missing_option_or_section(self) -> None:
        with_authorization, _ = add_origin("[authorization]\ntrusted_clients:\n  127.0.0.1\n", "http://v.local:7131")
        self.assertIn("cors_domains:\n", with_authorization)
        without_authorization, _ = add_origin("[server]\nhost: 0.0.0.0\n", "http://v.local:7131")
        self.assertIn("[authorization]\ncors_domains:\n", without_authorization)

    def test_remove_keeps_surrounding_configuration(self) -> None:
        original = "[authorization]\ncors_domains:\n  http://mainsail.local\n"
        updated, _ = add_origin(original, "http://v.local:7131")
        removed, changed = remove_origin(updated)
        self.assertTrue(changed)
        self.assertEqual(removed, original)


if __name__ == "__main__":
    unittest.main()
