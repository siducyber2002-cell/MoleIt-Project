"""Chemistry & science news via public RSS feeds.

No API key or account needed — these are plain public RSS feeds from
established outlets. We fetch each feed with `requests` (so we control the
timeout and User-Agent ourselves) and hand the raw bytes to `feedparser`,
which is far more forgiving of the real-world quirks in RSS/Atom XML than
hand-rolling a parser.

Every fetch is cached into our own DB (see routers/news.py), so a page load
doesn't necessarily mean 5 outbound HTTP requests — only a stale cache does.
"""
import re
import time
from datetime import datetime, timedelta

import feedparser
import requests

from . import models

TIMEOUT = 10
USER_AGENT = "MoleIt-StudyApp/1.0 (chemistry education project; +https://example.com)"

# How long a cached batch is considered fresh before the next request
# triggers a background-ish refresh. Chemistry/science news doesn't move
# minute-to-minute, so a couple of hours is plenty responsive without
# hammering these feeds on every page load.
STALE_AFTER = timedelta(hours=2)

# (display name, feed URL). Kept short and curated rather than exhaustive —
# each entry is checked to be a real, currently-live RSS feed from a
# reputable outlet. Verify these still resolve if you add/swap any; RSS
# feed paths do occasionally get reorganized by the publisher.
FEEDS = [
    ("ScienceDaily — Chemistry", "https://www.sciencedaily.com/rss/matter_energy/chemistry.xml"),
    ("ScienceDaily — Top Science", "https://www.sciencedaily.com/rss/top/science.xml"),
    ("Phys.org — Chemistry", "https://phys.org/rss-feed/chemistry-news/"),
    ("Chemistry World", "https://www.chemistryworld.com/rss/news.xml"),
]

# YouTube exposes a plain Atom feed per channel at this URL shape — no API
# key needed, and feedparser reads it exactly like any other feed (the
# thumbnail comes through the standard media:thumbnail tag, so _entry_image
# picks it up with no extra handling). Find a channel_id via the channel's
# page source (search for "channelId") or a channel-id lookup tool; the
# @handle alone does NOT work in this URL, it has to be the UC... id.
VIDEO_FEEDS = [
    ("NileRed", "https://www.youtube.com/feeds/videos.xml?channel_id=UCFhXFikryT4aFcLkLw2LBLA"),
]
VIDEO_SOURCES = {name for name, _ in VIDEO_FEEDS}

ALL_FEEDS = FEEDS + VIDEO_FEEDS

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _clean_summary(raw: str | None, max_len: int = 320) -> str | None:
    if not raw:
        return None
    text = _TAG_RE.sub(" ", raw)
    text = _WS_RE.sub(" ", text).strip()
    if not text:
        return None
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


def _entry_image(entry) -> str | None:
    media = entry.get("media_content") or entry.get("media_thumbnail")
    if media and isinstance(media, list) and media[0].get("url"):
        return media[0]["url"]
    for enc in entry.get("links", []) or []:
        if str(enc.get("type", "")).startswith("image/") and enc.get("href"):
            return enc["href"]
    return None


def _entry_published(entry) -> datetime | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    try:
        return datetime(*parsed[:6])
    except (TypeError, ValueError):
        return None


def _fetch_one_feed(source_name: str, url: str, limit: int):
    """Returns a list of raw entry dicts for one feed. Never raises — a
    single dead/slow feed shouldn't take the whole news page down; it's
    just skipped and the others still populate."""
    try:
        resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
    except requests.RequestException:
        return []

    parsed = feedparser.parse(resp.content)
    out = []
    for entry in parsed.entries[:limit]:
        link = entry.get("link")
        title = entry.get("title")
        if not link or not title:
            continue
        out.append(
            {
                "title": title.strip(),
                "link": link.strip(),
                "source": source_name,
                "summary": _clean_summary(entry.get("summary") or entry.get("description")),
                "image_url": _entry_image(entry),
                "published_at": _entry_published(entry),
            }
        )
    return out


def fetch_and_cache(db, per_feed_limit: int = 12) -> int:
    """Pulls every configured feed and upserts new articles (by link) into
    the DB. Returns how many *new* articles were added. Safe to call
    repeatedly — existing links are skipped, not duplicated."""
    existing_links = {row[0] for row in db.query(models.NewsArticle.link).all()}
    added = 0
    for source_name, url in ALL_FEEDS:
        for item in _fetch_one_feed(source_name, url, per_feed_limit):
            if item["link"] in existing_links:
                continue
            db.add(models.NewsArticle(**item))
            existing_links.add(item["link"])
            added += 1
    if added:
        db.commit()
    return added


def needs_refresh(db) -> bool:
    latest = db.query(models.NewsArticle.fetched_at).order_by(
        models.NewsArticle.fetched_at.desc()
    ).first()
    if not latest or not latest[0]:
        return True
    return datetime.utcnow() - latest[0] > STALE_AFTER


def get_articles(db, source: str | None = None, limit: int = 60):
    q = db.query(models.NewsArticle)
    if source:
        q = q.filter(models.NewsArticle.source == source)
    # Newest published first; articles with no parsed publish date (a few
    # feeds omit it) fall back to when we fetched them, so they still show
    # up near the top instead of sorting to the bottom under a NULL.
    return (
        q.order_by(
            models.NewsArticle.published_at.desc().nullslast(),
            models.NewsArticle.fetched_at.desc(),
        )
        .limit(limit)
        .all()
    )