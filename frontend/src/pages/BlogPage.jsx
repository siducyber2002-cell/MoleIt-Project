import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, PenSquare, Loader2, X, Search, SortAsc, SortDesc,
  ArrowRight, Sparkles, Clock, Send,
} from 'lucide-react';
import { fetchBlogPosts, createBlogPost, extractErrorMessage } from '../api/api';
import { useAuth } from '../context/AuthContext';
import { Reveal, StaggerGroup, StaggerItem, Word, EASE } from '../components/motion/ScrollReveal';

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function excerpt(text, max = 220) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

function readingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Solid paper-friendly accents — same "one color per author" idea as
// before, just recolored off the warm-paper palette instead of neon
// gradients on black.
const ACCENTS = ['#3bbff7', '#eea02b', '#1f6d49', '#6c5ce7', '#ff6b4a', '#0f9c8d'];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function accentFor(key) {
  return ACCENTS[hashString(String(key ?? '?')) % ACCENTS.length];
}

function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function Avatar({ name, size = 'md' }) {
  const dims = size === 'lg' ? 36 : 28;
  return (
    <span
      className="bp-avatar"
      style={{ width: dims, height: dims, fontSize: size === 'lg' ? 12 : 10.5, background: accentFor(name) }}
    >
      {initialsFor(name)}
    </span>
  );
}

function PostCardSkeleton() {
  return (
    <div className="bp-card bp-skeleton">
      <div className="bp-skeleton__row">
        <div className="bp-skeleton__dot" />
        <div className="bp-skeleton__bar" style={{ width: '45%' }} />
      </div>
      <div className="bp-skeleton__bar" style={{ width: '75%', height: 14, marginTop: 10 }} />
      <div className="bp-skeleton__bar" style={{ width: '100%', marginTop: 10 }} />
      <div className="bp-skeleton__bar" style={{ width: '85%', marginTop: 6 }} />
    </div>
  );
}

function FeaturedPost({ post }) {
  return (
    <Reveal trigger="mount" className="mb-10 block">
      <Link to={`/blog/${post.id}`} className="bp-feature group">
        <span className="bp-feature__tag">
          <Sparkles size={12} /> Latest post
        </span>
        <h2 className="bp-feature__title">{post.title}</h2>
        <p className="bp-feature__excerpt">{excerpt(post.content, 320)}</p>
        <div className="bp-feature__foot">
          <Avatar name={post.author_name} size="lg" />
          <div className="bp-feature__meta">
            <p className="bp-feature__author">{post.author_name}</p>
            <p className="bp-feature__sub">
              {timeAgo(post.created_at)}
              <span className="bp-dot">·</span>
              <Clock size={11} /> {readingTime(post.content)} min read
            </p>
          </div>
          <span className="bp-feature__cta">
            Read full post <ArrowRight size={15} />
          </span>
        </div>
      </Link>
    </Reveal>
  );
}

function PostCard({ post }) {
  return (
    <StaggerItem as={Link} to={`/blog/${post.id}`} className="bp-card bp-post group">
      <div className="bp-post__head">
        <Avatar name={post.author_name} />
        <div className="bp-post__byline">
          <span className="bp-post__author">{post.author_name}</span>
          <span className="bp-dot">·</span>
          <span>{timeAgo(post.created_at)}</span>
        </div>
      </div>
      <h2 className="bp-post__title">{post.title}</h2>
      <p className="bp-post__excerpt">{excerpt(post.content)}</p>
      <div className="bp-post__foot">
        <Clock size={12} /> {readingTime(post.content)} min read
        <span className="bp-post__read">
          Read <ArrowRight size={12} />
        </span>
      </div>
    </StaggerItem>
  );
}

