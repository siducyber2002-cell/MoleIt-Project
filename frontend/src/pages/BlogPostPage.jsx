import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence, useScroll, useSpring } from 'framer-motion';
import {
  ArrowLeft, Pencil, Trash2, Loader2, Save, X, Paperclip, FileText,
  UploadCloud, Send, MessageSquare, Clock,
} from 'lucide-react';
import {
  fetchBlogPost, updateBlogPost, deleteBlogPost,
  uploadBlogAttachment, deleteBlogAttachment, attachmentUrl,
  fetchBlogComments, createBlogComment, deleteBlogComment,
  extractErrorMessage,
} from '../api/api';
import { useAuth } from '../context/AuthContext';
import { Reveal, EASE } from '../components/motion/ScrollReveal';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function isImageAttachment(att) {
  const ext = '.' + (att.filename.split('.').pop() || '').toLowerCase();
  return IMAGE_EXT.has(ext);
}

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

function readingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Solid paper-friendly accents — same family used on the Blog index and
// News page, so authors/commenters feel consistent across the feature
// without this page looking like a clone of either.
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
  const dims = size === 'lg' ? 44 : 32;
  return (
    <span
      className="bpp-avatar"
      style={{ width: dims, height: dims, fontSize: size === 'lg' ? 13 : 11, background: accentFor(name) }}
    >
      {initialsFor(name)}
    </span>
  );
}

// Slim accent-colored progress rule pinned under the navbar — fills as
// the reader scrolls through the manuscript.
function ReadingProgressBar() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 200, damping: 30, restDelta: 0.001 });
  return <motion.div style={{ scaleX }} className="bpp-progress" />;
}

