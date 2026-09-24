import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Trash2, Save, NotebookPen, FlaskConical, X, PenTool,
  Paperclip, FileText, Loader2, CheckCircle2, ChevronDown, Folder,
  Search, Image as ImageIcon, Sparkles,
} from 'lucide-react';
import {
  fetchNotes, createNote, updateNote, deleteNote, fetchMyMolecules,
  uploadAttachment, deleteAttachment, attachmentUrl, extractErrorMessage,
} from '../api/api';
import { useAuth } from '../context/AuthContext';
import MiniStructurePreview from '../components/FunctionalGroups/MiniStructurePreview';
import { EASE } from '../components/motion/ScrollReveal';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const UNCATEGORIZED = 'Uncategorized';
const SUGGESTED_FOLDERS = ['Molecules', 'Reactions', 'Exam Notes', 'Chemistry > Organic', 'Chemistry > Inorganic', 'Chemistry > Physical'];

function isImageAttachment(att) {
  const ext = '.' + (att.filename.split('.').pop() || '').toLowerCase();
  return IMAGE_EXT.has(ext);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Solid paper-friendly accents — one per folder / molecule, chosen
// deterministically from its name — every card and folder dot still gets
// a distinct color, just off the warm-paper palette now.
const ACCENTS = ['#3bbff7', '#eea02b', '#1f6d49', '#6c5ce7', '#ff6b4a', '#0f9c8d'];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function accentFor(key) {
  return ACCENTS[hashString(String(key ?? '?')) % ACCENTS.length];
}

// Attachments get their accent from file category rather than filename, so
// every PDF looks like a PDF at a glance instead of a random color.
function fileAccentFor(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXT.has('.' + ext)) return '#ff6b4a';
  if (ext === 'pdf') return '#eea02b';
  if (['doc', 'docx', 'txt'].includes(ext)) return '#3bbff7';
  if (['xlsx', 'csv'].includes(ext)) return '#1f6d49';
  return '#8a8681';
}

