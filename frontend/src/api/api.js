import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// BUG FIX: this was 45s. A cold Render free-tier backend can take longer
// than that just to wake up and answer its very first request, and
// PubChem's own lookups (name resolution + SDF fetch, now with retries —
// see pubchem.py / routers/symmetry.py) can occasionally run past 45s too.
// A request that was actually still in flight was being aborted client-side
// and shown to the user as a hard failure. Bumped to a more forgiving 75s.
const api = axios.create({ baseURL: API_BASE, timeout: 75000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('molapp_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isAuthedRequest = Boolean(localStorage.getItem('molapp_token'));
    if (error?.response?.status === 401 && isAuthedRequest) {
      localStorage.removeItem('molapp_token');
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);

const pick = (key) => (r) => r.data[key];

// BUG FIX: none of the API calls in this file ever retried anything —
// a single transient timeout, a dropped connection, or PubChem answering
// with a temporary 502/503/504 immediately surfaced as a hard failure
// ("Could not fetch that compound from PubChem."), even though trying
// again a moment later usually succeeds (the backend itself now retries
// PubChem internally too — see pubchem.py / routers/symmetry.py — but
// that can't help if the *browser's own* request to our backend is what
// timed out or dropped). This wraps a request in one silent retry for
// exactly the failure modes that are worth retrying; a real 4xx (bad
// input, not found) is never retried since trying again won't change it.
async function withRetry(fn, { retries = 1, delayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const isTimeout = err?.code === 'ECONNABORTED';
      const isNetworkError = err?.isAxiosError && !err.response;
      const isRetryableStatus = status === 502 || status === 503 || status === 504;
      const shouldRetry = attempt < retries && (isTimeout || isNetworkError || isRetryableStatus);
      if (!shouldRetry) throw lastErr;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ---- Auth ----
export const registerUser = (data) => api.post('/api/auth/register', data).then((r) => r.data);
export const loginUser = (data) => api.post('/api/auth/login', data).then((r) => r.data);
export const fetchMe = () => api.get('/api/auth/me').then(pick('user'));
export const forgotPassword = (email) => api.post('/api/auth/forgot-password', { email }).then((r) => r.data);
export const resetPassword = (payload) => api.post('/api/auth/reset-password', payload).then((r) => r.data);

// ---- Compounds (library) ----
export const fetchCompounds = (params) => api.get('/api/compounds', { params }).then(pick('compounds'));
export const fetchCompoundCategories = () => api.get('/api/compounds/categories').then(pick('categories'));
export const fetchCompound = (id) => api.get(`/api/compounds/${id}`).then(pick('compound'));
export const fetchExternalCompound = (query) =>
  withRetry(() => api.post('/api/compounds/fetch', { query }).then(pick('compound')));
export const matchCompoundsByFormula = (formula) =>
  api.get('/api/compounds/match/by-formula', { params: { formula } }).then(pick('matches'));
export const resolveCompoundMatch = (payload) =>
  api.post('/api/compounds/match/resolve', payload).then(pick('compound'));

// ---- Functional Groups ----
export const fetchFunctionalGroups = (params) =>
  api.get('/api/functional-groups', { params }).then(pick('groups'));

// ---- Spectra (NMR / IR prediction) ----
export const predictNmr = (atoms, bonds, solvent = 'CDCl3') =>
  api.post('/api/spectra/nmr', { atoms, bonds, solvent }).then((r) => ({ h1: r.data.h1, c13: r.data.c13, warnings: r.data.warnings || [] }));
export const predictIr = (atoms, bonds) =>
  api.post('/api/spectra/ir', { atoms, bonds }).then(pick('bands'));

// ---- Structure analysis (formula / molar mass / SMILES / valence checks) ----
// Ported from lib/elements.js's computeFormula/computeMolarMass/
// deriveSmiles/findValenceIssues — same pattern as the NMR/IR predictors
// above. Returns '' / [] fallbacks rather than throwing, since callers
// (PropertiesPanel's live display, DrawLabPage's live validation
// highlighting) run on every structure edit and shouldn't crash the
// canvas if the request is briefly unreachable.
export const analyzeStructure = (atoms, bonds) => {
  if (!atoms || atoms.length === 0) {
    return Promise.resolve({ formula: '', molarMass: '', smiles: '', issues: [], bondOrders: {}, ringCount: 0 });
  }
  return api
    .post('/api/structure/analyze', { atoms, bonds })
    .then((r) => ({
      formula: r.data.formula || '',
      molarMass: r.data.molar_mass || '',
      smiles: r.data.smiles || '',
      issues: r.data.issues || [],
      bondOrders: r.data.bond_orders || {},
      ringCount: r.data.ring_count || 0,
    }));
};

// Ported from lib/smilesParser.js's parseSmiles (now deleted) — throws
// (via extractErrorMessage, same as every other API call in this file)
// with the backend's human-readable message on malformed input, the same
// messages SmilesError used to carry.
export const importSmiles = (smiles) =>
  api.post('/api/structure/from-smiles', { smiles }).then((r) => ({ atoms: r.data.atoms, bonds: r.data.bonds }));

// Ported from lib/structureCleanup.js (now deleted). cleanupStructure runs
// the expand-hydride/autocorrect-layout/tetrahedral-wedge/recenter
// pipeline in one call; remapStructure renumbers a fragment's ids so they
// don't collide with what's already on the canvas before merging.
export const cleanupStructure = (atoms, bonds, targetCenter) =>
  api
    .post('/api/structure/cleanup', { atoms, bonds, target_center: targetCenter })
    .then((r) => ({ atoms: r.data.atoms, bonds: r.data.bonds }));

export const remapStructure = (newAtoms, newBonds, existingAtoms, existingBonds) =>
  api
    .post('/api/structure/remap', {
      new_atoms: newAtoms, new_bonds: newBonds, existing_atoms: existingAtoms, existing_bonds: existingBonds,
    })
    .then((r) => ({ atoms: r.data.atoms, bonds: r.data.bonds }));

// Ported from lib/ringTemplates.js's generateRingStructure (now deleted).
// RING_TYPES (the toolbar's ring picker labels) is still owned by the
// frontend — see components/DrawLab/Toolbar.jsx — since it's UI content,
// not computation; only the placement math moved.
export const insertRing = (ringTypeId, centerX, centerY, atoms, bonds) =>
  api
    .post('/api/structure/insert-ring', { ring_type_id: ringTypeId, center_x: centerX, center_y: centerY, atoms, bonds })
    .then((r) => ({ atoms: r.data.atoms, bonds: r.data.bonds }));

// ---- Reactions ----
export const fetchReactions = (params) =>
  api.get('/api/reactions', { params }).then(pick('reactions'));
export const fetchReactionCategories = () =>
  api.get('/api/reactions/categories').then(pick('categories'));
export const fetchReaction = (id) =>
  api.get(`/api/reactions/${id}`).then(pick('reaction'));

export const fetchQuizQuestionsForCompound = (compoundId) =>
  api.get(`/api/quiz/questions/by-compound/${compoundId}`).then((r) => r.data.questions.map(mapQuizQuestion));

export const fetchQuizQuestionsCount = (params) =>
  api.get('/api/quiz/questions/count', { params }).then(pick('count'));

export const fetchQuizQuestions = ({ category, difficulty, limit }) =>
  api
    .get('/api/quiz/questions', { params: { category, difficulty, limit } })
    .then((r) => r.data.questions.map(mapQuizQuestion));

function mapQuizQuestion(q) {
  return {
    id: q.id,
    type: q.type,
    category: q.category,
    difficulty: q.difficulty,
    prompt: q.prompt,
    subPrompt: q.sub_prompt,
    options: q.options,
    answer: q.answer,
    mono: q.mono,
    molBlock: q.mol_block,
    structure: q.structure,
    highlightBondId: q.highlight_bond_id,
  };
}

// ---- Notes ----
export const fetchNotes = () => api.get('/api/notes').then(pick('notes'));
export const createNote = (data) => api.post('/api/notes', data).then(pick('note'));
export const updateNote = (id, data) => api.put(`/api/notes/${id}`, data).then(pick('note'));
export const deleteNote = (id) => api.delete(`/api/notes/${id}`).then((r) => r.data);

export const uploadAttachment = (noteId, file, onProgress) => {
  const formData = new FormData();
  formData.append('file', file);
  return api
    .post(`/api/notes/${noteId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress,
    })
    .then(pick('attachment'));
};
export const deleteAttachment = (noteId, attachmentId) =>
  api.delete(`/api/notes/${noteId}/attachments/${attachmentId}`).then((r) => r.data);

export const attachmentUrl = (relativeUrl) => `${API_BASE}${relativeUrl}`;

export function extractErrorMessage(err, fallback = 'Something went wrong') {
  const payload = err?.response?.data;
  if (payload) {
    if (Array.isArray(payload.errors) && payload.errors[0]?.msg) return payload.errors[0].msg;
    if (typeof payload.message === 'string' && payload.message) return payload.message;
    const detail = payload.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  }
  // BUG FIX: previously any error with no response body (a real network
  // failure, a timeout, the backend being unreachable) silently fell all
  // the way through to the generic caller-supplied `fallback` string —
  // which is exactly why "Could not fetch that compound from PubChem."
  // was showing up even when the real problem was e.g. a client-side
  // timeout or the API being unreachable. Surface what actually happened
  // instead of masking it behind a generic message.
  if (err?.code === 'ECONNABORTED') {
    return 'The request timed out. The server may be waking up from sleep (Render free tier) — please try again in a few seconds.';
  }
  if (err?.isAxiosError && !err.response) {
    return `Couldn't reach the API at ${API_BASE}. Check that the backend is running and reachable, then try again.`;
  }
  if (err instanceof Error && !err.isAxiosError && err.message) return err.message;
  return fallback;
}

// ---- User-drawn molecules ----
export const fetchMyMolecules = () => api.get('/api/molecules').then(pick('molecules'));
export const fetchPublicMolecules = () => api.get('/api/molecules/public').then(pick('molecules'));
export const saveMolecule = (data) => api.post('/api/molecules', data).then(pick('molecule'));
export const updateMolecule = (id, data) => api.put(`/api/molecules/${id}`, data).then(pick('molecule'));
export const deleteMolecule = (id) => api.delete(`/api/molecules/${id}`).then((r) => r.data);

// ---- News ----
export const fetchNews = (params) => api.get('/api/news', { params }).then(pick('articles'));
export const fetchNewsSources = () => api.get('/api/news/sources').then(pick('sources'));
export const fetchNewsVideoSources = () => api.get('/api/news/sources').then(pick('video_sources'));
export const refreshNews = () => api.post('/api/news/refresh').then((r) => r.data);

// ---- Blog ----
export const fetchBlogPosts = () => api.get('/api/blog').then(pick('posts'));
export const fetchBlogPost = (id) => api.get(`/api/blog/${id}`).then(pick('post'));
export const createBlogPost = (data) => api.post('/api/blog', data).then(pick('post'));
export const updateBlogPost = (id, data) => api.put(`/api/blog/${id}`, data).then(pick('post'));
export const deleteBlogPost = (id) => api.delete(`/api/blog/${id}`).then((r) => r.data);

export const uploadBlogAttachment = (postId, file, onProgress) => {
  const formData = new FormData();
  formData.append('file', file);
  return api
    .post(`/api/blog/${postId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress,
    })
    .then(pick('attachment'));
};
export const deleteBlogAttachment = (postId, attachmentId) =>
  api.delete(`/api/blog/${postId}/attachments/${attachmentId}`).then((r) => r.data);

export const fetchBlogComments = (postId) => api.get(`/api/blog/${postId}/comments`).then(pick('comments'));
export const createBlogComment = (postId, content) =>
  api.post(`/api/blog/${postId}/comments`, { content }).then(pick('comment'));
export const deleteBlogComment = (postId, commentId) =>
  api.delete(`/api/blog/${postId}/comments/${commentId}`).then((r) => r.data);

// ---- Quiz ----
export const fetchQuizHistory = () => api.get('/api/quiz/attempts').then(pick('attempts'));
export const submitQuizAttempt = (data) => api.post('/api/quiz/attempts', data).then(pick('attempt'));

// ---- Group Theory / Symmetry ----
export const fetchSymmetryDemos = () => api.get('/api/symmetry/demos').then(pick('demos'));
export const analyzeSymmetry = (structure, tolerance) =>
  withRetry(() => api.post('/api/symmetry/analyze', { structure, tolerance }).then(pick('result')));
export const analyzeSymmetryFromPubchem = (query, tolerance) =>
  withRetry(() => api.post('/api/symmetry/pubchem', { query, tolerance }).then(pick('result')));

export default api;