export default function BlogPage() {
  const { user } = useAuth();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');

  // Paint the warm-paper canvas behind the whole viewport while this page
  // is mounted — same trick the homepage and News page use, scoped so no
  // other route is affected.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-journal');
    return () => root.classList.remove('theme-journal');
  }, []);

  const load = () => {
    setLoading(true);
    fetchBlogPosts()
      .then(setPosts)
      .catch((err) => setError(extractErrorMessage(err, 'Could not load posts.')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handlePublish = async (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setPosting(true);
    setPostError('');
    try {
      const post = await createBlogPost({ title: title.trim(), content: content.trim() });
      setPosts((p) => [post, ...p]);
      setTitle('');
      setContent('');
      setComposerOpen(false);
    } catch (err) {
      setPostError(extractErrorMessage(err, 'Could not publish — try again.'));
    } finally {
      setPosting(false);
    }
  };

  const filteredPosts = useMemo(() => {
    let list = posts;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q) ||
          p.author_name.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) =>
      sortOrder === 'newest'
        ? new Date(b.created_at) - new Date(a.created_at)
        : new Date(a.created_at) - new Date(b.created_at)
    );
  }, [posts, query, sortOrder]);

  const showFeatured = !query.trim() && sortOrder === 'newest' && filteredPosts.length > 0;
  const featuredPost = showFeatured ? filteredPosts[0] : null;
  const gridPosts = showFeatured ? filteredPosts.slice(1) : filteredPosts;

  return (
    <div className="bp">
      <style>{`
        html.theme-journal,
        html.theme-journal body {
          background-color: #f0edea;
          background-image: none;
        }
        html.theme-journal .moleit-logo .text-lab-100 { color: #262626 !important; }

        .bp {
          --bp-bg: #f0edea;
          --bp-card: #fafaf9;
          --bp-ink: #262626;
          --bp-ink-2: #4e4e4d;
          --bp-ink-3: #8a8681;
          --bp-line: rgba(38, 38, 38, 0.12);
          --bp-blue: #3bbff7;
          --bp-orange: #eea02b;
          --bp-violet: #6c5ce7;
          --bp-coral: #ff6b4a;

          position: relative;
          width: 100%;
          max-width: 1080px;
          margin: 0 auto;
          padding: 40px 20px 72px;
          color: var(--bp-ink);
          font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
        }

        .bp-eyebrow {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px; border-radius: 999px;
          background: var(--bp-card); border: 1px solid var(--bp-line);
          font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--bp-blue);
        }
        .bp-h1 {
          margin: 14px 0 0; display: flex; flex-wrap: wrap;
          font-weight: 700; letter-spacing: -0.03em; line-height: 1;
          font-size: clamp(2.4rem, 6vw, 4rem); color: var(--bp-ink);
        }
        .bp-h1 .bp-accent { color: var(--bp-coral); margin-left: 0.28em; }
        .bp-tagline { margin-top: 16px; max-width: 34em; font-size: clamp(0.95rem, 1.2vw, 1.05rem); line-height: 1.6; color: var(--bp-ink-2); }

        .bp-toolbar { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
        .bp-search { position: relative; flex: 1; min-width: 200px; max-width: 320px; }
        .bp-search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--bp-ink-3); pointer-events: none; }
        .bp-search input {
          width: 100%; padding: 10px 12px 10px 34px; border-radius: 10px;
          border: 1px solid var(--bp-line); background: var(--bp-card);
          font-size: 13.5px; color: var(--bp-ink); outline: none; transition: border-color 0.2s;
        }
        .bp-search input:focus { border-color: var(--bp-blue); }
        .bp-pill-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 14px; border-radius: 10px; border: 1px solid var(--bp-line);
          background: var(--bp-card); font-size: 12.5px; font-weight: 600; color: var(--bp-ink-2);
          cursor: pointer; transition: border-color 0.2s, color 0.2s;
        }
        .bp-pill-btn:hover { border-color: var(--bp-blue); color: var(--bp-ink); }
        .bp-count { font-size: 12px; color: var(--bp-ink-3); }
        .bp-write-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 16px; border-radius: 10px; border: 2px solid var(--bp-ink);
          background: var(--bp-ink); color: var(--bp-card); font-size: 13px; font-weight: 700;
          cursor: pointer; transition: background 0.2s, border-color 0.2s, color 0.2s;
        }
        .bp-write-btn:hover { background: var(--bp-coral); border-color: var(--bp-coral); color: #201f1d; }

        .bp-login-note { margin-top: 20px; border-radius: 12px; border: 1px dashed var(--bp-line); background: var(--bp-card); padding: 12px 16px; font-size: 13px; color: var(--bp-ink-2); }
        .bp-login-note a { color: var(--bp-blue); font-weight: 600; text-decoration: underline; }

        .bp-composer { margin-top: 22px; overflow: hidden; border-radius: 16px; border: 1px solid var(--bp-line); background: var(--bp-card); }
        .bp-composer__body { padding: 18px; }
        .bp-composer input, .bp-composer textarea {
          width: 100%; border-radius: 10px; border: 1px solid var(--bp-line);
          background: #fff; padding: 10px 12px; font-size: 13.5px; color: var(--bp-ink);
          outline: none; transition: border-color 0.2s;
        }
        .bp-composer input { font-weight: 700; margin-bottom: 10px; }
        .bp-composer textarea { height: 160px; resize: none; line-height: 1.6; }
        .bp-composer input:focus, .bp-composer textarea:focus { border-color: var(--bp-blue); }
        .bp-composer__foot { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; }
        .bp-composer__count { font-size: 12px; color: var(--bp-ink-3); }
        .bp-publish-btn {
          display: inline-flex; align-items: center; gap: 6px; border-radius: 10px;
          padding: 9px 16px; background: var(--bp-ink); color: var(--bp-card);
          font-size: 13px; font-weight: 700; border: none; cursor: pointer; transition: opacity 0.2s;
        }
        .bp-publish-btn:disabled { opacity: 0.45; cursor: default; }
        .bp-error-text { margin-top: 8px; font-size: 12px; color: #b52424; }

        .bp-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; border-radius: 16px; border: 1px dashed var(--bp-line); background: var(--bp-card); padding: 64px 20px; text-align: center; }
        .bp-empty p { margin: 0; font-size: 13.5px; color: var(--bp-ink-2); }

        .bp-card { border-radius: 16px; border: 1px solid var(--bp-line); background: var(--bp-card); transition: transform 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease; }

        .bp-skeleton { padding: 18px; }
        .bp-skeleton__row { display: flex; align-items: center; gap: 8px; }
        .bp-skeleton__dot { width: 24px; height: 24px; border-radius: 50%; background: var(--bp-line); }
        .bp-skeleton__bar { height: 10px; border-radius: 5px; background: var(--bp-line); animation: bp-pulse 1.4s ease-in-out infinite; }
        @keyframes bp-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

        .bp-feature {
          position: relative; display: block; overflow: hidden; border-radius: 22px;
          border: 1px solid var(--bp-line); background: var(--bp-card);
          padding: clamp(24px, 4vw, 44px); text-decoration: none; color: inherit;
          transition: border-color 0.3s ease;
        }
        .bp-feature:hover { border-color: var(--bp-coral); }
        .bp-feature__tag {
          position: relative; display: inline-flex; align-items: center; gap: 6px;
          padding: 5px 11px; border-radius: 999px; background: rgba(255, 107, 74, 0.12);
          color: #c9451f; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
        }
        .bp-feature__title { margin: 16px 0 0; font-weight: 700; letter-spacing: -0.02em; line-height: 1.12; font-size: clamp(1.6rem, 3.4vw, 2.5rem); color: var(--bp-ink); transition: color 0.25s; }
        .bp-feature:hover .bp-feature__title { color: var(--bp-coral); }
        .bp-feature__excerpt { margin-top: 14px; max-width: 42em; font-size: 14.5px; line-height: 1.65; color: var(--bp-ink-2); }
        .bp-feature__foot { margin-top: 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
        .bp-feature__meta { font-size: 12px; color: var(--bp-ink-3); }
        .bp-feature__author { margin: 0; font-weight: 600; color: var(--bp-ink); }
        .bp-feature__sub { margin: 2px 0 0; display: flex; align-items: center; gap: 6px; }
        .bp-feature__cta { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 700; color: var(--bp-coral); transition: transform 0.25s; }
        .bp-feature:hover .bp-feature__cta { transform: translateX(4px); }
        .bp-dot { color: var(--bp-ink-3); }

        .bp-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-weight: 800; font-family: 'IBM Plex Mono', monospace; flex-shrink: 0; }

        .bp-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
        @media (min-width: 640px) { .bp-grid { grid-template-columns: 1fr 1fr; } }

        .bp-post { display: flex; flex-direction: column; height: 100%; padding: 18px; text-decoration: none; color: inherit; cursor: pointer; }
        .bp-post:hover { transform: translateY(-3px); border-color: var(--bp-blue); box-shadow: 0 14px 30px -20px rgba(38, 38, 38, 0.35); }
        .bp-post__head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
        .bp-post__byline { min-width: 0; font-size: 11.5px; color: var(--bp-ink-3); display: flex; align-items: center; gap: 5px; }
        .bp-post__author { font-weight: 600; color: var(--bp-ink); }
        .bp-post__title { margin: 0; font-weight: 700; font-size: 15.5px; line-height: 1.35; color: var(--bp-ink); }
        .bp-post__excerpt { margin: 7px 0 0; flex: 1; font-size: 13px; line-height: 1.6; color: var(--bp-ink-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .bp-post__foot { margin-top: 14px; display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--bp-ink-3); }
        .bp-post__read { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--bp-blue); opacity: 0; transform: translateX(-4px); transition: opacity 0.25s, transform 0.25s; }
        .bp-post:hover .bp-post__read { opacity: 1; transform: translateX(0); }
      `}</style>

      <div className="bp-eyebrow">
        <BookOpen size={12} /> Community journal
      </div>

      <StaggerGroup as="h1" trigger="mount" className="bp-h1">
        <Word className="mr-3">The</Word>
        <Word className="bp-accent">Blog.</Word>
      </StaggerGroup>

      <Reveal trigger="mount" delay={0.15} as="p" className="bp-tagline">
        Research, updates, and discussion from the Mole It community — real lab notes, quiz-night discoveries, and the odd hot take on IUPAC naming.
      </Reveal>

      <Reveal trigger="mount" delay={0.25} className="bp-toolbar">
        <div className="bp-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search posts…" />
        </div>
        <button type="button" onClick={() => setSortOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))} className="bp-pill-btn">
          {sortOrder === 'newest' ? <SortDesc size={14} /> : <SortAsc size={14} />}
          {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
        </button>
        {!loading && (
          <span className="bp-count">{posts.length} {posts.length === 1 ? 'post' : 'posts'}</span>
        )}
        {user && (
          <button onClick={() => setComposerOpen((o) => !o)} className="bp-write-btn" style={{ marginLeft: 'auto' }}>
            {composerOpen ? <X size={15} /> : <PenSquare size={15} />}
            {composerOpen ? 'Cancel' : 'Write a post'}
          </button>
        )}
      </Reveal>

      {!user && (
        <Reveal trigger="mount" className="bp-login-note">
          <Link to="/login">Log in</Link> to publish your own updates and research.
        </Reveal>
      )}

      <AnimatePresence initial={false}>
        {composerOpen && (
          <motion.form
            key="composer"
            onSubmit={handlePublish}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="bp-composer"
          >
            <div className="bp-composer__body">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title" autoFocus maxLength={200} />
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Share a research update, a lab result, a study tip, whatever's worth telling everyone…"
              />
              {postError && <p className="bp-error-text">{postError}</p>}
              <div className="bp-composer__foot">
                <span className="bp-composer__count">{content.trim() ? `${readingTime(content)} min read` : ''}</span>
                <button type="submit" disabled={posting || !title.trim() || !content.trim()} className="bp-publish-btn">
                  {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {posting ? 'Publishing…' : 'Publish'}
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {loading && (
        <div className="bp-grid" style={{ marginTop: 28 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <PostCardSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && error && <p className="bp-error-text" style={{ marginTop: 20 }}>{error}</p>}

      {!loading && !error && posts.length === 0 && (
        <Reveal trigger="mount" className="bp-empty" style={{ marginTop: 24 }}>
          <motion.span animate={{ y: [0, -6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
            <BookOpen size={26} color="var(--bp-ink-3)" />
          </motion.span>
          <p>No posts yet — be the first to write one.</p>
        </Reveal>
      )}

      {!loading && !error && posts.length > 0 && filteredPosts.length === 0 && (
        <Reveal trigger="mount" className="bp-empty" style={{ marginTop: 24 }}>
          <Search size={22} color="var(--bp-ink-3)" />
          <p>No posts match "{query}".</p>
        </Reveal>
      )}

      {!loading && !error && featuredPost && <div style={{ marginTop: 28 }}><FeaturedPost post={featuredPost} /></div>}

      {!loading && !error && gridPosts.length > 0 && (
        <StaggerGroup className="bp-grid" style={{ marginTop: featuredPost ? 0 : 28 }}>
          {gridPosts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </StaggerGroup>
      )}
    </div>
  );
}