from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

from scripts.maintenance.harvest import (
    CachedHttpClient,
    HarvestConfig,
    HarvestError,
    ParseError,
    _author_search_url,
    harvest,
    parse_abstract_page,
    parse_listing_page,
    parse_search_page,
    split_at_frontier,
)
from scripts.maintenance.ledger import Ledger


FIXTURES = Path(__file__).resolve().parent
LISTING_URL = "https://arxiv.org/list/hep-ph/new?skip=0&show=2000"
SEARCH_URL = (
    "https://arxiv.org/search/?query=LZ&searchtype=all&abstracts=show"
    "&order=-announced_date_first&size=50"
)


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeResponse:
    def __init__(self, url: str, body: bytes, headers: dict[str, str] | None = None):
        self._url = url
        self._body = body
        self.headers = headers or {
            "Content-Type": "text/html; charset=utf-8",
            "ETag": '"fixture-etag"',
            "Last-Modified": "Wed, 30 Sep 2026 10:00:00 GMT",
        }

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


class ParserTests(unittest.TestCase):
    def test_complete_new_listing_is_split_into_immutable_sections(self) -> None:
        batches = parse_listing_page(
            fixture("harvest_listing_complete.html"), source="hep-ph:new"
        )
        self.assertEqual([batch.batch_key for batch in batches], [
            "2026-09-30:new",
            "2026-09-30:replacement",
        ])
        self.assertEqual(batches[0].ids, ("2609.20001", "2609.20002"))
        self.assertEqual(batches[1].ids, ("2609.10001",))

    def test_recent_listing_creates_one_batch_per_date(self) -> None:
        batches = parse_listing_page(
            fixture("harvest_recent_complete.html"), source="hep-ph:recent"
        )
        self.assertEqual([batch.batch_key for batch in batches], [
            "2026-09-29:recent",
            "2026-09-30:recent",
        ])
        self.assertEqual(batches[1].ids, ("2609.20002", "2609.20001"))

    def test_partial_listing_fails_closed(self) -> None:
        with self.assertRaisesRegex(ParseError, "partial"):
            parse_listing_page(
                fixture("harvest_listing_incomplete.html"), source="hep-ph:new"
            )

    def test_zero_entry_listing_preserves_dated_coverage_evidence(self) -> None:
        batches = parse_listing_page(
            fixture("harvest_listing_zero.html"), source="hep-ex:new"
        )
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0].batch_key, "2026-09-30:new")
        self.assertEqual(batches[0].ids, ())

    def test_abstract_page_has_canonical_version_history(self) -> None:
        metadata = parse_abstract_page(
            fixture("harvest_abstract_v2.html"), expected_id="2609.10001"
        )
        self.assertEqual(metadata["version"], 2)
        self.assertEqual(metadata["submitted"], "2026-09-15")
        self.assertEqual(metadata["updated"], "2026-09-29")
        self.assertEqual(metadata["authors"], ["Ada Example", "Benoit Example"])
        self.assertEqual([item["version"] for item in metadata["history"]], [1, 2])

    def test_abstract_identity_mismatch_fails_closed(self) -> None:
        with self.assertRaisesRegex(ParseError, "identity mismatch"):
            parse_abstract_page(
                fixture("harvest_abstract_v2.html"), expected_id="2609.99999"
            )

    def test_search_stops_at_first_frontier_id(self) -> None:
        page = parse_search_page(fixture("harvest_search_page.html"), url=SEARCH_URL)
        new_ids, reached = split_at_frontier(page.ids, ["2609.10001"])
        self.assertEqual(new_ids, ["2609.20001"])
        self.assertTrue(reached)
        self.assertIsNotNone(page.next_url)

    def test_malformed_search_fails_closed(self) -> None:
        with self.assertRaises(ParseError):
            parse_search_page(fixture("harvest_search_malformed.html"), url=SEARCH_URL)


