from __future__ import annotations

import copy
import unittest

from scripts.update_papers import validate


def valid_landscape() -> dict:
    return {
        "schemaVersion": 2,
        "taxonomyRevision": "2026-10-08",
        "citationData": {
            "source": "arXiv reference lists",
            "scope": "Citations between papers in this map",
            "checkedAt": "2026-10-08",
        },
        "islands": [
            {"id": "observation", "summary": "The experimental result."},
            {"id": "idea", "summary": "A physical explanation family."},
        ],
        "papers": [
            {
                "id": "2609.00001",
                "layoutRank": 0,
                "arxivId": "2609.00001",
                "arxivVersion": 1,
                "role": "observation",
                "primaryIsland": "observation",
                "islands": ["observation"],
                "x": 50,
                "y": 50,
                "url": "https://arxiv.org/abs/2609.00001",
                "cites": [],
                "summary": "The source result.",
                "takeaway": "The experimental anchor.",
            },
            {
                "id": "2609.00002",
                "layoutRank": 1,
                "arxivId": "2609.00002",
                "arxivVersion": 1,
                "role": "explanation",
                "primaryIsland": "idea",
                "islands": ["idea"],
                "x": 60,
                "y": 50,
                "url": "https://arxiv.org/abs/2609.00002",
                "cites": ["2609.00001"],
                "summary": "A proposed interpretation.",
                "takeaway": "A member of the idea family.",
            },
        ],
    }


class CatalogTaxonomyValidationTests(unittest.TestCase):
    def test_accepts_a_valid_taxonomy(self) -> None:
        validate(valid_landscape())

    def test_requires_an_iso_taxonomy_revision(self) -> None:
        for revision in (None, 20261008, "2026-13-08"):
            with self.subTest(revision=revision):
                landscape = valid_landscape()
                landscape["taxonomyRevision"] = revision
                with self.assertRaisesRegex(ValueError, "taxonomyRevision"):
                    validate(landscape)

    def test_rejects_duplicate_memberships(self) -> None:
        landscape = valid_landscape()
        landscape["papers"][1]["islands"] = ["idea", "idea"]
        with self.assertRaisesRegex(ValueError, "duplicate island membership"):
            validate(landscape)

    def test_requires_exactly_one_membership(self) -> None:
        landscape = valid_landscape()
        landscape["papers"][1]["islands"] = ["idea", "observation"]
        with self.assertRaisesRegex(ValueError, "exactly one island membership"):
            validate(landscape)

    def test_rejects_unknown_memberships(self) -> None:
        landscape = valid_landscape()
        landscape["papers"][1]["islands"] = ["idea", "missing"]
        with self.assertRaisesRegex(ValueError, "unknown island membership"):
            validate(landscape)

    def test_requires_slug_safe_island_ids(self) -> None:
        landscape = valid_landscape()
        landscape["islands"][1]["id"] = "Not an ID"
        with self.assertRaisesRegex(ValueError, "slug-safe"):
            validate(landscape)

    def test_requires_primary_membership_first(self) -> None:
        landscape = valid_landscape()
        landscape["papers"][1]["islands"] = ["observation", "idea"]
        with self.assertRaisesRegex(ValueError, "primary island must be the first"):
            validate(landscape)

    def test_requires_every_island_to_have_a_primary_paper(self) -> None:
        landscape = copy.deepcopy(valid_landscape())
        landscape["islands"].append(
            {"id": "orphan", "summary": "No paper is assigned here."}
        )
        with self.assertRaisesRegex(ValueError, "orphan: no paper has this primary island"):
            validate(landscape)


if __name__ == "__main__":
    unittest.main()
