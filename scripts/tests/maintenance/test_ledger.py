from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.maintenance.cli import main as cli_main
from scripts.maintenance.ledger import (
    ConflictError,
    IncompleteRunError,
    Ledger,
    LedgerError,
    default_state_path,
    latest_expected_announcement_date,
    normalize_arxiv_id,
    normalize_author,
)


def landscape(papers: list[dict] | None = None) -> dict:
    return {
        "schemaVersion": 2,
        "updatedAt": "2026-09-30",
        "lastSuccessfulScan": "2026-09-30T09:46:25Z",
        "papers": papers
        or [
            {
                "id": "2609.02823",
                "arxivId": "2609.02823",
                "arxivVersion": 1,
                "title": "The observation",
                "authors": ["LZ Collaboration"],
                "published": "2026-09-02",
                "updated": "2026-09-02",
            }
        ],
    }


class LedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state.sqlite3"
        self.landscape = self.root / "landscape.json"
        self.landscape.write_text(json.dumps(landscape()), encoding="utf-8")
        self.ledger = Ledger(self.state)
        self.ledger.initialize()
        self.ledger.bootstrap_landscape(self.landscape)

    def tearDown(self) -> None:
        self.ledger.close()
        self.temporary.cleanup()

    def start(self, run_id: str = "run-1", lanes: tuple[str, ...] = ("listings",)) -> str:
        return self.ledger.start_run(
            run_id=run_id, kind="test", required_lanes=lanes
        )["runId"]

    def complete_lane(self, run_id: str, lane: str = "listings", status: str = "completed") -> None:
        self.ledger.set_lane(run_id, lane, status)

    def test_bootstrap_status_tracks_catalog_without_fabricating_versions(self) -> None:
        status = self.ledger.status()
        self.assertEqual(status["schemaVersion"], 2)
        self.assertEqual(status["counts"]["catalog_papers"], 1)
        self.assertEqual(status["counts"]["author_registry"], 1)
        self.assertEqual(status["counts"]["paper_versions"], 0)
        self.assertEqual(
            self.ledger.get_metadata("catalog_last_successful_scan"),
            "2026-09-30T09:46:25Z",
        )
        known = self.ledger.known_papers()
        self.assertTrue(known["2609.02823"]["inCatalog"])
        self.assertEqual(known["2609.02823"]["versions"], [])
        due = self.ledger.plan(through="2026-10-01", author_limit=10)["authorsDue"]
        self.assertEqual(due[0]["displayName"], "LZ Collaboration")
        self.assertIsNone(due[0]["lastCompletedAt"])

    def test_default_run_requires_citation_discovery_lane(self) -> None:
        started = self.ledger.start_run(
            run_id="default-lanes",
            coverage_start="2026-09-28",
            coverage_end="2026-10-01",
        )
        self.assertIn("citation_discovery", started["requiredLanes"])
        self.assertEqual(
            started["requiredLanes"],
            [
                "listings",
                "searches",
                "citation_discovery",
                "authors",
                "references",
            ],
        )

    def test_references_lane_cannot_bypass_mapped_exact_version_coverage(self) -> None:
        run_id = self.start(lanes=("references",))
        self.complete_lane(run_id, lane="references")
        with self.assertRaisesRegex(
            IncompleteRunError, "mapped catalog lacks exact-version complete reference"
        ):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
            )
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            references=[],
        )
        completed = self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
        )
        self.assertEqual(completed["mappedMissingReferences"], 0)

    def test_start_run_rejects_overlap_until_explicit_abort(self) -> None:
        first = self.ledger.start_run(
            run_id="scheduled-run",
            kind="test",
            started_at="2026-10-01T09:00:00Z",
            required_lanes=("listings",),
        )
        with self.assertRaisesRegex(
            ConflictError,
            r"scheduled-run.*2026-10-01T09:00:00Z.*abort-run",
        ):
            self.ledger.start_run(
                run_id="forced-run", kind="test", required_lanes=("listings",)
            )
        self.ledger.abort_run(first["runId"], {"reason": "operator recovery"})
        replacement = self.ledger.start_run(
            run_id="forced-run", kind="test", required_lanes=("listings",)
        )
        self.assertEqual(replacement["runId"], "forced-run")

    def test_bootstrap_rejects_mutation_while_run_is_active(self) -> None:
        candidate_log = self.root / "candidates.json"
        candidate_log.write_text(
            json.dumps({"schemaVersion": 1, "items": []}), encoding="utf-8"
        )
        run_id = self.start()
        with self.assertRaisesRegex(
            ConflictError, r"bootstrap catalog.*run-1.*abort-run"
        ):
            self.ledger.bootstrap_landscape(self.landscape)
        with self.assertRaisesRegex(
            ConflictError, r"bootstrap candidate log.*run-1.*abort-run"
        ):
            self.ledger.bootstrap_candidate_log(candidate_log)

        self.ledger.abort_run(run_id, {"reason": "operator recovery"})
        self.assertEqual(
            self.ledger.bootstrap_landscape(self.landscape)["catalogPapers"], 1
        )
        self.assertEqual(
            self.ledger.bootstrap_candidate_log(candidate_log)["candidateLogEntries"],
            0,
        )

    def test_listing_batches_are_hashed_immutable_and_replayable(self) -> None:
        run_id = self.start()
        first = self.ledger.record_listing_batch(
            run_id=run_id,
            source="arxiv:hep-ph:new",
            batch_key="2026-10-01",
            ids=["arXiv:2610.00001v1", "https://arxiv.org/abs/2610.00002"],
            payload=b"source page A",
        )
        replay = self.ledger.record_listing_batch(
            run_id=run_id,
            source="arxiv:hep-ph:new",
            batch_key="2026-10-01",
            ids=["2610.00002", "2610.00001"],
            payload=b"source page A",
        )
        changed = self.ledger.record_listing_batch(
            run_id=run_id,
            source="arxiv:hep-ph:new",
            batch_key="2026-10-01",
            ids=["2610.00001", "2610.00002", "2610.00003"],
            payload=b"source page B",
        )
        self.assertFalse(first["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["batchId"], replay["batchId"])
        self.assertNotEqual(first["batchId"], changed["batchId"])
        self.ledger.abort_run(run_id, {"reason": "cross-run replay test"})
        second_run = self.ledger.start_run(
            run_id="run-2", kind="test", required_lanes=("listings",)
        )["runId"]
        cross_run_replay = self.ledger.record_listing_batch(
            run_id=second_run,
            source="arxiv:hep-ph:new",
            batch_key="2026-10-01",
            ids=["2610.00001", "2610.00002"],
            payload=b"source page A",
        )
        self.assertTrue(cross_run_replay["replayed"])
        links = self.ledger.connection.execute(
            "SELECT COUNT(*) FROM run_listing_batches WHERE batch_id = ?",
            (first["batchId"],),
        ).fetchone()[0]
        self.assertEqual(links, 2)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.ledger.transaction() as db:
                db.execute(
                    "UPDATE listing_batches SET batch_key = 'tampered' WHERE batch_id = ?",
                    (first["batchId"],),
                )

    def test_identical_payload_with_different_parse_is_a_conflict(self) -> None:
        run_id = self.start()
        self.ledger.record_listing_batch(
            run_id=run_id,
            source="listing",
            batch_key="day",
            ids=["2610.00001"],
            payload=b"same",
        )
        with self.assertRaises(ConflictError):
            self.ledger.record_listing_batch(
                run_id=run_id,
                source="listing",
                batch_key="day",
                ids=["2610.00002"],
                payload=b"same",
            )

    def test_coverage_only_batch_does_not_fill_discovery_queue(self) -> None:
        run_id = self.start()
        coverage = self.ledger.record_listing_batch(
            run_id=run_id,
            source="arxiv:hep-ph:recent",
            batch_key="2026-10-01",
            ids=["2610.00001", "2610.00002"],
            payload=b"broad category page",
            discover=False,
        )
        self.assertFalse(coverage["discover"])
        self.assertEqual(coverage["discoveriesRecorded"], 0)
        counts = self.ledger.status()["counts"]
        self.assertEqual(counts["listing_batches"], 1)
        self.assertEqual(counts["discoveries"], 0)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 0)

        promoted = self.ledger.record_listing_batch(
            run_id=run_id,
            source="arxiv:hep-ph:recent",
            batch_key="2026-10-01",
            ids=["2610.00001", "2610.00002"],
            payload=b"broad category page",
            discover=True,
        )
        self.assertTrue(promoted["replayed"])
        self.assertEqual(promoted["discoveriesRecorded"], 2)
        self.assertEqual(self.ledger.status()["counts"]["listing_batches"], 1)
        self.assertEqual(self.ledger.status()["counts"]["discoveries"], 2)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 2)

    def test_bundle_contains_only_unseen_and_changed_candidates(self) -> None:
        run_id = self.start()
        self.ledger.record_listing_batch(
            run_id=run_id,
            source="search:LZ",
            batch_key="frontier-1",
            ids=["2610.00001", "2610.00002"],
        )
        metadata = {
            "title": "A new explanation",
            "authors": ["A. Researcher", "B. Researcher"],
            "abstract": "An LZ-related result.",
            "submitted": "2026-10-01",
            "updated": "2026-10-01",
        }
        self.ledger.observe_paper(
            run_id=run_id, arxiv_id="2610.00001", version=1, metadata=metadata
        )
        bundle = self.ledger.review_bundle()
        self.assertEqual(bundle["candidateCount"], 2)
        self.assertEqual(bundle["candidates"][0]["reason"], "new_paper")
        self.assertEqual(bundle["metadataRequired"][0]["arxivId"], "2610.00002")
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            decision="excluded",
            reason="not about the event",
        )
        bundle = self.ledger.review_bundle()
        self.assertEqual(bundle["candidateCount"], 1)
        self.assertEqual(bundle["candidates"], [])

        changed = {**metadata, "abstract": "Now explicitly about the event."}
        observed = self.ledger.observe_paper(
            run_id=run_id, arxiv_id="2610.00001", version=1, metadata=changed
        )
        self.assertTrue(observed["changed"])
        bundle = self.ledger.review_bundle()
        self.assertEqual(bundle["candidates"][0]["reason"], "metadata_changed")

    def test_bootstrapped_catalog_revision_is_not_re_reviewed_until_newer(self) -> None:
        run_id = self.start()
        baseline = {
            "title": "The observation",
            "authors": ["LZ Collaboration"],
            "abstract": "The complete source abstract.",
            "submitted": "2026-09-02",
            "updated": "2026-09-02",
        }
        observed = self.ledger.observe_paper(
            run_id=run_id, arxiv_id="2609.02823", version=1, metadata=baseline
        )
        self.assertEqual(observed["screeningStatus"], "relevant")
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 0)

        revision = {**baseline, "updated": "2026-09-02", "abstract": "A same-day v2 abstract."}
        observed = self.ledger.observe_paper(
            run_id=run_id, arxiv_id="2609.02823", version=2, metadata=revision
        )
        self.assertEqual(observed["screeningStatus"], "pending")
        self.assertEqual(self.ledger.review_bundle()["candidates"][0]["reason"], "new_version")

    def test_unversioned_catalog_requires_one_time_exact_version_review(self) -> None:
        unversioned = landscape()
        unversioned["papers"][0].pop("arxivVersion")
        self.landscape.write_text(json.dumps(unversioned), encoding="utf-8")
        self.ledger.bootstrap_landscape(self.landscape)
        run_id = self.start()
        observed = self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            metadata={
                "title": "The observation",
                "authors": ["LZ Collaboration"],
                "abstract": "Source abstract.",
                "submitted": "2026-09-02",
                "updated": "2026-09-02",
            },
        )
        self.assertEqual(observed["screeningStatus"], "pending")
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            decision="relevant",
        )
        accepted = self.ledger.review_bundle()["candidates"][0]
        self.assertEqual(accepted["reason"], "accepted_revision_unpublished")

        self.ledger.abort_run(run_id, {"reason": "baseline merge simulation"})
        self.landscape.write_text(json.dumps(landscape()), encoding="utf-8")
        self.ledger.bootstrap_landscape(self.landscape)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 0)

    def test_reference_snapshots_are_complete_immutable_and_supersedable(self) -> None:
        run_id = self.start()
        first = self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            references=["2609.02823v2", "arXiv:2609.01475", "2609.02823"],
        )
        self.assertEqual(first["referenceCount"], 2)
        replay = self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            references=["2609.01475", "2609.02823"],
        )
        self.assertTrue(replay["replayed"])
        with self.assertRaises(ConflictError):
            self.ledger.record_reference_snapshot(
                run_id=run_id,
                arxiv_id="2610.00001",
                version=1,
                references=["2609.02823"],
            )
        correction = self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            references=["2609.02823"],
            supersede=True,
        )
        self.assertNotEqual(first["snapshotId"], correction["snapshotId"])
        count = self.ledger.connection.execute(
            "SELECT COUNT(*) FROM reference_snapshots"
        ).fetchone()[0]
        self.assertEqual(count, 2)

    def test_mapped_citations_intersect_complete_snapshots_and_choose_latest_version(self) -> None:
        run_id = self.start()
        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            metadata={
                "title": "A paper",
                "authors": ["A. Author"],
                "abstract": "Version one.",
                "submitted": "2026-10-01",
                "updated": "2026-10-01",
            },
        )
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            references=[],
        )
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            references=["2609.02823", "2501.00001"],
        )
        derived = self.ledger.mapped_citations(["2609.02823", "2610.00001"])
        self.assertTrue(derived["coverageComplete"])
        self.assertEqual(derived["outgoing"]["2610.00001"], ["2609.02823"])
        self.assertEqual(derived["citedBy"]["2609.02823"], ["2610.00001"])
        self.assertEqual(derived["citationCounts"]["2609.02823"], 1)

        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=2,
            metadata={
                "title": "A revised paper",
                "authors": ["A. Author"],
                "abstract": "Revised.",
                "submitted": "2026-10-01",
                "updated": "2026-10-02",
            },
        )
        stale = self.ledger.mapped_citations(["2609.02823", "2610.00001"])
        self.assertFalse(stale["coverageComplete"])
        self.assertEqual(stale["staleSnapshotIds"], ["2610.00001"])
        self.assertEqual(stale["outgoing"]["2610.00001"], [])
        self.assertTrue(stale["snapshotProvenance"]["2610.00001"]["stale"])
        self.assertEqual(
            stale["snapshotProvenance"]["2610.00001"]["expectedVersion"], 2
        )

        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=2,
            references=["2501.00001"],
        )
        derived = self.ledger.mapped_citations(
            ["2609.02823", "2610.00001", "2610.00002"]
        )
        self.assertFalse(derived["coverageComplete"])
        self.assertEqual(derived["missingSnapshotIds"], ["2610.00002"])
        self.assertEqual(derived["outgoing"]["2610.00001"], [])
        self.assertEqual(derived["snapshotProvenance"]["2610.00001"]["version"], 2)
        self.assertFalse(derived["snapshotProvenance"]["2610.00001"]["stale"])

    def test_catalog_version_marks_older_reference_snapshot_stale_without_observation(self) -> None:
        catalog = landscape()
        catalog["papers"][0]["arxivVersion"] = 2
        self.landscape.write_text(json.dumps(catalog), encoding="utf-8")
        self.ledger.bootstrap_landscape(self.landscape)
        run_id = self.start()
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            references=[],
        )
        derived = self.ledger.mapped_citations(["2609.02823"])
        self.assertFalse(derived["coverageComplete"])
        self.assertEqual(derived["staleSnapshotIds"], ["2609.02823"])
        self.assertEqual(
            derived["snapshotProvenance"]["2609.02823"]["expectedVersion"], 2
        )

    def test_catalog_v1_uses_exact_v1_snapshot_even_when_unobserved_v2_head_exists(self) -> None:
        run_id = self.start()
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=1,
            references=[],
        )
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=2,
            references=["2610.00001"],
        )
        derived = self.ledger.mapped_citations(["2609.02823", "2610.00001"])
        self.assertEqual(derived["snapshotProvenance"]["2609.02823"]["version"], 1)
        self.assertEqual(
            derived["snapshotProvenance"]["2609.02823"]["availableVersions"],
            [1, 2],
        )
        self.assertEqual(derived["outgoing"]["2609.02823"], [])

    def test_cursors_promote_only_after_complete_coverage(self) -> None:
        run_id = self.start()
        self.ledger.stage_cursor(
            run_id=run_id, lane="search", key="lz-query", value={"lastId": "2610.00001"}
        )
        self.ledger.stage_author_cursor(
            run_id=run_id, author="  Marie   Curie ", value={"lastId": "2610.00002"}
        )
        self.assertIsNone(self.ledger.get_cursor("search", "lz-query"))
        self.complete_lane(run_id)
        result = self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
            public_changes=0,
        )
        self.assertEqual(result["promotedCursors"], 1)
        self.assertEqual(result["promotedAuthors"], 1)
        self.assertEqual(
            self.ledger.get_cursor("search", "lz-query"), {"lastId": "2610.00001"}
        )
        author = self.ledger.connection.execute("SELECT * FROM authors").fetchone()
        self.assertEqual(author["author_key"], "marie curie")
        self.assertEqual(
            self.ledger.get_author_cursor("MARIE  CURIE"), {"lastId": "2610.00002"}
        )

    def test_failed_run_does_not_promote_cursor(self) -> None:
        run_id = self.start()
        self.ledger.stage_cursor(run_id=run_id, lane="search", key="q", value=10)
        self.ledger.abort_run(run_id, {"error": "throttled"})
        self.assertIsNone(self.ledger.get_cursor("search", "q"))

    def test_completion_fails_closed_for_missing_or_deferred_lane(self) -> None:
        run_id = self.start(lanes=("listings", "searches"))
        self.complete_lane(run_id, "listings")
        self.ledger.set_lane(run_id, "searches", "deferred", {"status": 429})
        with self.assertRaises(IncompleteRunError):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
            )
        row = self.ledger.connection.execute(
            "SELECT status FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        self.assertEqual(row["status"], "running")

    def test_completion_fails_closed_until_discoveries_are_hydrated_and_screened(self) -> None:
        run_id = self.start()
        self.ledger.record_listing_batch(
            run_id=run_id,
            source="targeted-search",
            batch_key="new",
            ids=["2610.00001"],
        )
        self.ledger.stage_cursor(
            run_id=run_id, lane="search", key="targeted-search", value={"frontier": ["2610.00001"]}
        )
        self.complete_lane(run_id)
        with self.assertRaisesRegex(IncompleteRunError, "unhydrated discovery"):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
            )
        self.assertIsNone(self.ledger.get_cursor("search", "targeted-search"))

        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            metadata={
                "title": "Candidate",
                "authors": ["Candidate Author"],
                "abstract": "Possibly relevant.",
                "submitted": "2026-10-01",
                "updated": "2026-10-01",
            },
        )
        with self.assertRaisesRegex(IncompleteRunError, "pending/changed"):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
            )
        self.assertIsNone(self.ledger.get_cursor("search", "targeted-search"))

        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            decision="excluded",
        )
        self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
        )
        self.assertEqual(
            self.ledger.get_cursor("search", "targeted-search"),
            {"frontier": ["2610.00001"]},
        )

    def test_accepted_new_paper_remains_durable_until_catalog_bootstrap(self) -> None:
        run_id = self.start()
        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            metadata={
                "title": "Accepted explanation",
                "authors": ["Accepted Author"],
                "abstract": "Relevant to LZ.",
                "submitted": "2026-10-01",
                "updated": "2026-10-01",
            },
        )
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            decision="relevant",
        )
        bundle = self.ledger.review_bundle()
        self.assertEqual(bundle["candidateCount"], 1)
        self.assertEqual(bundle["candidates"][0]["reason"], "accepted_unpublished")
        self.assertEqual(bundle["candidates"][0]["screeningStatus"], "relevant")
        self.complete_lane(run_id)
        with self.assertRaisesRegex(IncompleteRunError, "exact-version complete reference"):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
                public_changes=1,
            )
        self.ledger.record_reference_snapshot(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            references=[],
        )
        with self.assertRaisesRegex(IncompleteRunError, "accepted but unpublished"):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
                public_changes=0,
            )
        completed = self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
            public_changes=1,
        )
        self.assertEqual(completed["acceptedUnpublished"], 1)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 1)

        merged_catalog = self.root / "merged-landscape.json"
        merged_catalog.write_text(
            json.dumps(
                landscape(
                    [
                        {
                            "id": "2609.02823",
                            "arxivId": "2609.02823",
                            "arxivVersion": 1,
                            "title": "The observation",
                            "authors": ["LZ Collaboration"],
                            "published": "2026-09-02",
                            "updated": "2026-09-02",
                        },
                        {
                            "id": "2610.00001",
                            "arxivId": "2610.00001",
                            "arxivVersion": 1,
                            "title": "Accepted explanation",
                            "authors": ["Accepted Author"],
                            "published": "2026-10-01",
                            "updated": "2026-10-01",
                        },
                    ]
                )
            ),
            encoding="utf-8",
        )
        self.ledger.bootstrap_landscape(merged_catalog)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 0)

    def test_accepted_revision_is_reemitted_until_catalog_catches_up(self) -> None:
        run_id = self.start()
        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=2,
            metadata={
                "title": "The observation",
                "authors": ["LZ Collaboration"],
                "abstract": "Revised source.",
                "submitted": "2026-09-02",
                "updated": "2026-10-01",
            },
        )
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2609.02823",
            version=2,
            decision="relevant",
        )
        candidate = self.ledger.review_bundle()["candidates"][0]
        self.assertEqual(candidate["reason"], "accepted_revision_unpublished")
        self.assertEqual(candidate["screeningStatus"], "relevant")

    def test_ambiguous_decision_remains_durable_until_candidate_log_bootstrap(self) -> None:
        run_id = self.start()
        observed = self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00003",
            version=1,
            metadata={
                "title": "Possibly relevant",
                "authors": ["Careful Reviewer"],
                "abstract": "Requires human judgment.",
                "submitted": "2026-10-01",
                "updated": "2026-10-01",
            },
        )
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00003",
            version=1,
            decision="ambiguous",
        )
        candidate = self.ledger.review_bundle()["candidates"][0]
        self.assertEqual(candidate["reason"], "ambiguous_unpublished")
        self.assertEqual(candidate["screeningStatus"], "ambiguous")
        self.complete_lane(run_id)
        with self.assertRaisesRegex(IncompleteRunError, "ambiguous but unpublished"):
            self.ledger.complete_run(
                run_id=run_id,
                coverage_start="2026-09-29",
                coverage_end="2026-10-01",
                public_changes=0,
            )
        completed = self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
            public_changes=1,
        )
        self.assertEqual(completed["ambiguousUnpublished"], 1)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 1)

        candidate_log = self.root / "candidates.json"
        candidate_log.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "items": [
                        {
                            "arxivId": "2610.00003",
                            "version": 1,
                            "metadataSha256": observed["metadataSha256"],
                            "status": "ambiguous",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        invalid_log = self.root / "invalid-candidates.json"
        invalid_log.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "items": [
                        {
                            "arxivId": "2610.00003",
                            "version": 1,
                            "metadataSha256": observed["metadataSha256"],
                            "status": "excluded",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(LedgerError, "status must be 'ambiguous'"):
            self.ledger.bootstrap_candidate_log(invalid_log)
        imported = self.ledger.bootstrap_candidate_log(candidate_log)
        self.assertEqual(imported["candidateLogEntries"], 1)
        self.assertEqual(self.ledger.review_bundle()["candidateCount"], 0)

    def test_no_change_day_advances_private_coverage(self) -> None:
        run_id = self.start()
        self.complete_lane(run_id, status="no_change")
        self.ledger.complete_run(
            run_id=run_id,
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
            public_changes=0,
        )
        coverage = self.ledger.get_metadata("last_completed_coverage")
        self.assertEqual(coverage["coverageEnd"], "2026-10-01")
        self.assertEqual(coverage["publicChanges"], 0)
        plan = self.ledger.plan(through="2026-10-02", overlap_days=2)
        self.assertEqual(plan["coverage"], {"start": "2026-09-29", "end": "2026-10-02"})

    def test_planned_coverage_is_bound_to_the_run(self) -> None:
        with self.assertRaisesRegex(ValueError, "daily runs require both"):
            self.ledger.start_run(
                run_id="invalid-plan",
                coverage_start="2026-09-29",
                required_lanes=("listings",),
            )
        started = self.ledger.start_run(
            run_id="planned-run",
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
            required_lanes=("listings",),
        )
        self.assertEqual(
            started["plannedCoverage"], {"start": "2026-09-29", "end": "2026-10-01"}
        )
        self.complete_lane("planned-run")
        with self.assertRaisesRegex(IncompleteRunError, "does not match the run plan"):
            self.ledger.complete_run(
                run_id="planned-run",
                coverage_start="2026-09-30",
                coverage_end="2026-10-01",
            )
        completed = self.ledger.complete_run(
            run_id="planned-run",
            coverage_start="2026-09-29",
            coverage_end="2026-10-01",
        )
        self.assertEqual(completed["status"], "completed")

    def test_daily_run_requires_explicit_coverage_interval(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "daily runs require both coverage_start and coverage_end"
        ):
            self.ledger.start_run(run_id="unbounded-daily")

        unbounded_test = self.ledger.start_run(
            run_id="unbounded-test", kind="test", required_lanes=("setup",)
        )
        self.assertIsNone(unbounded_test["plannedCoverage"])

    def test_author_keys_are_unicode_normalized_and_unique(self) -> None:
        self.assertEqual(normalize_author("  JOSÉ   García "), normalize_author("Jose\u0301 García"))
        run_id = self.start()
        self.ledger.stage_author_cursor(run_id=run_id, author="JOSÉ García", value={"n": 1})
        self.ledger.stage_author_cursor(run_id=run_id, author="Jose\u0301  García", value={"n": 2})
        staged = self.ledger.connection.execute(
            "SELECT COUNT(*) FROM author_cursor_updates"
        ).fetchone()[0]
        self.assertEqual(staged, 1)

    def test_only_relevant_candidate_authors_enter_rotation(self) -> None:
        run_id = self.start()
        common = {
            "abstract": "Candidate.",
            "submitted": "2026-10-01",
            "updated": "2026-10-01",
        }
        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            metadata={
                **common,
                "title": "False positive",
                "authors": ["Recursive False Positive"],
            },
        )
        self.assertIsNone(
            self.ledger.connection.execute(
                "SELECT 1 FROM author_registry WHERE author_key = ?",
                (normalize_author("Recursive False Positive"),),
            ).fetchone()
        )
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00001",
            version=1,
            decision="excluded",
        )
        self.assertIsNone(
            self.ledger.connection.execute(
                "SELECT 1 FROM author_registry WHERE author_key = ?",
                (normalize_author("Recursive False Positive"),),
            ).fetchone()
        )

        self.ledger.observe_paper(
            run_id=run_id,
            arxiv_id="2610.00002",
            version=1,
            metadata={
                **common,
                "title": "Relevant result",
                "authors": ["Relevant Researcher"],
            },
        )
        self.ledger.screen_paper(
            run_id=run_id,
            arxiv_id="2610.00002",
            version=1,
            decision="relevant",
        )
        registered = self.ledger.connection.execute(
            "SELECT source FROM author_registry WHERE author_key = ?",
            (normalize_author("Relevant Researcher"),),
        ).fetchone()
        self.assertEqual(registered["source"], "relevant-paper")

    def test_rebuild_archives_exact_old_database_and_bootstraps_fresh_state(self) -> None:
        self.ledger.close()
        result = Ledger.rebuild(self.state, landscape_path=self.landscape)
        self.assertTrue(self.state.exists())
        self.assertIsNotNone(result["backup"])
        self.assertTrue(Path(result["backup"]).exists())
        with Ledger(self.state) as rebuilt:
            self.assertEqual(rebuilt.status()["counts"]["catalog_papers"], 1)
            self.assertEqual(rebuilt.status()["counts"]["runs"], 0)
        self.ledger = Ledger(self.state)


class HelpersAndCliTest(unittest.TestCase):
    def test_schema_v1_migrates_idempotently_to_exact_version_state(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "v1.sqlite3"
            connection = sqlite3.connect(state)
            connection.executescript(
                """
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE catalog_papers (
                    arxiv_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    authors_json TEXT NOT NULL,
                    published TEXT,
                    updated TEXT,
                    catalog_fingerprint TEXT NOT NULL,
                    bootstrapped_at TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                """
            )
            connection.commit()
            connection.close()
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.initialize()
                self.assertEqual(
                    ledger.connection.execute("PRAGMA user_version").fetchone()[0], 2
                )
                columns = {
                    row["name"]
                    for row in ledger.connection.execute(
                        "PRAGMA table_info(catalog_papers)"
                    )
                }
                self.assertIn("arxiv_version", columns)
                table = ledger.connection.execute(
                    """
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'candidate_log_entries'
                    """
                ).fetchone()
                self.assertIsNotNone(table)

    def test_weekend_announcement_date_rolls_back_to_friday(self) -> None:
        friday = dt.date(2026, 10, 2)
        self.assertEqual(latest_expected_announcement_date(friday), friday)
        self.assertEqual(
            latest_expected_announcement_date(dt.date(2026, 10, 3)), friday
        )
        self.assertEqual(
            latest_expected_announcement_date(dt.date(2026, 10, 4)), friday
        )
        monday = dt.date(2026, 10, 5)
        self.assertEqual(latest_expected_announcement_date(monday), monday)

    def test_plan_uses_weekend_frontier_but_explicit_through_is_exact(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state.sqlite3"
            catalog = Path(root) / "landscape.json"
            catalog.write_text(json.dumps(landscape()), encoding="utf-8")
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(catalog)
                saturday = ledger.plan(today=dt.date(2026, 10, 3), overlap_days=0)
                self.assertEqual(saturday["coverage"]["end"], "2026-10-02")
                explicit = ledger.plan(
                    through="2026-10-04",
                    today=dt.date(2026, 10, 3),
                    overlap_days=0,
                )
                self.assertEqual(explicit["coverage"]["end"], "2026-10-04")

    def test_arxiv_normalization(self) -> None:
        self.assertEqual(normalize_arxiv_id("arXiv:2609.02823v2"), ("2609.02823", 2))
        self.assertEqual(
            normalize_arxiv_id("https://arxiv.org/pdf/hep-ph/9901234v3.pdf"),
            ("hep-ph/9901234", 3),
        )
        with self.assertRaises(ValueError):
            normalize_arxiv_id("not-an-id")

    def test_default_path_honors_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            expected = Path(root) / "custom.sqlite3"
            with mock.patch.dict(os.environ, {"LZ_MAINTENANCE_STATE": str(expected)}):
                self.assertEqual(default_state_path(), expected.resolve())

    def test_cli_smoke_initializes_starts_and_reports_status(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state.sqlite3"
            catalog = Path(root) / "landscape.json"
            catalog.write_text(json.dumps(landscape()), encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = cli_main(
                    [
                        "--state",
                        str(state),
                        "initialize",
                        "--landscape",
                        str(catalog),
                    ]
                )
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue())["catalogPapers"], 1)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = cli_main(["--state", str(state), "status"])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue())["schemaVersion"], 2)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = cli_main(
                    [
                        "--state",
                        str(state),
                        "mapped-citations",
                        "--landscape",
                        str(catalog),
                        "--include-id",
                        "2610.00001",
                    ]
                )
            self.assertEqual(code, 0)
            citations = json.loads(stdout.getvalue())
            self.assertEqual(citations["mappedIds"], ["2609.02823", "2610.00001"])
            self.assertFalse(citations["coverageComplete"])


if __name__ == "__main__":
    unittest.main()