class CacheTests(unittest.TestCase):
    def test_conditional_request_reuses_verified_body(self) -> None:
        body = fixture("harvest_listing_complete.html").encode()
        with tempfile.TemporaryDirectory() as temporary:
            first_opener = MappingOpener({LISTING_URL: body})
            first = CachedHttpClient(
                temporary, delay_seconds=0, opener=first_opener, sleep=lambda _seconds: None
            )
            downloaded = first.fetch(LISTING_URL)
            self.assertEqual(downloaded.cache_status, "network")

            requests = []

            def not_modified(request, timeout: float):
                requests.append(request)
                raise urllib.error.HTTPError(
                    request.full_url,
                    304,
                    "Not Modified",
                    {"ETag": '"fixture-etag"'},
                    None,
                )

            second = CachedHttpClient(
                temporary, delay_seconds=0, opener=not_modified, sleep=lambda _seconds: None
            )
            reused = second.fetch(LISTING_URL)
            self.assertEqual(reused.body, body)
            self.assertEqual(reused.cache_status, "not_modified")
            self.assertEqual(second.metrics.not_modified_hits, 1)
            self.assertEqual(requests[0].get_header("If-none-match"), '"fixture-etag"')

    def test_non_html_response_is_rejected(self) -> None:
        def opener(request, timeout: float):
            return FakeResponse(
                request.full_url,
                b"not html",
                {"Content-Type": "application/json"},
            )

        with tempfile.TemporaryDirectory() as temporary:
            client = CachedHttpClient(
                temporary, delay_seconds=0, opener=opener, sleep=lambda _seconds: None
            )
            with self.assertRaisesRegex(HarvestError, "text/html"):
                client.fetch(LISTING_URL)