export default function BlogPostPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState('');

  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [commentError, setCommentError] = useState('');

  // Paint the warm-paper canvas behind the whole viewport while this page
  // is mounted — same trick the rest of the app's light pages use, scoped
  // so no other route is affected.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-manuscript');
    return () => root.classList.remove('theme-manuscript');
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchBlogPost(id)
      .then((data) => {
        setPost(data);
        setTitle(data.title);
        setContent(data.content);
      })
      .catch((err) => setError(extractErrorMessage(err, "Couldn't load this post.")))
      .finally(() => setLoading(false));

    setCommentsLoading(true);
    fetchBlogComments(id)
      .then(setComments)
      .catch(() => {})
      .finally(() => setCommentsLoading(false));
  }, [id]);

  const isAuthor = user && post && user.id === post.author_id;

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    setSaveError('');
    try {
      const updated = await updateBlogPost(id, { title: title.trim(), content: content.trim() });
      setPost(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(extractErrorMessage(err, 'Could not save changes.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this post? This can't be undone.")) return;
    try {
      await deleteBlogPost(id);
      navigate('/blog');
    } catch (err) {
      setSaveError(extractErrorMessage(err, 'Could not delete this post.'));
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setAttachError('');
    try {
      const attachment = await uploadBlogAttachment(id, file);
      setPost((p) => ({ ...p, attachments: [...(p.attachments || []), attachment] }));
    } catch (err) {
      setAttachError(extractErrorMessage(err, 'Upload failed.'));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteAttachment = async (attachmentId) => {
    try {
      await deleteBlogAttachment(id, attachmentId);
      setPost((p) => ({ ...p, attachments: p.attachments.filter((a) => a.id !== attachmentId) }));
    } catch (err) {
      setAttachError(extractErrorMessage(err, 'Could not remove that file.'));
    }
  };

  const handlePostComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    setPostingComment(true);
    setCommentError('');
    try {
      const comment = await createBlogComment(id, commentText.trim());
      setComments((c) => [...c, comment]);
      setCommentText('');
    } catch (err) {
      setCommentError(extractErrorMessage(err, 'Could not post your comment.'));
    } finally {
      setPostingComment(false);
    }
  };

  const handleDeleteComment = async (commentId) => {
    try {
      await deleteBlogComment(id, commentId);
      setComments((c) => c.filter((cm) => cm.id !== commentId));
    } catch {
      setCommentError('Could not delete that comment.');
    }
  };

  const themeStyle = (
    <style>{`
      html.theme-manuscript,
      html.theme-manuscript body {
        background-color: #f0edea;
        background-image: none;
      }
      html.theme-manuscript .moleit-logo .text-lab-100 { color: #262626 !important; }

      .bpp {
        --bpp-bg: #f0edea;
        --bpp-card: #fafaf9;
        --bpp-ink: #262626;
        --bpp-ink-2: #4e4e4d;
        --bpp-ink-3: #8a8681;
        --bpp-line: rgba(38, 38, 38, 0.14);
        --bpp-blue: #3bbff7;
        --bpp-violet: #6c5ce7;

        position: relative;
        width: 100%;
        max-width: 720px;
        margin: 0 auto;
        padding: 30px 20px 72px;
        color: var(--bpp-ink);
        font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
      }

      .bpp-progress {
        position: fixed; inset-inline: 0; top: 0; z-index: 40; height: 3px;
        transform-origin: left; background: linear-gradient(90deg, var(--bpp-blue), var(--bpp-violet));
      }

      .bpp-back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 22px; font-size: 13px; font-weight: 600; color: var(--bpp-ink-3); text-decoration: none; transition: color 0.2s; }
      .bpp-back:hover { color: var(--bpp-blue); }

      .bpp-skel { display: flex; flex-direction: column; gap: 12px; }
      .bpp-skel__bar { border-radius: 6px; background: var(--bpp-line); animation: bpp-pulse 1.4s ease-in-out infinite; }
      @keyframes bpp-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

      .bpp-err { font-size: 13.5px; color: #b52424; }

      /* manuscript body — a rule down the left like a notebook margin */
      .bpp-article { position: relative; padding-left: 22px; border-left: 3px solid var(--bpp-line); }
      .bpp-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .bpp-title { margin: 0; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; font-size: clamp(1.7rem, 4.5vw, 2.6rem); color: var(--bpp-ink); }
      .bpp-icon-btns { display: flex; flex-shrink: 0; gap: 6px; }
      .bpp-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--bpp-line); background: var(--bpp-card); color: var(--bpp-ink-3); cursor: pointer; transition: border-color 0.2s, color 0.2s; }
      .bpp-icon-btn:hover.edit { border-color: var(--bpp-blue); color: var(--bpp-blue); }
      .bpp-icon-btn:hover.del { border-color: #ff6b4a; color: #c9451f; }

      .bpp-byline { display: flex; align-items: center; gap: 10px; margin-bottom: 26px; }
      .bpp-byline__meta { font-size: 12px; color: var(--bpp-ink-3); }
      .bpp-byline__name { margin: 0; font-weight: 700; color: var(--bpp-ink); }
      .bpp-byline__sub { margin: 2px 0 0; display: flex; align-items: center; gap: 6px; }

      .bpp-body { white-space: pre-wrap; font-size: 15px; line-height: 1.8; color: var(--bpp-ink-2); }

      .bpp-editor { border-radius: 16px; border: 1px solid var(--bpp-line); background: var(--bpp-card); padding: 18px; }
      .bpp-editor input, .bpp-editor textarea {
        width: 100%; border-radius: 10px; border: 1px solid var(--bpp-line); background: #fff;
        padding: 10px 12px; color: var(--bpp-ink); outline: none; transition: border-color 0.2s;
      }
      .bpp-editor input { margin-bottom: 12px; font-size: 17px; font-weight: 700; }
      .bpp-editor textarea { height: 220px; resize: none; font-size: 13.5px; line-height: 1.7; }
      .bpp-editor input:focus, .bpp-editor textarea:focus { border-color: var(--bpp-blue); }
      .bpp-editor__foot { margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px; }
      .bpp-cancel-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 9px; border: 1px solid var(--bpp-line); background: transparent; padding: 8px 14px; font-size: 13px; color: var(--bpp-ink-2); cursor: pointer; }
      .bpp-cancel-btn:hover { color: var(--bpp-ink); }
      .bpp-save-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 9px; border: none; background: var(--bpp-ink); color: var(--bpp-card); padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
      .bpp-save-btn:disabled { opacity: 0.5; }

      .bpp-section { margin-top: 34px; padding-top: 22px; border-top: 1px dashed var(--bpp-line); }
      .bpp-section__head { margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
      .bpp-section__title { margin: 0; display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--bpp-ink-3); }
      .bpp-add-file { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--bpp-blue); cursor: pointer; }
      .bpp-add-file:hover { color: var(--bpp-violet); }
      .bpp-hint { font-size: 12.5px; color: var(--bpp-ink-3); }

      .bpp-att-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
      @media (min-width: 560px) { .bpp-att-grid { grid-template-columns: repeat(4, 1fr); } }
      .bpp-att { position: relative; overflow: hidden; border-radius: 12px; border: 1px solid var(--bpp-line); background: var(--bpp-card); }
      .bpp-att__img { height: 78px; width: 100%; object-fit: cover; transition: transform 0.4s ease; }
      .bpp-att:hover .bpp-att__img { transform: scale(1.07); }
      .bpp-att__fallback { display: flex; height: 78px; width: 100%; align-items: center; justify-content: center; color: var(--bpp-ink-3); }
      .bpp-att__name { margin: 0; border-top: 1px solid var(--bpp-line); padding: 6px 8px; font-size: 10.5px; color: var(--bpp-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bpp-att__del { position: absolute; right: 4px; top: 4px; border: none; border-radius: 999px; background: rgba(255,255,255,0.85); padding: 4px; color: var(--bpp-ink-2); opacity: 0; cursor: pointer; transition: opacity 0.2s, color 0.2s; }
      .bpp-att:hover .bpp-att__del { opacity: 1; }
      .bpp-att__del:hover { color: #c9451f; }

      .bpp-comment-form { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }
      .bpp-comment-form input {
        min-width: 0; flex: 1; border-radius: 10px; border: 1px solid var(--bpp-line); background: var(--bpp-card);
        padding: 9px 12px; font-size: 13px; color: var(--bpp-ink); outline: none; transition: border-color 0.2s;
      }
      .bpp-comment-form input:focus { border-color: var(--bpp-blue); }
      .bpp-comment-send { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; border: none; background: var(--bpp-ink); color: var(--bpp-card); cursor: pointer; transition: opacity 0.2s, background 0.2s; }
      .bpp-comment-send:hover { background: var(--bpp-blue); color: #0b2e3d; }
      .bpp-comment-send:disabled { opacity: 0.5; }
      .bpp-login-note { margin-bottom: 18px; font-size: 12.5px; color: var(--bpp-ink-3); }
      .bpp-login-note a { color: var(--bpp-blue); font-weight: 600; text-decoration: underline; }

      /* comments as small paper "notes" instead of dark chat bubbles */
      .bpp-note { display: flex; gap: 10px; border-radius: 12px; border: 1px solid var(--bpp-line); background: var(--bpp-card); padding: 12px; }
      .bpp-note__head { margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .bpp-note__who { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--bpp-ink-3); }
      .bpp-note__author { font-weight: 700; color: var(--bpp-ink); }
      .bpp-note__del { border: none; background: none; color: var(--bpp-ink-3); cursor: pointer; transition: color 0.2s; }
      .bpp-note__del:hover { color: #c9451f; }
      .bpp-note__body { margin: 0; white-space: pre-wrap; font-size: 13.5px; line-height: 1.6; color: var(--bpp-ink-2); }

      .bpp-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-weight: 800; font-family: 'IBM Plex Mono', monospace; flex-shrink: 0; }
    `}</style>
  );

  if (loading) {
    return (
      <div className="bpp">
        {themeStyle}
        <div className="bpp-skel">
          <div className="bpp-skel__bar" style={{ height: 12, width: 96 }} />
          <div className="bpp-skel__bar" style={{ height: 30, width: '75%' }} />
          <div className="bpp-skel__bar" style={{ height: 12, width: 160 }} />
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="bpp-skel__bar" style={{ height: 11, width: '100%' }} />
            <div className="bpp-skel__bar" style={{ height: 11, width: '100%' }} />
            <div className="bpp-skel__bar" style={{ height: 11, width: '85%' }} />
          </div>
        </div>
      </div>
    );
  }
  if (error || !post) {
    return (
      <div className="bpp">
        {themeStyle}
        <p className="bpp-err">{error || 'Post not found.'}</p>
        <Link to="/blog" className="bpp-back" style={{ marginTop: 12 }}>
          <ArrowLeft size={14} /> Back to Blog
        </Link>
      </div>
    );
  }

  return (
    <div className="bpp">
      {themeStyle}
      <ReadingProgressBar />

      <Reveal trigger="mount" as={Link} to="/blog" className="bpp-back">
        <ArrowLeft size={14} /> Back to Blog
      </Reveal>

      <AnimatePresence mode="wait">
        {editing ? (
          <motion.div
            key="editing"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="bpp-editor"
          >
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <textarea value={content} onChange={(e) => setContent(e.target.value)} />
            {saveError && <p className="bpp-err" style={{ marginTop: 8 }}>{saveError}</p>}
            <div className="bpp-editor__foot">
              <button
                onClick={() => {
                  setEditing(false);
                  setTitle(post.title);
                  setContent(post.content);
                }}
                className="bpp-cancel-btn"
              >
                <X size={14} /> Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="bpp-save-btn">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="viewing"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="bpp-article"
          >
            <div className="bpp-head-row">
              <h1 className="bpp-title">{post.title}</h1>
              {isAuthor && (
                <div className="bpp-icon-btns">
                  <button onClick={() => setEditing(true)} title="Edit" className="bpp-icon-btn edit">
                    <Pencil size={14} />
                  </button>
                  <button onClick={handleDelete} title="Delete" className="bpp-icon-btn del">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>

            <div className="bpp-byline">
              <Avatar name={post.author_name} size="lg" />
              <div className="bpp-byline__meta">
                <p className="bpp-byline__name">{post.author_name}</p>
                <p className="bpp-byline__sub">
                  {new Date(post.created_at).toLocaleDateString()}
                  <span>·</span>
                  <Clock size={11} /> {readingTime(post.content)} min read
                </p>
              </div>
            </div>

            <div className="bpp-body">{post.content}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Attachments */}
      <Reveal trigger="view" className="bpp-section">
        <div className="bpp-section__head">
          <h3 className="bpp-section__title">
            <Paperclip size={13} /> Attachments
          </h3>
          {isAuthor && (
            <label className="bpp-add-file">
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
              {uploading ? 'Uploading…' : 'Add file'}
              <input type="file" style={{ display: 'none' }} onChange={handleFileChange} disabled={uploading} />
            </label>
          )}
        </div>
        {attachError && <p className="bpp-err" style={{ marginBottom: 8 }}>{attachError}</p>}

        {(!post.attachments || post.attachments.length === 0) ? (
          <p className="bpp-hint">No files attached.</p>
        ) : (
          <div className="bpp-att-grid">
            {post.attachments.map((att) => (
              <motion.div
                key={att.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="bpp-att"
              >
                <a href={attachmentUrl(att.url)} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
                  {isImageAttachment(att) ? (
                    <img src={attachmentUrl(att.url)} alt={att.filename} className="bpp-att__img" />
                  ) : (
                    <div className="bpp-att__fallback">
                      <FileText size={20} />
                    </div>
                  )}
                  <p className="bpp-att__name">{att.filename}</p>
                </a>
                {isAuthor && (
                  <button onClick={() => handleDeleteAttachment(att.id)} title="Remove" className="bpp-att__del">
                    <X size={12} />
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </Reveal>

      {/* Comments */}
      <Reveal trigger="view" delay={0.05} className="bpp-section">
        <h3 className="bpp-section__title" style={{ marginBottom: 14 }}>
          <MessageSquare size={13} /> Comments {comments.length > 0 && `(${comments.length})`}
        </h3>

        {user ? (
          <form onSubmit={handlePostComment} className="bpp-comment-form">
            <Avatar name={user.name} />
            <input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Add a comment…" maxLength={2000} />
            <button type="submit" disabled={postingComment || !commentText.trim()} className="bpp-comment-send">
              {postingComment ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </form>
        ) : (
          <p className="bpp-login-note">
            <Link to="/login">Log in</Link> to join the discussion.
          </p>
        )}

        {commentError && <p className="bpp-err" style={{ marginBottom: 8 }}>{commentError}</p>}
        {commentsLoading && <p className="bpp-hint">Loading comments…</p>}

        {!commentsLoading && comments.length === 0 && <p className="bpp-hint">No comments yet — start the discussion.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <AnimatePresence initial={false}>
            {comments.map((c) => {
              const canDelete = user && (user.id === c.author_id || user.id === post.author_id);
              return (
                <motion.div
                  key={c.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -8, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="bpp-note"
                >
                  <Avatar name={c.author_name} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="bpp-note__head">
                      <div className="bpp-note__who">
                        <span className="bpp-note__author">{c.author_name}</span>
                        <span>·</span>
                        <span>{timeAgo(c.created_at)}</span>
                      </div>
                      {canDelete && (
                        <button onClick={() => handleDeleteComment(c.id)} title="Delete comment" className="bpp-note__del">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <p className="bpp-note__body">{c.content}</p>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </Reveal>
    </div>
  );
}