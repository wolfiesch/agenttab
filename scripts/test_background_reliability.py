from __future__ import annotations

import unittest

from scripts.background_reliability import active_tabs, focus_violations, tab_ids


class BackgroundReliabilityTests(unittest.TestCase):
    def test_compares_active_tab_ids_without_treating_a_new_window_as_focus_theft(self) -> None:
        baseline = {
            "windows": [{
                "window_id": 10,
                "tabs": [
                    {"tab_id": 1, "active": True},
                    {"tab_id": 2, "active": False},
                ],
            }]
        }
        current = {
            "windows": [
                baseline["windows"][0],
                {"window_id": 20, "tabs": [{"tab_id": 3, "active": True}]},
            ]
        }
        self.assertEqual(active_tabs(current), [(10, 1), (20, 3)])
        self.assertEqual(tab_ids(current), {1, 2, 3})
        self.assertEqual(
            focus_violations(baseline, current, owned_tab_id=3, iteration=0),
            [],
        )

    def test_reports_focus_change_unexpected_tab_and_missing_owned_tab(self) -> None:
        baseline = {
            "windows": [{
                "window_id": 10,
                "tabs": [
                    {"tab_id": 1, "active": True},
                    {"tab_id": 2, "active": False},
                ],
            }]
        }
        current = {
            "windows": [{
                "window_id": 10,
                "tabs": [
                    {"tab_id": 1, "active": False},
                    {"tab_id": 2, "active": True},
                    {"tab_id": 9, "active": False},
                ],
            }]
        }
        kinds = [
            violation["kind"]
            for violation in focus_violations(
                baseline,
                current,
                owned_tab_id=3,
                iteration=4,
            )
        ]
        self.assertEqual(
            kinds,
            ["active_tabs_changed", "unexpected_tabs", "owned_tab_missing"],
        )


if __name__ == "__main__":
    unittest.main()