class IntegrationTests(unittest.TestCase):
    def test_zero_entry_category_can_close_current_coverage(self) -> None:
        zero_url = "https://arxiv.org/list/hep-ex/new?skip=0&show=2000"
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "overlapDays": 0,
                "listings": [{"name": "hep-ex:new", "url": zero_url}],
                "searches": [],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener(
                    {zero_url: fixture("harvest_listing_zero.html").encode()}
                ),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                bundle = harvest(
                    config, client=client, ledger=ledger, run_id=run["runId"]
                )
                self.assertEqual(bundle["candidateCount"], 0)
                self.assertEqual(bundle["coverage"]["evidence"]["hep-ex"]["latest"], "2026-09-30")
                ledger.complete_run(
                    run_id=run["runId"],
                    coverage_start="2026-09-30",
                    coverage_end="2026-09-30",
                )

    def test_due_author_rotation_is_bounded_and_cursor_staged(self) -> None:
        author_url = _author_search_url("Ada Example")
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "listings": [],
                "searches": [],
                "includeDueAuthors": True,
                "authorLimit": 1,
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            landscape = Path(temporary) / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "id": "2609.10001",
                                "title": "Mapped paper",
                                "authors": ["Ada Example"],
                                "published": "2026-09-15",
                                "updated": "2026-09-15",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            pages = {
                author_url: fixture("harvest_search_page.html").encode(),
                "https://arxiv.org/abs/2609.20001": fixture(
                    "harvest_abstract_v1.html"
                ).encode(),
            }
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener(pages),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                bootstrap = ledger.start_run(kind="test", required_lanes=("setup",))
                ledger.stage_author_cursor(
                    run_id=bootstrap["runId"],
                    author="Ada Example",
                    value={"frontier": ["2609.10001"]},
                )
                ledger.set_lane(bootstrap["runId"], "setup", "completed")
                ledger.complete_run(
                    run_id=bootstrap["runId"],
                    coverage_start="2026-09-29",
                    coverage_end="2026-09-29",
                )
                run = ledger.start_run(
                    kind="test",
                    required_lanes=("listings", "searches", "authors")
                )
                bundle = harvest(
                    config, client=client, ledger=ledger, run_id=run["runId"]
                )
                self.assertEqual(bundle["candidateCount"], 1)
                self.assertEqual(bundle["searches"][0]["kind"], "author")
                staged = ledger.connection.execute(
                    "SELECT value_json FROM author_cursor_updates WHERE run_id = ?",
                    (run["runId"],),
                ).fetchone()
                self.assertEqual(json.loads(staged["value_json"])["frontier"][0], "2609.20001")
                candidate = bundle["candidates"][0]
                ledger.screen_paper(
                    run_id=run["runId"],
                    arxiv_id=candidate["arxivId"],
                    version=candidate["version"],
                    decision="excluded",
                    reason="fixture review",
                )
                ledger.complete_run(
                    run_id=run["runId"],
                    coverage_start="2026-09-30",
                    coverage_end="2026-09-30",
                )
                self.assertEqual(
                    ledger.get_author_cursor("Ada Example")["frontier"][0],
                    "2609.20001",
                )

    def test_broad_listing_is_evidence_not_an_unbounded_candidate_queue(self) -> None:
        listing = fixture("harvest_listing_complete.html").encode()
        config = HarvestConfig.from_json(
            {
                "listings": [{"name": "hep-ph:new", "url": LISTING_URL}],
                "searches": [],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener({LISTING_URL: listing})
            client = CachedHttpClient(
                temporary, delay_seconds=0, opener=opener, sleep=lambda _seconds: None
            )
            bundle = harvest(config, client=client)
            self.assertEqual(bundle["candidateCount"], 0)
            self.assertEqual(len(opener.requests), 1)

    def test_known_replacement_is_hydrated_without_hydrating_new_listing(self) -> None:
        listing = fixture("harvest_listing_complete.html").encode()
        replacement_url = "https://arxiv.org/abs/2609.10001"
        config = HarvestConfig.from_json(
            {
                "listings": [{"name": "hep-ph:new", "url": LISTING_URL}],
                "searches": [],
                "knownVersions": {"2609.10001": 1},
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener(
                {
                    LISTING_URL: listing,
                    replacement_url: fixture("harvest_abstract_v2.html").encode(),
                }
            )
            client = CachedHttpClient(
                temporary, delay_seconds=0, opener=opener, sleep=lambda _seconds: None
            )
            bundle = harvest(config, client=client)
            self.assertEqual(bundle["candidateCount"], 1)
            self.assertEqual(bundle["candidates"][0]["arxivId"], "2609.10001")
            self.assertEqual(bundle["candidates"][0]["version"], 2)

    def test_recent_overlap_hydrates_known_revision(self) -> None:
        recent_url = "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000"
        recent = fixture("harvest_recent_complete.html").replace(
            "2609.20001", "2609.10001"
        )
        config = HarvestConfig.from_json(
            {
                "listings": [{"name": "hep-ph:recent", "url": recent_url}],
                "searches": [],
                "knownVersions": {"2609.10001": 1},
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener(
                {
                    recent_url: recent.encode(),
                    "https://arxiv.org/abs/2609.10001": fixture(
                        "harvest_abstract_v2.html"
                    ).encode(),
                }
            )
            client = CachedHttpClient(
                temporary,
                delay_seconds=0,
                opener=opener,
                sleep=lambda _seconds: None,
            )
            bundle = harvest(config, client=client)
            self.assertEqual(bundle["candidateCount"], 1)
            self.assertEqual(bundle["candidates"][0]["arxivId"], "2609.10001")
            self.assertIn(
                "known-listing:hep-ph:recent:recent",
                bundle["candidates"][0]["reasons"],
            )

    def test_harvest_records_delta_and_stages_cursors(self) -> None:
        listing = fixture("harvest_listing_complete.html").encode()
        search = fixture("harvest_search_page.html").encode()
        abstract_v1 = fixture("harvest_abstract_v1.html")
        abstract_pages = {
            "2609.10001": fixture("harvest_abstract_v2.html").encode(),
            "2609.20001": abstract_v1.encode(),
        }
        pages = {LISTING_URL: listing, SEARCH_URL: search}
        pages.update(
            {f"https://arxiv.org/abs/{identifier}": body for identifier, body in abstract_pages.items()}
        )
        config = HarvestConfig.from_json(
            {
                "schemaVersion": 1,
                "coverageThrough": "2026-09-30",
                "overlapDays": 0,
                "listings": [{"name": "hep-ph:new", "url": LISTING_URL}],
                "searches": [
                    {
                        "name": "all:LZ",
                        "url": SEARCH_URL,
                        "frontier": ["2609.00001"],
                        "maxPages": 1,
                    }
                ],
            }
        )

        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            cache = Path(temporary) / "cache"
            opener = MappingOpener(pages)
            client = CachedHttpClient(
                cache, delay_seconds=0, opener=opener, sleep=lambda _seconds: None
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                bundle = harvest(config, client=client, ledger=ledger, run_id=run["runId"])
                self.assertEqual(bundle["candidateCount"], 2)
                self.assertNotIn("ids", bundle["listings"][0]["batches"][0])
                self.assertIn("idsSha256", bundle["listings"][0]["batches"][0])
                self.assertNotIn("ids", bundle["searches"][0]["pages"][0])
                self.assertEqual(
                    [candidate["arxivId"] for candidate in bundle["candidates"]],
                    ["2609.10001", "2609.20001"],
                )
                cursor = ledger.connection.execute(
                    "SELECT value_json FROM cursor_updates WHERE run_id = ? AND cursor_key = ?",
                    (run["runId"], "all:LZ"),
                ).fetchone()
                self.assertIsNotNone(cursor)
                self.assertEqual(json.loads(cursor["value_json"])["frontier"][0], "2609.20001")
                for candidate in bundle["candidates"]:
                    ledger.screen_paper(
                        run_id=run["runId"],
                        arxiv_id=candidate["arxivId"],
                        version=candidate["version"],
                        decision="excluded",
                        reason="fixture review",
                    )
                complete = ledger.complete_run(
                    run_id=run["runId"],
                    coverage_start="2026-09-30",
                    coverage_end="2026-09-30",
                )
                self.assertEqual(complete["status"], "completed")

    def test_search_hit_hydrates_revision_of_an_already_known_id(self) -> None:
        revised_20001 = fixture("harvest_abstract_v2.html").replace(
            "2609.10001", "2609.20001"
        )
        config = HarvestConfig.from_json(
            {
                "listings": [],
                "knownVersions": {"2609.20001": 1, "2609.10001": 2},
                "searches": [
                    {
                        "name": "all:LZ",
                        "url": SEARCH_URL,
                        "frontier": ["2609.00001"],
                        "maxPages": 1,
                    }
                ],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener(
                {
                    SEARCH_URL: fixture("harvest_search_page.html").encode(),
                    "https://arxiv.org/abs/2609.20001": revised_20001.encode(),
                    "https://arxiv.org/abs/2609.10001": fixture(
                        "harvest_abstract_v2.html"
                    ).encode(),
                }
            )
            client = CachedHttpClient(
                temporary,
                delay_seconds=0,
                opener=opener,
                sleep=lambda _seconds: None,
            )
            bundle = harvest(config, client=client)
            self.assertEqual(bundle["candidateCount"], 1)
            self.assertEqual(bundle["candidates"][0]["arxivId"], "2609.20001")
            self.assertEqual(bundle["candidates"][0]["version"], 2)

    def test_listing_retention_gap_fails_before_coverage_advances(self) -> None:
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "overlapDays": 2,
                "listings": [
                    {
                        "name": "hep-ph:recent",
                        "url": "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000",
                    }
                ],
                "searches": [],
            }
        )
        recent_url = config.listings[0].url
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            landscape = Path(temporary) / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "lastSuccessfulScan": "2026-09-20T11:00:00Z",
                        "papers": [],
                    }
                ),
                encoding="utf-8",
            )
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener(
                    {recent_url: fixture("harvest_recent_complete.html").encode()}
                ),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                with self.assertRaisesRegex(HarvestError, "manual backfill"):
                    harvest(config, client=client, ledger=ledger, run_id=run["runId"])
                lanes = ledger.connection.execute(
                    "SELECT COUNT(*) FROM run_lanes WHERE run_id = ?", (run["runId"],)
                ).fetchone()[0]
                self.assertEqual(lanes, 0)

    def test_listing_that_has_not_reached_weekday_update_fails_closed(self) -> None:
        recent_url = "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000"
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-10-01",
                "overlapDays": 2,
                "listings": [{"name": "hep-ph:recent", "url": recent_url}],
                "searches": [],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener(
                    {recent_url: fixture("harvest_recent_complete.html").encode()}
                ),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                with self.assertRaisesRegex(HarvestError, "expected arXiv announcement"):
                    harvest(config, client=client, ledger=ledger, run_id=run["runId"])

    def test_weekend_coverage_expects_friday(self) -> None:
        recent_url = "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000"
        weekend_html = (
            fixture("harvest_recent_complete.html")
            .replace("Wed, 30 Sep 2026", "Fri, 2 Oct 2026")
            .replace("Tue, 29 Sep 2026", "Thu, 1 Oct 2026")
        )
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-10-03",
                "overlapDays": 2,
                "listings": [{"name": "hep-ph:recent", "url": recent_url}],
                "searches": [],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener({recent_url: weekend_html.encode()}),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                bundle = harvest(
                    config, client=client, ledger=ledger, run_id=run["runId"]
                )
                self.assertEqual(
                    bundle["coverage"]["planned"]["expectedLatest"],
                    "2026-10-02",
                )

    def test_harvest_rejects_run_bound_coverage_that_skips_planned_day(self) -> None:
        recent_url = "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000"
        shifted_html = (
            fixture("harvest_recent_complete.html")
            .replace("Wed, 30 Sep 2026", "Fri, 2 Oct 2026")
            .replace("Tue, 29 Sep 2026", "Thu, 1 Oct 2026")
        )
        config = HarvestConfig.from_json(
            {
                "overlapDays": 2,
                "listings": [{"name": "hep-ph:recent", "url": recent_url}],
                "searches": [],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener({recent_url: shifted_html.encode()}),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                run = ledger.start_run(
                    required_lanes=("listings", "searches"),
                    coverage_start="2026-10-01",
                    coverage_end="2026-10-02",
                )
                with self.assertRaisesRegex(
                    HarvestError,
                    r"does not match the durable next coverage plan.*"
                    r"bound 2026-10-01\.\.2026-10-02.*"
                    r"expected 2026-09-30\.\.2026-10-02",
                ):
                    harvest(config, client=client, ledger=ledger, run_id=run["runId"])
                self.assertEqual(client.metrics.logical_requests, 0)

    def test_unchanged_date_batches_replay_when_surrounding_page_changes(self) -> None:
        recent_url = "https://arxiv.org/list/hep-ph/recent?skip=0&show=2000"
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "overlapDays": 1,
                "listings": [{"name": "hep-ph:recent", "url": recent_url}],
                "searches": [],
            }
        )
        original = fixture("harvest_recent_complete.html")
        changed_shell = original.replace("</body>", "<p>Changed site banner</p></body>")
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            with Ledger(state) as ledger:
                ledger.initialize()
                first_run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                first_client = CachedHttpClient(
                    Path(temporary) / "cache-one",
                    delay_seconds=0,
                    opener=MappingOpener({recent_url: original.encode()}),
                    sleep=lambda _seconds: None,
                )
                first = harvest(
                    config, client=first_client, ledger=ledger, run_id=first_run["runId"]
                )
                self.assertNotEqual(first["listings"][0]["contentSha256"], "")
                ledger.complete_run(
                    run_id=first_run["runId"],
                    coverage_start="2026-09-29",
                    coverage_end="2026-09-30",
                )

                second_run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                second_client = CachedHttpClient(
                    Path(temporary) / "cache-two",
                    delay_seconds=0,
                    opener=MappingOpener({recent_url: changed_shell.encode()}),
                    sleep=lambda _seconds: None,
                )
                second = harvest(
                    config, client=second_client, ledger=ledger, run_id=second_run["runId"]
                )
                self.assertNotEqual(
                    first["listings"][0]["contentSha256"],
                    second["listings"][0]["contentSha256"],
                )
                self.assertTrue(
                    all(batch["replayed"] for batch in second["listings"][0]["batches"])
                )
                ledger.complete_run(
                    run_id=second_run["runId"],
                    coverage_start="2026-09-29",
                    coverage_end="2026-09-30",
                )
                count = ledger.connection.execute(
                    "SELECT COUNT(*) FROM listing_batches"
                ).fetchone()[0]
                self.assertEqual(count, 2)

    def test_identical_search_page_replays_after_frontier_advances(self) -> None:
        search = fixture("harvest_search_page.html").encode()
        abstract_v1 = fixture("harvest_abstract_v1.html")
        pages = {
            SEARCH_URL: search,
            "https://arxiv.org/abs/2609.20001": abstract_v1.encode(),
            "https://arxiv.org/abs/2609.10001": fixture("harvest_abstract_v2.html").encode(),
        }
        config = HarvestConfig.from_json(
            {
                "listings": [],
                # A real query-local frontier is replayed after interruption.
                "searches": [
                    {
                        "name": "all:LZ",
                        "url": SEARCH_URL,
                        "maxPages": 1,
                        "frontier": ["2609.00001"],
                    }
                ],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            cache = Path(temporary) / "cache"
            landscape = Path(temporary) / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "id": "2609.00001",
                                "title": "Frontier paper",
                                "authors": ["Frontier Author"],
                                "published": "2026-09-01",
                                "updated": "2026-09-01",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                first_run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                first_client = CachedHttpClient(
                    cache,
                    delay_seconds=0,
                    opener=MappingOpener(pages),
                    sleep=lambda _seconds: None,
                )
                first = harvest(
                    config,
                    client=first_client,
                    ledger=ledger,
                    run_id=first_run["runId"],
                )
                self.assertEqual(first["candidateCount"], 2)
                # Simulate an interruption after hydration but before review or
                # cursor promotion.  The next run must recover these candidates.
                ledger.abort_run(first_run["runId"], {"reason": "fixture interruption"})

                second_run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                second_client = CachedHttpClient(
                    cache,
                    delay_seconds=0,
                    cache_max_age_seconds=3600,
                    opener=MappingOpener({}),
                    sleep=lambda _seconds: None,
                )
                second = harvest(
                    config,
                    client=second_client,
                    ledger=ledger,
                    run_id=second_run["runId"],
                )
                self.assertEqual(second["candidateCount"], 2)
                self.assertEqual(
                    [candidate["arxivId"] for candidate in second["candidates"]],
                    ["2609.10001", "2609.20001"],
                )
                # Above-frontier known IDs are still version-checked, but the
                # recent verified abstract cache avoids network refetches.
                self.assertEqual(second_client.metrics.logical_requests, 3)
                self.assertEqual(second_client.metrics.network_requests, 0)
                for candidate in second["candidates"]:
                    ledger.screen_paper(
                        run_id=second_run["runId"],
                        arxiv_id=candidate["arxivId"],
                        version=candidate["version"],
                        decision="excluded",
                        reason="fixture review after resume",
                    )
                ledger.complete_run(
                    run_id=second_run["runId"],
                    coverage_start="2026-09-30",
                    coverage_end="2026-09-30",
                )
                count = ledger.connection.execute(
                    "SELECT COUNT(*) FROM listing_batches"
                ).fetchone()[0]
                self.assertEqual(count, 2)  # one page snapshot plus one first-run delta

    def test_current_legacy_scan_uses_forward_baseline_not_a_mapped_id(self) -> None:
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "listings": [],
                "searches": [{"name": "all:LZ", "url": SEARCH_URL, "maxPages": 1}],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            landscape = Path(temporary) / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "lastSuccessfulScan": "2026-09-30T09:46:25Z",
                        "papers": [
                            {
                                "id": "2609.10001",
                                "title": "Mapped paper in the middle of the result page",
                                "authors": ["Ada Example"],
                                "published": "2026-09-15",
                                "updated": "2026-09-15",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            client = CachedHttpClient(
                Path(temporary) / "cache",
                delay_seconds=0,
                opener=MappingOpener(
                    {SEARCH_URL: fixture("harvest_search_page.html").encode()}
                ),
                sleep=lambda _seconds: None,
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                bundle = harvest(
                    config, client=client, ledger=ledger, run_id=run["runId"]
                )
                self.assertEqual(bundle["candidateCount"], 0)
                self.assertTrue(bundle["searches"][0]["bootstrapForward"])
                self.assertEqual(bundle["searches"][0]["newIds"], [])
                staged = ledger.connection.execute(
                    "SELECT value_json FROM cursor_updates WHERE run_id = ? AND cursor_key = ?",
                    (run["runId"], "all:LZ"),
                ).fetchone()
                self.assertEqual(
                    json.loads(staged["value_json"])["frontier"],
                    ["2609.20001", "2609.10001", "2609.00001"],
                )

    def test_stale_legacy_scan_cannot_synthesize_a_search_frontier(self) -> None:
        config = HarvestConfig.from_json(
            {
                "coverageThrough": "2026-09-30",
                "listings": [],
                "searches": [{"name": "all:LZ", "url": SEARCH_URL}],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.sqlite3"
            landscape = Path(temporary) / "landscape.json"
            landscape.write_text(
                json.dumps(
                    {
                        "lastSuccessfulScan": "2026-09-29T09:20:12Z",
                        "papers": [],
                    }
                ),
                encoding="utf-8",
            )
            with Ledger(state) as ledger:
                ledger.initialize()
                ledger.bootstrap_landscape(landscape)
                run = ledger.start_run(
                    kind="test", required_lanes=("listings", "searches")
                )
                client = CachedHttpClient(Path(temporary) / "cache", delay_seconds=0)
                with self.assertRaisesRegex(HarvestError, "same-announcement-date"):
                    harvest(
                        config, client=client, ledger=ledger, run_id=run["runId"]
                    )

    def test_candidate_limit_stops_before_any_abstract_fetch(self) -> None:
        config = HarvestConfig.from_json(
            {
                "reviewLimit": 1,
                "listings": [],
                "searches": [
                    {
                        "name": "all:LZ",
                        "url": SEARCH_URL,
                        "frontier": ["2609.00001"],
                        "maxPages": 1,
                    }
                ],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            opener = MappingOpener(
                {SEARCH_URL: fixture("harvest_search_page.html").encode()}
            )
            client = CachedHttpClient(
                temporary,
                delay_seconds=0,
                opener=opener,
                sleep=lambda _seconds: None,
            )
            with self.assertRaisesRegex(HarvestError, "would exceed reviewLimit"):
                harvest(config, client=client)
            self.assertEqual(len(opener.requests), 1)

    def test_exhaustive_search_rejects_missing_rows_without_next_page(self) -> None:
        truncated = fixture("harvest_search_page.html").replace(
            "3 results for", "4 results for"
        ).replace(
            '<a class="pagination-next" href="/search/?query=LZ&amp;searchtype=all&amp;abstracts=show&amp;order=-announced_date_first&amp;size=50&amp;start=50">Next</a>',
            "",
        )
        config = HarvestConfig.from_json(
            {
                "listings": [],
                "searches": [
                    {
                        "name": "all:LZ",
                        "url": SEARCH_URL,
                        "maxPages": 1,
                        "exhaustive": True,
                    }
                ],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            client = CachedHttpClient(
                temporary,
                delay_seconds=0,
                opener=MappingOpener({SEARCH_URL: truncated.encode()}),
                sleep=lambda _seconds: None,
            )
            with self.assertRaisesRegex(HarvestError, "states 4 results"):
                harvest(config, client=client)

    def test_standalone_search_without_frontier_is_rejected(self) -> None:
        config = HarvestConfig.from_json(
            {"searches": [{"name": "all:LZ", "url": SEARCH_URL}], "listings": []}
        )
        with tempfile.TemporaryDirectory() as temporary:
            client = CachedHttpClient(temporary, delay_seconds=0)
            with self.assertRaisesRegex(HarvestError, "needs a committed"):
                harvest(config, client=client)


if __name__ == "__main__":
    unittest.main()