export default function NotesPage() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [folder, setFolder] = useState('');
  const [embeddedMolecules, setEmbeddedMolecules] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [myMolecules, setMyMolecules] = useState([]);
  const [myMoleculesLoaded, setMyMoleculesLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState(new Set());
  const [sidebarQuery, setSidebarQuery] = useState('');

  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const fileInputRef = useRef(null);

  // Paint the warm-paper canvas behind the whole viewport while this page
  // is mounted — same trick the homepage and News page use, scoped so no
  // other route is affected.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-binder');
    return () => root.classList.remove('theme-binder');
  }, []);

  // `load` intentionally has an empty dependency array (see below) so it
  // never changes identity — activeId is read through this ref instead of
  // the closed-over state value, so a re-run after activeId has already
  // been set (e.g. the user re-authenticates without a full remount)
  // still correctly checks "is nothing selected yet" against the real
  // current value rather than whatever it was on the first render.
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const load = useCallback(() => {
    setLoading(true);
    fetchNotes()
      .then((data) => {
        setNotes(data);
        if (data.length && !activeIdRef.current) {
          selectNote(data[0]);
        }
      })
      .catch(() => setActionError("Couldn't load your notes — try refreshing."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  useEffect(() => {
    if (location.state?.compoundName && user) {
      handleNewNote(location.state.compoundName, location.state.compoundId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, user]);

  useEffect(() => {
    if (location.state?.openNoteId && notes.length) {
      const target = notes.find((n) => n.id === location.state.openNoteId);
      if (target) selectNote(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.openNoteId, notes]);

  // Warn before closing/refreshing the tab with unsaved changes — the same
  // in-app protection (below, in selectNote/handleNewNote) can't help
  // against a browser-level navigation.
  useEffect(() => {
    const handler = (e) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const selectNote = (note) => {
    if (isDirty && note.id !== activeId) {
      const ok = window.confirm('You have unsaved changes on this note. Switch anyway and lose them?');
      if (!ok) return;
    }
    setActiveId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setFolder(note.folder || '');
    setEmbeddedMolecules(note.embedded_molecules || []);
    setAttachments(note.attachments || []);
    setPickerOpen(false);
    setIsDirty(false);
    setSaveState('idle');
  };

  const handleNewNote = async (titleSeed, compoundId, folderSeed) => {
    if (isDirty && !window.confirm('You have unsaved changes on this note. Discard them and start a new note?')) {
      return;
    }
    setActionError('');
    try {
      const note = await createNote({
        title: titleSeed ? `Notes on ${titleSeed}` : 'Untitled note',
        content: '',
        compound_id: compoundId,
        folder: folderSeed || null,
        embedded_molecules: [],
      });
      setNotes((n) => [note, ...n]);
      selectNote(note);
    } catch {
      setActionError("Couldn't create a new note — try again.");
    }
  };

  const handleDelete = async (id, noteTitle) => {
    if (!window.confirm(`Delete "${noteTitle || 'Untitled note'}"? This can't be undone.`)) return;
    setActionError('');
    try {
      await deleteNote(id);
      setNotes((n) => n.filter((x) => x.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setTitle('');
        setContent('');
        setFolder('');
        setEmbeddedMolecules([]);
        setAttachments([]);
        setIsDirty(false);
      }
    } catch {
      setActionError("Couldn't delete that note — try again.");
    }
  };

  const handleTitleChange = (val) => {
    setTitle(val);
    setIsDirty(true);
    setNotes((n) => n.map((x) => (x.id === activeId ? { ...x, title: val } : x)));
  };
  const handleContentChange = (val) => {
    setContent(val);
    setIsDirty(true);
  };
  const handleFolderChange = (val) => {
    setFolder(val);
    setIsDirty(true);
    setNotes((n) => n.map((x) => (x.id === activeId ? { ...x, folder: val || null } : x)));
  };

  const handleSave = async () => {
    if (!activeId) return;
    setSaveState('saving');
    try {
      const updated = await updateNote(activeId, {
        title: title || 'Untitled note',
        content,
        folder: folder || null,
        embedded_molecules: embeddedMolecules,
      });
      setNotes((n) => n.map((x) => (x.id === activeId ? updated : x)));
      setIsDirty(false);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('idle');
    }
  };

  const openPicker = () => {
    setPickerOpen((open) => !open);
    if (!myMoleculesLoaded) {
      fetchMyMolecules()
        .then(setMyMolecules)
        .finally(() => setMyMoleculesLoaded(true));
    }
  };

  const attachMolecule = (molecule) => {
    const snapshot = {
      id: `embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: molecule.name,
      structure_2d: molecule.structure_2d,
    };
    setEmbeddedMolecules((list) => [...list, snapshot]);
    setIsDirty(true);
    setPickerOpen(false);
  };

  const removeEmbedded = (embedId) => {
    setEmbeddedMolecules((list) => list.filter((m) => m.id !== embedId));
    setIsDirty(true);
  };

  const editEmbedded = (embed) => {
    try {
      sessionStorage.setItem(
        'moleit_incoming_structure',
        JSON.stringify({ name: embed.name, structure_2d: embed.structure_2d })
      );
    } catch {
      // ignore
    }
    navigate('/draw');
  };

  const handleFilePick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeId) return;
    setUploadError('');
    setUploading(true);
    try {
      const attachment = await uploadAttachment(activeId, file);
      setAttachments((list) => [...list, attachment]);
    } catch (err) {
      setUploadError(extractErrorMessage(err, 'Upload failed — try a smaller file or a different format.'));
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = async (attachmentId) => {
    if (!activeId) return;
    setAttachments((list) => list.filter((a) => a.id !== attachmentId));
    try {
      await deleteAttachment(activeId, attachmentId);
    } catch {
      // if this fails the file just lingers server-side; not worth blocking the UI over
    }
  };

  const grouped = useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    const source = q ? notes.filter((n) => (n.title || '').toLowerCase().includes(q)) : notes;
    const map = new Map();
    source.forEach((n) => {
      const key = n.folder && n.folder.trim() ? n.folder : UNCATEGORIZED;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(n);
    });
    const folderNames = Array.from(map.keys())
      .filter((k) => k !== UNCATEGORIZED)
      .sort((a, b) => a.localeCompare(b));
    if (map.has(UNCATEGORIZED)) folderNames.push(UNCATEGORIZED);
    return folderNames.map((name) => ({ name, notes: map.get(name) }));
  }, [notes, sidebarQuery]);

  const existingFolderNames = useMemo(() => {
    const set = new Set(SUGGESTED_FOLDERS);
    notes.forEach((n) => n.folder && set.add(n.folder));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const toggleFolder = (name) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (!authLoading && !user) {
    return <Navigate to="/login" state={{ from: '/notes' }} replace />;
  }

  return (
    <div className="np">
      <style>{`
        html.theme-binder,
        html.theme-binder body {
          background-color: #f0edea;
          background-image: none;
        }
        html.theme-binder .moleit-logo .text-lab-100 { color: #262626 !important; }

        .np {
          --np-bg: #f0edea;
          --np-card: #fafaf9;
          --np-ink: #262626;
          --np-ink-2: #4e4e4d;
          --np-ink-3: #8a8681;
          --np-line: rgba(38, 38, 38, 0.12);
          --np-blue: #3bbff7;
          --np-green: #1f6d49;
          --np-coral: #ff6b4a;
          --np-amber: #eea02b;

          display: flex;
          flex-direction: column;
          width: 100%;
          max-width: 1280px;
          margin: 0 auto;
          height: calc(100svh - 58px);
          color: var(--np-ink);
          font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
        }
        @media (min-width: 1024px) { .np { flex-direction: row; } }

        /* ---------- sidebar ---------- */
        .np-sidebar {
          display: flex; flex-direction: column; flex-shrink: 0;
          max-height: 17rem; overflow: hidden;
          border-bottom: 1px solid var(--np-line);
          background: var(--np-card);
        }
        @media (min-width: 1024px) {
          .np-sidebar { max-height: none; width: 288px; height: auto; border-bottom: none; border-right: 1px solid var(--np-line); }
        }
        .np-sidebar__top { flex-shrink: 0; padding: 16px 14px 10px; }
        .np-sidebar__head { margin-bottom: 12px; display: flex; align-items: baseline; justify-content: space-between; }
        .np-sidebar__head h2 { margin: 0; font-weight: 700; font-size: 18px; color: var(--np-ink); }
        .np-sidebar__count { font-size: 11px; color: var(--np-ink-3); }
        .np-new-btn {
          margin-bottom: 10px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
          border-radius: 10px; border: 2px solid var(--np-ink); background: var(--np-ink); color: var(--np-card);
          padding: 9px 12px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.2s, border-color 0.2s, color 0.2s;
        }
        .np-new-btn:hover { background: var(--np-green); border-color: var(--np-green); color: #fff; }
        .np-sidebar-search { position: relative; }
        .np-sidebar-search svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--np-ink-3); pointer-events: none; }
        .np-sidebar-search input {
          width: 100%; border-radius: 8px; border: 1px solid var(--np-line); background: #fff;
          padding: 7px 8px 7px 28px; font-size: 12px; color: var(--np-ink); outline: none; transition: border-color 0.2s;
        }
        .np-sidebar-search input:focus { border-color: var(--np-blue); }
        .np-action-error { margin-top: 10px; border-radius: 8px; border: 1px solid rgba(255,59,59,0.25); background: rgba(255,59,59,0.06); padding: 6px 8px; font-size: 11px; color: #b52424; }
        .np-sidebar__list { min-height: 0; flex: 1; overflow-y: auto; padding: 0 14px 14px; }
        .np-sidebar__hint { font-size: 12px; color: var(--np-ink-3); }

        .np-folder-head { display: flex; align-items: center; justify-content: space-between; padding: 0 2px; }
        .np-folder-toggle { display: flex; min-width: 0; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--np-ink-3); }
        .np-folder-toggle:hover { color: var(--np-ink); }
        .np-folder-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .np-folder-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .np-folder-add { flex-shrink: 0; background: none; border: none; color: var(--np-ink-3); opacity: 0; cursor: pointer; transition: opacity 0.15s, color 0.15s; }
        .np-folder-head:hover .np-folder-add { opacity: 1; }
        .np-folder-add:hover { color: var(--np-green); }

        .np-note-item { position: relative; display: flex; width: 100%; align-items: center; gap: 8px; border-radius: 8px; padding: 8px 8px 8px 11px; text-align: left; font-size: 13px; background: none; border: none; cursor: pointer; color: var(--np-ink-2); transition: background 0.15s, color 0.15s; }
        .np-note-item:hover { background: rgba(38,38,38,0.05); }
        .np-note-item.is-active { background: rgba(59,191,247,0.12); color: var(--np-ink); font-weight: 600; }
        .np-note-item__bar { position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; }
        .np-note-item__title { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .np-note-item__del { flex-shrink: 0; opacity: 0; color: var(--np-ink-3); transition: opacity 0.15s, color 0.15s; }
        .np-note-item:hover .np-note-item__del { opacity: 1; }
        .np-note-item__del:hover { color: #c9451f; }

        /* ---------- editor ---------- */
        .np-main { min-width: 0; flex: 1; overflow-y: auto; padding: 18px; }
        @media (min-width: 640px) { .np-main { padding: 24px; } }

        .np-editor-head { margin-bottom: 4px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .np-title-input { width: 100%; border: none; background: transparent; padding: 4px; border-radius: 8px; font-weight: 700; font-size: 24px; color: var(--np-ink); outline: none; }
        .np-title-input::placeholder { color: var(--np-ink-3); }
        .np-title-input:focus { background: rgba(38,38,38,0.04); }
        .np-save-btn { flex-shrink: 0; display: flex; align-items: center; gap: 6px; border-radius: 10px; border: none; padding: 9px 14px; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.2s; }
        .np-save-btn.state-saved { background: rgba(31,109,73,0.15); color: var(--np-green); }
        .np-save-btn.state-dirty { background: var(--np-green); color: #fff; }
        .np-save-btn.state-idle { background: var(--np-line); color: var(--np-ink-3); cursor: not-allowed; }

        .np-folder-row { margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
        .np-folder-dot-lg { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .np-folder-input { width: 240px; border-radius: 999px; border: 1px solid var(--np-line); background: var(--np-card); padding: 5px 12px; font-size: 12px; color: var(--np-ink-2); outline: none; transition: border-color 0.2s; }
        .np-folder-input:focus { border-color: var(--np-green); }

        .np-content-textarea { height: 260px; width: 100%; resize: none; border-radius: 14px; border: 1px solid var(--np-line); background: var(--np-card); padding: 16px; font-size: 13.5px; line-height: 1.65; color: var(--np-ink); outline: none; transition: border-color 0.2s; }
        .np-content-textarea::placeholder { color: var(--np-ink-3); }
        .np-content-textarea:focus { border-color: var(--np-blue); }

        .np-section { margin-top: 22px; }
        .np-section__head { margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
        .np-section__title { margin: 0; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--np-ink-3); }
        .np-chip-btn { display: flex; align-items: center; gap: 6px; border-radius: 8px; border: 1px solid var(--np-line); background: var(--np-card); padding: 6px 10px; font-size: 12px; font-weight: 600; color: var(--np-ink-2); cursor: pointer; transition: border-color 0.2s, color 0.2s; }
        .np-chip-btn:hover { border-color: var(--np-green); color: var(--np-green); }
        .np-chip-btn:disabled { opacity: 0.6; cursor: default; }

        .np-dash-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; border-radius: 12px; border: 1px dashed var(--np-line); padding: 24px; text-align: center; font-size: 12px; color: var(--np-ink-3); }

        .np-picker { position: relative; }
        .np-picker__panel { position: absolute; right: 0; z-index: 20; margin-top: 6px; width: 260px; border-radius: 12px; border: 1px solid var(--np-line); background: var(--np-card); padding: 8px; box-shadow: 0 16px 36px -18px rgba(38,38,38,0.35); }
        .np-picker__head { margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
        .np-picker__head span { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--np-ink-3); }
        .np-picker__head button { border: none; background: none; color: var(--np-ink-3); cursor: pointer; }
        .np-picker__list { max-height: 14rem; overflow-y: auto; }
        .np-picker__item { display: flex; width: 100%; align-items: center; justify-content: space-between; border-radius: 8px; border: none; background: none; padding: 7px 8px; text-align: left; font-size: 12px; color: var(--np-ink-2); cursor: pointer; }
        .np-picker__item:hover { background: rgba(38,38,38,0.06); }
        .np-picker__item span:last-child { margin-left: 8px; flex-shrink: 0; font-family: 'IBM Plex Mono', monospace; color: var(--np-green); }
        .np-picker__draw { margin-top: 4px; display: flex; width: 100%; align-items: center; gap: 6px; border: none; border-top: 1px solid var(--np-line); background: none; padding: 8px 8px 2px; font-size: 12px; color: var(--np-ink-3); cursor: pointer; }
        .np-picker__draw:hover { color: var(--np-green); }

        .np-embed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        @media (min-width: 640px) { .np-embed-grid { grid-template-columns: repeat(3, 1fr); } }
        .np-embed-card { overflow: hidden; border-radius: 12px; border: 1px solid var(--np-line); background: var(--np-card); }
        .np-embed-card__head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; }
        .np-embed-card__head span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 700; color: #fff; }
        .np-embed-card__head button { flex-shrink: 0; border: none; background: none; color: rgba(255,255,255,0.85); cursor: pointer; }
        .np-embed-card__body { padding: 6px; }
        .np-embed-card__open { margin-top: 6px; display: flex; width: 100%; align-items: center; justify-content: center; gap: 4px; border-radius: 8px; border: 1px solid var(--np-line); background: transparent; padding: 5px; font-size: 11px; color: var(--np-ink-3); cursor: pointer; transition: border-color 0.2s, color 0.2s; }
        .np-embed-card__open:hover { border-color: var(--np-green); color: var(--np-green); }

        .np-att-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        @media (min-width: 640px) { .np-att-grid { grid-template-columns: repeat(4, 1fr); } }
        .np-att-card { position: relative; overflow: hidden; border-radius: 12px; border: 1px solid var(--np-line); background: var(--np-card); }
        .np-att-card__del { position: absolute; right: 4px; top: 4px; z-index: 10; border: none; border-radius: 999px; background: rgba(255,255,255,0.85); padding: 4px; color: var(--np-ink-2); opacity: 0; cursor: pointer; transition: opacity 0.2s, color 0.2s; }
        .np-att-card:hover .np-att-card__del { opacity: 1; }
        .np-att-card__del:hover { color: #c9451f; }
        .np-att-card__img { height: 96px; width: 100%; object-fit: cover; }
        .np-att-card__fallback { display: flex; height: 96px; width: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #fff; }
        .np-att-card__foot { border-top: 1px solid var(--np-line); padding: 6px; }
        .np-att-card__foot p:first-child { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--np-ink-2); }
        .np-att-card__foot p:last-child { margin: 2px 0 0; font-size: 10px; color: var(--np-ink-3); }

        .np-status-row { margin-top: 16px; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--np-ink-3); }
        .np-status-row .is-dirty { color: var(--np-amber); }

        .np-empty-state { display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--np-ink-3); }
        .np-empty-state p { font-size: 13.5px; }
      `}</style>

      {/* ───────────── Sidebar: the "binder" ───────────── */}
      <aside className="np-sidebar">
        <div className="np-sidebar__top">
          <div className="np-sidebar__head">
            <h2>Notes</h2>
            <span className="np-sidebar__count">{notes.length}</span>
          </div>

          <button onClick={() => handleNewNote()} className="np-new-btn">
            <Plus size={15} /> New note
          </button>

          <div className="np-sidebar-search">
            <Search size={13} />
            <input value={sidebarQuery} onChange={(e) => setSidebarQuery(e.target.value)} placeholder="Search notes…" />
          </div>

          {actionError && <p className="np-action-error">{actionError}</p>}
        </div>

        <div className="np-sidebar__list">
          {loading ? (
            <p className="np-sidebar__hint">Loading…</p>
          ) : notes.length === 0 ? (
            <p className="np-sidebar__hint">No notes yet — create your first one.</p>
          ) : grouped.length === 0 ? (
            <p className="np-sidebar__hint">No notes match "{sidebarQuery}".</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {grouped.map(({ name, notes: folderNotes }) => {
                const collapsed = collapsedFolders.has(name);
                const dot = accentFor(name);
                return (
                  <div key={name}>
                    <div className="np-folder-head group">
                      <button onClick={() => toggleFolder(name)} className="np-folder-toggle">
                        <motion.span animate={{ rotate: collapsed ? -90 : 0 }} transition={{ duration: 0.2, ease: EASE }} style={{ display: 'inline-flex' }}>
                          <ChevronDown size={12} />
                        </motion.span>
                        <span className="np-folder-dot" style={{ background: dot }} />
                        <span className="np-folder-name">{name}</span>
                        <span style={{ flexShrink: 0, color: 'var(--np-ink-3)' }}>({folderNotes.length})</span>
                      </button>
                      <button
                        onClick={() => handleNewNote(undefined, undefined, name === UNCATEGORIZED ? '' : name)}
                        title={`New note in ${name}`}
                        className="np-folder-add"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    <AnimatePresence initial={false}>
                      {!collapsed && (
                        <motion.ul
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2, ease: EASE }}
                          style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden', listStyle: 'none', padding: 0 }}
                        >
                          {folderNotes.map((n) => {
                            const isActive = activeId === n.id;
                            return (
                              <li key={n.id}>
                                <button onClick={() => selectNote(n)} className={`np-note-item ${isActive ? 'is-active' : ''}`}>
                                  {isActive && <motion.span layoutId="active-note-bar" className="np-note-item__bar" style={{ background: dot }} transition={{ duration: 0.2, ease: EASE }} />}
                                  <span className="np-note-item__title">{n.title || 'Untitled note'}</span>
                                  <Trash2
                                    size={13}
                                    className="np-note-item__del"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDelete(n.id, n.title);
                                    }}
                                  />
                                </button>
                              </li>
                            );
                          })}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ───────────── Main: the editor ───────────── */}
      <main className="np-main">
        <AnimatePresence mode="wait">
          {activeId ? (
            <motion.div key={activeId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }}>
              <div className="np-editor-head">
                <input value={title} onChange={(e) => handleTitleChange(e.target.value)} placeholder="Untitled note — click to rename" className="np-title-input" />
                <button
                  onClick={handleSave}
                  disabled={saveState === 'saving' || !isDirty}
                  className={`np-save-btn ${saveState === 'saved' ? 'state-saved' : isDirty ? 'state-dirty' : 'state-idle'}`}
                >
                  {saveState === 'saving' ? <Loader2 size={15} className="animate-spin" /> : saveState === 'saved' ? <CheckCircle2 size={15} /> : <Save size={15} />}
                  {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : isDirty ? 'Save changes' : 'Saved'}
                </button>
              </div>

              <div className="np-folder-row">
                <span className="np-folder-dot-lg" style={{ background: accentFor(folder || UNCATEGORIZED) }} />
                <Folder size={13} color="var(--np-ink-3)" />
                <input list="folder-suggestions" value={folder} onChange={(e) => handleFolderChange(e.target.value)} placeholder="Uncategorized — type or pick a folder" className="np-folder-input" />
                <datalist id="folder-suggestions">
                  {existingFolderNames.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>

              <textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                placeholder="Write your notes here — reactions, structures, mnemonics, whatever helps it stick…"
                className="np-content-textarea"
              />

              {/* Embedded molecules */}
              <div className="np-section">
                <div className="np-section__head">
                  <h3 className="np-section__title">Embedded molecules</h3>
                  <div className="np-picker">
                    <button onClick={openPicker} className="np-chip-btn">
                      <FlaskConical size={13} /> Attach molecule
                    </button>

                    <AnimatePresence>
                      {pickerOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -6, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -6, scale: 0.97 }}
                          transition={{ duration: 0.15, ease: EASE }}
                          className="np-picker__panel"
                        >
                          <div className="np-picker__head">
                            <span>My Molecules</span>
                            <button onClick={() => setPickerOpen(false)}>
                              <X size={13} />
                            </button>
                          </div>
                          <div className="np-picker__list">
                            {!myMoleculesLoaded ? (
                              <p style={{ padding: '8px 4px', fontSize: 12, color: 'var(--np-ink-3)' }}>Loading…</p>
                            ) : myMolecules.length === 0 ? (
                              <p style={{ padding: '8px 4px', fontSize: 12, color: 'var(--np-ink-3)' }}>No saved molecules yet — draw one first.</p>
                            ) : (
                              myMolecules.map((m) => (
                                <button key={m.id} onClick={() => attachMolecule(m)} className="np-picker__item">
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                                  {m.derived_formula && <span>{m.derived_formula}</span>}
                                </button>
                              ))
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setPickerOpen(false);
                              navigate('/draw');
                            }}
                            className="np-picker__draw"
                          >
                            <PenTool size={12} /> Draw a new one
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {embeddedMolecules.length === 0 ? (
                  <div className="np-dash-empty">
                    <Sparkles size={16} color="var(--np-ink-3)" />
                    No molecules attached — click "Attach molecule" to embed one of your Draw Lab creations here.
                  </div>
                ) : (
                  <div className="np-embed-grid">
                    <AnimatePresence>
                      {embeddedMolecules.map((embed) => {
                        const accent = accentFor(embed.name + embed.id);
                        return (
                          <motion.div key={embed.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.2, ease: EASE }} className="np-embed-card">
                            <div className="np-embed-card__head" style={{ background: accent }}>
                              <span>{embed.name}</span>
                              <button onClick={() => removeEmbedded(embed.id)}>
                                <X size={12} />
                              </button>
                            </div>
                            <div className="np-embed-card__body">
                              <MiniStructurePreview atoms={embed.structure_2d.atoms} bonds={embed.structure_2d.bonds} height={100} />
                              <button onClick={() => editEmbedded(embed)} className="np-embed-card__open">
                                <PenTool size={11} /> Open in Draw Lab
                              </button>
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              {/* Attachments */}
              <div className="np-section">
                <div className="np-section__head">
                  <h3 className="np-section__title">Attachments</h3>
                  <button onClick={handleFilePick} disabled={uploading} className="np-chip-btn">
                    {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />}
                    {uploading ? 'Uploading…' : 'Attach file'}
                  </button>
                  <input ref={fileInputRef} type="file" style={{ display: 'none' }} accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.txt,.csv,.xlsx" onChange={handleFileSelected} />
                </div>

                {uploadError && <p className="np-error-text" style={{ marginBottom: 8, fontSize: 11, color: '#b52424' }}>{uploadError}</p>}

                {attachments.length === 0 ? (
                  <div className="np-dash-empty">
                    <ImageIcon size={16} color="var(--np-ink-3)" />
                    Attach a screenshot, scanned page, or document from your experiment.
                  </div>
                ) : (
                  <div className="np-att-grid">
                    <AnimatePresence>
                      {attachments.map((att) => {
                        const accent = fileAccentFor(att.filename);
                        return (
                          <motion.div key={att.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.2, ease: EASE }} className="np-att-card">
                            <button onClick={() => handleRemoveAttachment(att.id)} className="np-att-card__del">
                              <X size={12} />
                            </button>
                            <a href={attachmentUrl(att.url)} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
                              {isImageAttachment(att) ? (
                                <img src={attachmentUrl(att.url)} alt={att.filename} className="np-att-card__img" />
                              ) : (
                                <div className="np-att-card__fallback" style={{ background: accent }}>
                                  <FileText size={22} />
                                </div>
                              )}
                              <div className="np-att-card__foot">
                                <p>{att.filename}</p>
                                <p>{formatBytes(att.size)}</p>
                              </div>
                            </a>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              <div className="np-status-row">
                <AnimatePresence mode="wait">
                  {isDirty ? (
                    <motion.span key="dirty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="is-dirty">
                      You have unsaved changes — click "Save changes" above.
                    </motion.span>
                  ) : (
                    <motion.span key="saved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Save size={12} /> All changes saved
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="np-empty-state">
              <motion.span animate={{ y: [0, -6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
                <NotebookPen size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
              </motion.span>
              <p>Select a note or create a new one to get started.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}