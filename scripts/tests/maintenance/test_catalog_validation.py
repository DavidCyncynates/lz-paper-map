from __future__ import annotations

import copy
import unittest

from scripts.update_papers import (
    ALLOWED_CONTRIBUTIONS,
    add_annotations,
    annotation_schema,
    reannotate_revisions,
    validate,
)


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
                "contribution": "observation",
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
                "contribution": "candidate",
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

    def test_accepts_each_non_observation_contribution_independently_of_legacy_role(self) -> None:
        for contribution in ALLOWED_CONTRIBUTIONS - {"observation"}:
            with self.subTest(contribution=contribution):
                landscape = valid_landscape()
                landscape["papers"][1]["contribution"] = contribution
                validate(landscape)

    def test_requires_a_known_contribution(self) -> None:
        for contribution in (None, "", "constraint", "new-candidate", [], 3):
            with self.subTest(contribution=contribution):
                landscape = valid_landscape()
                if contribution is None:
                    del landscape["papers"][1]["contribution"]
                else:
                    landscape["papers"][1]["contribution"] = contribution
                with self.assertRaisesRegex(ValueError, "contribution must be a known"):
                    validate(landscape)

    def test_observation_contribution_and_role_must_agree_in_both_directions(self) -> None:
        for index, contribution in ((0, "candidate"), (1, "observation")):
            with self.subTest(index=index, contribution=contribution):
                landscape = valid_landscape()
                landscape["papers"][index]["contribution"] = contribution
                with self.assertRaisesRegex(ValueError, "observation contribution must match"):
                    validate(landscape)

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


class ContributionAnnotationTests(unittest.TestCase):
    def test_annotation_schema_requires_contribution_without_source_result(self) -> None:
        item = annotation_schema(["idea"])["properties"]["papers"]["items"]
        self.assertIn("contribution", item["required"])
        self.assertEqual(
            set(item["properties"]["contribution"]["enum"]),
            ALLOWED_CONTRIBUTIONS - {"observation"},
        )

    def test_new_and_revised_annotations_keep_their_reviewed_contribution(self) -> None:
        landscape = valid_landscape()
        landscape["islands"][1].update(x=50, y=50, width=20, height=20)
        record = {
            "id": "2609.00003",
            "title": "An interpretation and an independent bound",
            "authors": ["A. Author"],
            "published": "2026-10-27",
            "updated": "2026-10-27",
            "url": "https://arxiv.org/abs/2609.00003",
        }
        annotation = {
            "arxiv_id": record["id"],
            "relevant": True,
            "confidence": 0.95,
            "role": "explanation",
            "contribution": "candidate-and-bound",
            "primary_island": "idea",
            "islands": ["idea"],
            "tags": ["interpretation", "bound"],
            "summary": "An interpretation with an independently derived bound.",
            "takeaway": "Both contributions are substantive.",
            "reason": "Directly studies the event.",
        }
        added, _ = add_annotations(
            landscape, [record], [annotation], {}, "2026-10-27T11:00:00Z"
        )
        self.assertEqual(added, 1)
        paper = landscape["papers"][-1]
        self.assertEqual(paper["contribution"], "candidate-and-bound")
        self.assertEqual(paper["role"], "explanation")

        revised = {**annotation, "contribution": "bound-reassessment"}
        updated, _ = reannotate_revisions(
            landscape, [record], [revised], {}, "2026-10-28T11:00:00Z"
        )
        self.assertEqual(updated, 1)
        self.assertEqual(paper["contribution"], "bound-reassessment")
        self.assertEqual(paper["role"], "explanation")


if __name__ == "__main__":
    unittest.main()
