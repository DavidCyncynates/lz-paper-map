from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.maintenance.harvest import CachedHttpClient
from scripts.maintenance.ledger import ConflictError, Ledger
from scripts.maintenance.references import (
    BibliographyParseError,
    harvest_references,
    parse_manual_snapshots,
    parse_bibliography_html,
    resolve_targets,
)


FIXTURES = Path(__file__).resolve().parent


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeResponse:
    def __init__(self, url: str, body: bytes):
        self._url = url
        self._body = body
        self.headers = {"Content-Type": "text/html; charset=utf-8"}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def read(self, amount: int = -1) -> bytes:
        return self._body if amount < 0 else self._body[:amount]


class MappingOpener:
    def __init__(self, pages: dict[str, bytes]):
        self.pages = pages
        self.requests = []

    def __call__(self, request, timeout: float):
        self.requests.append((request, timeout))
        if request.full_url not in self.pages:
            raise AssertionError(f"unexpected fixture request: {request.full_url}")
        return FakeResponse(request.full_url, self.pages[request.full_url])


class BibliographyParserTests(unittest.TestCase):
    def test_extracts_only_bibliography_ids_and_normalizes_versions(self) -> None:
        snapshot = parse_bibliography_html(
            fixture("references_complete.html"), expected_id="2609.20001"
        )
        self.assertEqual(snapshot.arxiv_id, "2609.20001")
        self.assertEqual(snapshot.version, 2)
        self.assertEqual(
            snapshot.references,
            (
                "2301.11111",
                "2401.99999",
                "2501.12345",
                "2609.00001",
                "hep-ph/9901234",
            ),
        )
        self.assertNotIn("2609.99999", snapshot.references)

    def test_legacy_identifier_is_not_truncated_after_a_hyphen(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.20001v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li>Legacy preprint astro-ph/0610433.</li>
          </ol></section>
        </body></html>
        """
        snapshot = parse_bibliography_html(document, expected_id="2609.20001")
        self.assertEqual(snapshot.references, ("astro-ph/0610433",))

    def test_recognized_empty_bibliography_is_complete(self) -> None:
        snapshot = parse_bibliography_html(
            fixture("references_empty.html"), expected_id="2609.20002"
        )
        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.references, ())

    def test_real_arxiv_watermark_supplies_exact_document_version(self) -> None:
        snapshot = parse_bibliography_html(
            fixture("references_realistic_watermark.html"), expected_id="2609.37561"
        )
        self.assertEqual(snapshot.arxiv_id, "2609.37561")
        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.references, ("2609.02823",))
        self.assertIn("watermark", snapshot.identity_sources)

    def test_prefers_substantive_references_over_reverse_citation_list(self) -> None:
        snapshot = parse_bibliography_html(
            fixture("references_reverse_citations.html"),
            expected_id="2609.33869",
        )
        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.references, ("2501.12345", "2609.02823"))
        self.assertEqual(snapshot.bibliography_containers, 2)
        self.assertNotIn("2609.99998", snapshot.references)
        self.assertNotIn("2609.99999", snapshot.references)

    def test_normalizes_official_lz_preprint_aliases(self) -> None:
        title_document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.01475v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li>Search for dark matter particle interactions in an extended
              nuclear recoil energy window with the LUX-ZEPLIN (LZ) experiment.</li>
          </ol></section>
        </body></html>
        """
        url_document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.01475v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li><a href="https://lz.lbl.gov/wp-content/uploads/sites/6/2026/08/LZ_Preprint_260901_Dark_Matter_EFT_Nuclear_Recoil_Search_at_Higher_Energies.pdf">
              collaboration manuscript</a></li>
          </ol></section>
        </body></html>
        """
        for document in (title_document, url_document):
            snapshot = parse_bibliography_html(document, expected_id="2609.01475")
            self.assertEqual(snapshot.references, ("2609.02823",))

    def test_lz_preprint_filename_on_another_host_is_not_an_alias(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.01475v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li><a href="https://example.test/LZ_Preprint_260901_Dark_Matter_EFT_Nuclear_Recoil_Search_at_Higher_Energies.pdf">
              unrelated mirror</a></li>
          </ol></section>
        </body></html>
        """
        snapshot = parse_bibliography_html(document, expected_id="2609.01475")
        self.assertEqual(snapshot.references, ())

    def test_does_not_infer_lz_alias_from_generic_recoil_language(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.01475v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li>An unrelated low-recoil LUX-ZEPLIN dark-matter search.</li>
          </ol></section>
        </body></html>
        """
        snapshot = parse_bibliography_html(document, expected_id="2609.01475")
        self.assertEqual(snapshot.references, ())

    def test_reverse_citation_list_without_real_references_fails_closed(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.33869v1">
        </head><body>
          <section id="bib" class="ltx_bibliography">
            <h2>References</h2><ul><li>
              <span class="ltx_tag_bibitem">[1]</span>
              <span class="ltx_bib_cited">Cited by: <a href="#S1">section 1</a></span>
            </li></ul>
          </section>
        </body></html>
        """
        with self.assertRaisesRegex(BibliographyParseError, "reverse citation"):
            parse_bibliography_html(document, expected_id="2609.33869")

    def test_multiple_substantive_references_sections_are_merged(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.33869v1">
        </head><body>
          <section><h2>References</h2>
            <li class="ltx_bibitem">First, arXiv:2609.02823.</li>
          </section>
          <section><h2>References</h2>
            <li class="ltx_bibitem">Second, arXiv:2501.12345.</li>
          </section>
        </body></html>
        """
        snapshot = parse_bibliography_html(document, expected_id="2609.33869")
        self.assertEqual(snapshot.references, ("2501.12345", "2609.02823"))

    def test_empty_unmarked_bibitem_fails_closed_as_malformed(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.33869v1">
        </head><body>
          <section><h2>References</h2>
            <li class="ltx_bibitem"><span class="ltx_tag_bibitem">[1]</span></li>
          </section>
        </body></html>
        """
        with self.assertRaisesRegex(BibliographyParseError, "malformed"):
            parse_bibliography_html(document, expected_id="2609.33869")

    def test_nonempty_plain_list_without_reference_content_fails_closed(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.33869v1">
        </head><body>
          <section class="ltx_bibliography"><h2>References</h2><ol>
            <li><span class="ltx_tag_bibitem">[1]</span></li>
          </ol></section>
        </body></html>
        """
        with self.assertRaisesRegex(BibliographyParseError, "malformed"):
            parse_bibliography_html(document, expected_id="2609.33869")

    def test_incomplete_recognized_bibliography_is_not_silently_ignored(self) -> None:
        document = """
        <html><head>
          <link rel="canonical" href="https://arxiv.org/html/2609.33869v1">
        </head><body>
          <section class="ltx_bibliography"><ol>
            <li>Unheaded entry, arXiv:2609.99999.</li>
          </ol></section>
          <section><h2>References</h2>
            <li class="ltx_bibitem">Visible entry, arXiv:2609.02823.</li>
          </section>
        </body></html>
        """
        with self.assertRaisesRegex(BibliographyParseError, "malformed"):
            parse_bibliography_html(document, expected_id="2609.33869")

    def test_missing_bibliography_container_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            BibliographyParseError, "no recognizable bibliography"
        ):
            parse_bibliography_html(
                fixture("references_unrecognized.html"), expected_id="2609.20003"
            )

    def test_identity_and_version_mismatch_fail_closed(self) -> None:
        with self.assertRaisesRegex(BibliographyParseError, "identity mismatch"):
            parse_bibliography_html(
                fixture("references_complete.html"), expected_id="2609.20009"
            )
        with self.assertRaisesRegex(BibliographyParseError, "version mismatch"):
            parse_bibliography_html(
                fixture("references_complete.html"),
                expected_id="2609.20001",
                expected_version=1,
            )

    def test_versionless_canonical_identity_fails_without_expected_version(self) -> None:
        document = """
        <html><head><meta name="citation_arxiv_id" content="2609.20001"></head>
        <body><section class="ltx_bibliography"></section></body></html>
        """
        with self.assertRaisesRegex(BibliographyParseError, "missing canonical version"):
            parse_bibliography_html(document, expected_id="2609.20001")
        with self.assertRaisesRegex(BibliographyParseError, "missing canonical version"):
            parse_bibliography_html(
                document, expected_id="2609.20001", expected_version=1
            )

    def test_manual_snapshot_requires_complete_exact_official_evidence(self) -> None:
        manual = parse_manual_snapshots(
            [
                {
                    "arxivId": "2609.20001v2",
                    "version": 2,
                    "complete": True,
                    "references": ["arXiv:2501.12345v3", "hep-ph/9901234"],
                    "sourceUrl": "https://arxiv.org/pdf/2609.20001v2",
                }
            ]
        )
        self.assertEqual(manual[0].references, ("2501.12345", "hep-ph/9901234"))
        with self.assertRaisesRegex(ValueError, "complete: true"):
            parse_manual_snapshots(
                [
                    {
                        "arxivId": "2609.20001",
                        "version": 2,
                        "complete": False,
                        "references": [],
                        "sourceUrl": "https://arxiv.org/pdf/2609.20001v2",
                    }
                ]
            )
        with self.assertRaisesRegex(ValueError, "exact-version official"):
            parse_manual_snapshots(
                [
                    {
                        "arxivId": "2609.20001",
                        "version": 2,
                        "complete": True,
                        "references": [],
                        "sourceUrl": "https://arxiv.org/pdf/2609.20001v1",
                    }
                ]
            )


class ReferenceHarvestTests(unittest.TestCase):
    def _landscape(self, root: Path) -> Path:
        path = root / "landscape.json"
        path.write_text(
            json.dumps(
                {
                    "papers": [
                        {
                            "id": "2609.20001",
                            "arxivVersion": 2,
                            "title": "One",
                            "authors": ["A. Author"],
                            "published": "2026-09-29",
                            "updated": "2026-09-30",
                        },
                        {
                            "id": "2609.20002",
                            "arxivVersion": 1,
                            "title": "Two",
                            "authors": ["B. Author"],
                            "published": "2026-09-30",
                            "updated": "2026-09-30",
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_ledger_mode_resolves_missing_targets_and_completes_lane(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = self._landscape(root)
            pages = {
                "https://arxiv.org/html/2609.20001v2": fixture(
                    "references_complete.html"
                ).encode(),
                "https://arxiv.org/html/2609.20002v1": fixture(
                    "references_empty.html"
                ).encode(),
            }
            client = CachedHttpClient(
                root / "cache",
                delay_seconds=0,
                opener=MappingOpener(pages),
                sleep=lambda _seconds: None,
            )
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(kind="test", required_lanes=("references",))
                targets, coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertEqual(
                    targets, [("2609.20001", 2), ("2609.20002", 1)]
                )
                self.assertFalse(coverage["coverageComplete"])
                result = harvest_references(
                    targets, client=client, ledger=ledger, run_id=run["runId"]
                )
                self.assertEqual(result["targetCount"], 2)
                after = ledger.mapped_citations(["2609.20001", "2609.20002"])
                self.assertTrue(after["coverageComplete"])
                lane = ledger.connection.execute(
                    "SELECT status FROM run_lanes WHERE run_id = ? AND lane = 'references'",
                    (run["runId"],),
                ).fetchone()
                self.assertEqual(lane["status"], "completed")
                self.assertEqual(after["outgoing"]["2609.20001"], [])

    def test_failed_batch_records_nothing_and_does_not_mark_lane(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pages = {
                "https://arxiv.org/html/2609.20001": fixture(
                    "references_complete.html"
                ).encode(),
                "https://arxiv.org/html/2609.20003": fixture(
                    "references_unrecognized.html"
                ).encode(),
            }
            client = CachedHttpClient(
                root / "cache",
                delay_seconds=0,
                opener=MappingOpener(pages),
                sleep=lambda _seconds: None,
            )
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                run = ledger.start_run(kind="test", required_lanes=("references",))
                with self.assertRaises(BibliographyParseError):
                    harvest_references(
                        [("2609.20001", None), ("2609.20003", None)],
                        client=client,
                        ledger=ledger,
                        run_id=run["runId"],
                    )
                snapshots = ledger.connection.execute(
                    "SELECT COUNT(*) FROM reference_snapshots"
                ).fetchone()[0]
                lanes = ledger.connection.execute(
                    "SELECT COUNT(*) FROM run_lanes WHERE run_id = ?",
                    (run["runId"],),
                ).fetchone()[0]
                self.assertEqual(snapshots, 0)
                self.assertEqual(lanes, 0)

    def test_manual_snapshot_avoids_html_fetch(self) -> None:
        manual = parse_manual_snapshots(
            [
                {
                    "arxivId": "2609.20001",
                    "version": 2,
                    "complete": True,
                    "references": ["2609.02823"],
                    "sourceUrl": "https://arxiv.org/pdf/2609.20001v2",
                }
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener({})
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=opener,
                sleep=lambda _seconds: None,
            )
            result = harvest_references(
                [("2609.20001", 2)], client=client, manual_snapshots=manual
            )
            self.assertEqual(opener.requests, [])
            self.assertEqual(result["documents"][0]["cacheStatus"], "manual")

    def test_recording_conflict_rolls_back_entire_snapshot_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                run = ledger.start_run(kind="test", required_lanes=("references",))
                ledger.record_reference_snapshot(
                    run_id=run["runId"],
                    arxiv_id="2609.20002",
                    version=1,
                    references=["2501.00001"],
                )
                with self.assertRaisesRegex(ConflictError, "different complete"):
                    ledger.record_reference_snapshots_batch(
                        run_id=run["runId"],
                        snapshots=[
                            {
                                "arxiv_id": "2609.20001",
                                "version": 2,
                                "references": [],
                            },
                            {
                                "arxiv_id": "2609.20002",
                                "version": 1,
                                "references": ["2501.00002"],
                            },
                        ],
                    )
                first_count = ledger.connection.execute(
                    "SELECT COUNT(*) FROM reference_snapshots WHERE arxiv_id = ?",
                    ("2609.20001",),
                ).fetchone()[0]
                total_count = ledger.connection.execute(
                    "SELECT COUNT(*) FROM reference_snapshots"
                ).fetchone()[0]
                self.assertEqual(first_count, 0)
                self.assertEqual(total_count, 1)

    def test_stale_target_uses_latest_observed_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = self._landscape(root)
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                first = ledger.start_run(
                    run_id="first", kind="test", required_lanes=("references",)
                )
                ledger.record_reference_snapshot(
                    run_id=first["runId"],
                    arxiv_id="2609.20001",
                    version=1,
                    references=[],
                )
                ledger.abort_run(
                    first["runId"], {"reason": "fixture retains stale snapshot evidence"}
                )
                second = ledger.start_run(
                    run_id="second", kind="test", required_lanes=("references",)
                )
                ledger.observe_paper(
                    run_id=second["runId"],
                    arxiv_id="2609.20001",
                    version=2,
                    metadata={
                        "title": "One",
                        "authors": ["A. Author"],
                        "abstract": "Revised.",
                        "submitted": "2026-09-29",
                        "updated": "2026-09-30",
                    },
                )
                targets, _coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertIn(("2609.20001", 2), targets)

    def test_catalog_version_is_requested_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = root / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "id": "2609.20002",
                                "arxivVersion": 1,
                                "title": "Version-pinned paper",
                                "authors": ["B. Author"],
                                "published": "2026-09-30",
                                "updated": "2026-09-30",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            exact_url = "https://arxiv.org/html/2609.20002v1"
            opener = MappingOpener(
                {exact_url: fixture("references_empty.html").encode()}
            )
            client = CachedHttpClient(
                root / "cache",
                delay_seconds=0,
                opener=opener,
                sleep=lambda _seconds: None,
            )
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(kind="test", required_lanes=("references",))
                targets, _coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertEqual(targets, [("2609.20002", 1)])
                harvest_references(
                    targets,
                    client=client,
                    ledger=ledger,
                    run_id=run["runId"],
                )
                self.assertEqual(opener.requests[0][0].full_url, exact_url)

    def test_accepted_unpublished_version_is_automatically_targeted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = root / "landscape.json"
            landscape.write_text(json.dumps({"papers": []}), encoding="utf-8")
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(kind="test", required_lanes=("references",))
                observed = ledger.observe_paper(
                    run_id=run["runId"],
                    arxiv_id="2610.00001",
                    version=1,
                    metadata={
                        "title": "New relevant paper",
                        "authors": ["A. Author"],
                        "abstract": "Directly studies the event.",
                        "submitted": "2026-10-01",
                        "updated": "2026-10-01",
                    },
                )
                ledger.screen_paper(
                    run_id=run["runId"],
                    arxiv_id="2610.00001",
                    version=1,
                    decision="relevant",
                )
                targets, _coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertEqual(targets, [("2610.00001", 1)])

    def test_only_missing_accepted_versions_are_targeted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = root / "landscape.json"
            landscape.write_text(json.dumps({"papers": []}), encoding="utf-8")
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(kind="test", required_lanes=("references",))
                for version in (1, 2):
                    ledger.observe_paper(
                        run_id=run["runId"],
                        arxiv_id="2610.00001",
                        version=version,
                        metadata={
                            "title": "New relevant paper",
                            "authors": ["A. Author"],
                            "abstract": f"Relevant version {version}.",
                            "submitted": "2026-10-01",
                            "updated": f"2026-10-0{version}",
                        },
                    )
                    ledger.screen_paper(
                        run_id=run["runId"],
                        arxiv_id="2610.00001",
                        version=version,
                        decision="relevant",
                    )
                targets, _coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertEqual(
                    targets, [("2610.00001", 1), ("2610.00001", 2)]
                )

                ledger.record_reference_snapshot(
                    run_id=run["runId"],
                    arxiv_id="2610.00001",
                    version=1,
                    references=[],
                )
                targets, _coverage = resolve_targets(
                    explicit_ids=[], ledger=ledger, landscape_path=landscape
                )
                self.assertEqual(targets, [("2610.00001", 2)])

    def test_explicit_older_version_does_not_conflict_with_mapped_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = root / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "id": "2609.20001",
                                "arxivVersion": 2,
                                "title": "Mapped paper",
                                "authors": ["A. Author"],
                                "published": "2026-09-29",
                                "updated": "2026-09-30",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with Ledger(root / "state.sqlite3") as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                targets, _coverage = resolve_targets(
                    explicit_ids=["2609.20001v1", "2609.20001v2"],
                    ledger=ledger,
                    landscape_path=landscape,
                )
                self.assertEqual(
                    targets, [("2609.20001", 1), ("2609.20001", 2)]
                )


if __name__ == "__main__":
    unittest.main()
