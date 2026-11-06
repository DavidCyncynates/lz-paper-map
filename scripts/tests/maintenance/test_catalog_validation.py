from __future__ import annotations

import copy
import unittest

from scripts.update_papers import (
    ALLOWED_CONTRIBUTIONS,
    add_annotations,
    annotation_schema,
    reannotate_revisions,
    validate,
    validate_refresh_metadata,
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


class CatalogRefreshMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.landscape = {
            "updatedAt": "2026-11-05",
            "lastSuccessfulScan": "2026-11-05T10:52:15Z",
            "citationData": {"checkedAt": "2026-11-05"},
        }
        self.complete_run = {
            "runAt": "2026-11-05T10:52:15Z",
            "scanWindow": {"coverageComplete": True},
            "citationReconciliation": {"coverageComplete": True},
        }

    def test_accepts_matching_completed_run_dates(self) -> None:
        validate_refresh_metadata(self.landscape, [self.complete_run])

    def test_rejects_each_stale_public_date(self) -> None:
        for field in ("updatedAt", "lastSuccessfulScan", "citationData.checkedAt"):
            with self.subTest(field=field):
                landscape = copy.deepcopy(self.landscape)
                if field == "citationData.checkedAt":
                    landscape["citationData"]["checkedAt"] = "2026-10-27"
                elif field == "lastSuccessfulScan":
                    landscape[field] = "2026-11-05T10:52:14Z"
                else:
                    landscape[field] = "2026-10-27"
                with self.assertRaisesRegex(ValueError, f"{field} predates"):
                    validate_refresh_metadata(landscape, [self.complete_run])

    def test_later_partial_or_unattested_runs_do_not_advance_dates(self) -> None:
        for completion in (False, None, "true", 1):
            with self.subTest(completion=completion):
                later_run = {
                    "runAt": "2026-11-06T10:00:00Z",
                    "scanWindow": {"coverageComplete": completion},
                    "citationReconciliation": {"coverageComplete": completion},
                }
                validate_refresh_metadata(self.landscape, [later_run, self.complete_run])
        validate_refresh_metadata(
            self.landscape, [self.complete_run, {"runAt": "2026-11-07T10:00:00Z"}]
        )

    def test_partial_discovery_with_complete_citations_does_not_advance_dates(self) -> None:
        partial_run = {
            "runAt": "2026-11-06T10:00:00Z",
            "scanWindow": {"coverageComplete": False},
            "citationReconciliation": {"coverageComplete": True},
        }
        validate_refresh_metadata(self.landscape, [self.complete_run, partial_run])

    def test_uses_latest_completed_run_regardless_of_manifest_order(self) -> None:
        older_run = {**self.complete_run, "runAt": "2026-10-27T10:28:29Z"}
        landscape = {**self.landscape, "updatedAt": "2026-10-27"}
        for manifests in ([self.complete_run, older_run], [older_run, self.complete_run]):
            with self.assertRaisesRegex(ValueError, "updatedAt predates"):
                validate_refresh_metadata(landscape, manifests)

    def test_compares_timestamp_instants_in_utc(self) -> None:
        self.landscape["lastSuccessfulScan"] = "2026-11-05T11:52:15+01:00"
        validate_refresh_metadata(self.landscape, [self.complete_run])

    def test_requires_usable_timestamps_for_explicit_completion(self) -> None:
        for run_at in (None, "2026-11-05T10:52:15", "not-a-date"):
            with self.subTest(run_at=run_at):
                with self.assertRaisesRegex(ValueError, "Completed run manifest runAt"):
                    validate_refresh_metadata(
                        self.landscape, [{**self.complete_run, "runAt": run_at}]
                    )


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
