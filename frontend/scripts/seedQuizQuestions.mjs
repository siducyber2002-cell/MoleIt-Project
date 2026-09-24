// Generates the full quiz question pool (reusing the existing
// generateQuestionPool logic -- the chemistry stays in one place) and
// pushes it into the backend's quiz_questions table.
//
// Run from frontend/:
//   node scripts/seedQuizQuestions.mjs
//
// Env vars (optional):
//   API_URL          default http://localhost:8000
//   QUIZ_SEED_SECRET must match backend/.env's QUIZ_SEED_SECRET
//
// Safe to re-run any time compounds_seed.json or quizGenerator.js
// changes -- it's an upsert, matched by question id.

import { generateQuestionPool } from '../src/lib/quizGenerator.js';
import { FUNCTIONAL_GROUPS } from '../src/lib/functionalGroups.js';
import { ELEMENT_SYMBOLS } from '../src/lib/elements.js';

const API_URL = process.env.API_URL || 'http://localhost:8000';
const SEED_SECRET = process.env.QUIZ_SEED_SECRET || 'dev_seed_secret_change_me';
const BATCH_SIZE = 200;

const CATEGORY_TYPES = {
  compounds: [
    'compoundName', 'compoundFormula', 'compoundFrom2D', 'compoundSmiles',
    'hybridization', 'bondOrder', 'molarMass', 'iupacName',
    'compoundCategory', 'compoundUse', 'elementCount',
    'degreeOfUnsaturation', 'nmrPeakCount',
  ],
  groups: ['functionalGroup', 'formalCharge'],
  elements: ['elementSymbol', 'elementName', 'atomicNumber', 'atomicMass', 'elementCategory'],
};

function categoryForType(type) {
  for (const [category, types] of Object.entries(CATEGORY_TYPES)) {
    if (types.includes(type)) return category;
  }
  return 'compounds'; // shouldn't happen, but keep the row valid rather than drop it
}

function toBackendShape(q) {
  return {
    id: q.id,
    type: q.type,
    category: categoryForType(q.type),
    difficulty: q.difficulty || 'normal',
    prompt: q.prompt,
    sub_prompt: q.subPrompt ?? null,
    options: q.options.map(String),
    answer: String(q.answer),
    mono: Boolean(q.mono),
    mol_block: q.molBlock ?? null,
    structure: q.structure ?? null,
    highlight_bond_id: q.highlightBondId ?? null,
  };
}

async function main() {
  console.log(`Fetching compounds from ${API_URL}/api/compounds ...`);
  const compoundsRes = await fetch(`${API_URL}/api/compounds`);
  if (!compoundsRes.ok) {
    throw new Error(`GET /api/compounds failed: ${compoundsRes.status}`);
  }
  const compounds = await compoundsRes.json();
  console.log(`  ${compounds.length} compounds loaded.`);

  const pool = generateQuestionPool(compounds, FUNCTIONAL_GROUPS, ELEMENT_SYMBOLS.length);
  console.log(`Generated ${pool.length} questions. Uploading in batches of ${BATCH_SIZE}...`);

  const rows = pool.map(toBackendShape);
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${API_URL}/api/quiz/questions/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Seed-Secret': SEED_SECRET,
      },
      body: JSON.stringify({ questions: batch }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Batch ${i / BATCH_SIZE + 1} failed: ${res.status} ${text}`);
    }
    const result = await res.json();
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    console.log(`  batch ${i / BATCH_SIZE + 1}: +${result.inserted} inserted, ${result.updated} updated`);
  }

  console.log(`Done. ${totalInserted} inserted, ${totalUpdated} updated (${rows.length} total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
