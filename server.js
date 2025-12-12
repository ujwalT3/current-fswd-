/**
 * server.js - NotionIQ using Google Gemini (Generative Language API)
 *
 * Requirements:
 *  - Set GEMINI_API_KEY and optionally GEMINI_MODEL in .env
 *  - Gemini endpoint: https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 *
 * See docs: https://ai.google.dev/api (generateContent examples & API key usage). :contentReference[oaicite:3]{index=3}
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- ENV ----------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/notioniq';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'; // change to a model you have access to
const GEMINI_ENDPOINT_BASE = process.env.GEMINI_ENDPOINT_BASE || 'https://generativelanguage.googleapis.com/v1beta/models';

// ---------- DB ----------
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ---------- Simple User model ----------
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true, minlength: 6 },
  createdAt: { type: Date, default: Date.now }
});
userSchema.pre('save', async function(next){ if(!this.isModified('password')) return next(); this.password = await bcrypt.hash(this.password, 10); next(); });
userSchema.methods.comparePassword = async function(p){ return bcrypt.compare(p, this.password); };
const User = mongoose.model('User', userSchema);

// ---------- Middleware ----------
app.use(cors({
  origin: ['http://127.0.0.1:5500','http://localhost:5500','http://127.0.0.1:3000','http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, touchAfter: 24 * 3600 }),
  cookie: { maxAge: 1000*60*60*24, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

// ---------- Uploads ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const SUPPORTED = ['text/plain','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// ---------- Gemini helper ----------
if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY not set. Add it to .env to call the Gemini API.');
}

// Replace existing callGemini with this resilient version
async function callGemini(prompt, systemInstruction = '', opts = {}) {
  // opts: { attempts: 3, backoffBaseMs: 1000, timeoutMs: 120000 }
  const attempts = Number(opts.attempts || 3);
  const backoffBaseMs = Number(opts.backoffBaseMs || 1000);
  const timeoutMs = Number(opts.timeoutMs || 120000);

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in .env');
  }

  const url = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: (systemInstruction ? (systemInstruction + '\n\n') : '') + prompt }] }]
  };

  for (let attempt = 1; attempt <= attempts; ++attempt) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(id);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        // If 503 or 429 -> retry; otherwise throw
        if (resp.status === 503 || resp.status === 429) {
          const meta = { status: resp.status, txt: text };
          if (attempt < attempts) {
            const waitMs = backoffBaseMs * Math.pow(2, attempt - 1);
            console.warn(`Gemini transient error ${resp.status}. Retrying attempt ${attempt + 1} after ${waitMs}ms.`, meta);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          } else {
            throw new Error(`Gemini API transient error (${resp.status}): ${text || resp.statusText}`);
          }
        } else {
          // non-retriable
          throw new Error(`Gemini API error (${resp.status}): ${text || resp.statusText}`);
        }
      }

      const data = await resp.json();
      const candidates = data?.candidates || [];
      if (!candidates.length) return '';
      const candidate = candidates[0];
      const parts = candidate?.content?.parts || [];
      const text = parts.map(p => p?.text || '').filter(Boolean).join('\n\n');
      return text;
    } catch (err) {
      // fetch abort results in DOMException: The user aborted a request.
      const isAbort = err && err.name === 'AbortError';
      if (attempt < attempts && (isAbort || err.message?.includes('ECONNRESET') || err.message?.includes('transient') || err.message?.includes('UNAVAILABLE') || err.message?.includes('503') || err.message?.includes('429'))) {
        const waitMs = backoffBaseMs * Math.pow(2, attempt - 1);
        console.warn(`callGemini attempt ${attempt} failed, retrying after ${waitMs}ms:`, err.message);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      // final failure
      throw err;
    }
  }

  throw new Error('callGemini failed after retries');
}

// ---------- JSON extractor ----------
function extractJSON(str) {
  if (!str) return null;
  const m = str.match(/```json\s*([\s\S]*?)\s*```/i) || str.match(/```([\s\S]*?)```/i) || str.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const candidate = m ? (m[1] || m[0]) : str;
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

// ---------- HTML save helpers ----------
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function saveImportantHtml(id, title, pagesPoints) {
  const filePath = path.join(__dirname, 'public', 'important', `${id}.html`);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">

  <style>
    body {
      background: #0b0014;
      color: white;
      font-family: 'Poppins', sans-serif;
      margin: 0;
      padding: 40px 0;
      display: flex;
      justify-content: center;
    }

    .container {
      width: 90%;
      max-width: 900px;
      margin: auto;
      padding: 20px;
    }

    h1 {
      text-align: center;
      margin-bottom: 40px;
      font-size: 2rem;
      color: #fff;
    }

    .page-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(158, 0, 255, 0.3);
      padding: 25px;
      margin-bottom: 30px;
      border-radius: 12px;
      backdrop-filter: blur(6px);
    }

    .page-title {
      font-size: 1.3rem;
      margin-bottom: 15px;
      color: #c57bff;
      font-weight: 600;
    }

    ol {
      padding-left: 20px;
      line-height: 1.6;
    }

    li {
      margin-bottom: 8px;
      text-align: left;
    }

    a.back {
      display: block;
      margin-top: 30px;
      text-align: center;
      color: #bf6fff;
      text-decoration: none;
      font-size: 1rem;
    }

    a.back:hover {
      text-decoration: underline;
    }

  </style>
</head>

<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>

    ${pagesPoints
      .map(
        (pg) => `
      <div class="page-card">
        <div class="page-title">Page ${escapeHtml(String(pg.page))}</div>
        <ol>
          ${pg.points
            .map((pt) => `<li>${escapeHtml(pt)}</li>`)
            .join("")}
        </ol>
      </div>
    `
      )
      .join("")}

    <a class="back" href="/Notion.html">← Back to Notes</a>
  </div>
</body>
</html>
`;

  fs.writeFileSync(filePath, html, "utf8");
  return `/important/${id}.html`;
}

// ---------- Utility: split text into N chunks ----------
function splitIntoPages(text, numPages) {
  const clean = (text || '').replace(/\s+/g,' ').trim();
  if (!clean) return [];
  const pages = [];
  const parts = Math.max(1, numPages || 5);
  const chunkSize = Math.ceil(clean.length / parts);
  for (let i=0;i<parts;i++){
    const slice = clean.slice(i*chunkSize, (i+1)*chunkSize).trim();
    if (slice) pages.push({ page: i+1, text: slice });
  }
  return pages;
}

// ---------- Routes ----------

app.get('/api/health', (_req, res) => {
  const state = mongoose.connection.readyState;
  res.json({ db: state === 1 ? 'connected' : 'not-connected', geminiModel: GEMINI_MODEL });
});

app.post('/api/extract-text', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success:false, message:'No file uploaded' });
    if (!SUPPORTED.includes(file.mimetype)) return res.status(400).json({ success:false, message:'Only .txt, .docx, .pdf supported' });

    let text = '';
    if (file.mimetype === 'text/plain') {
      text = file.buffer.toString('utf8');
    } else if (file.mimetype.includes('wordprocessingml')) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value || '';
    } else if (file.mimetype === 'application/pdf') {
      const data = await pdfParse(file.buffer);
      text = data.text || '';
    }
    text = (text || '').replace(/\s+/g,' ').trim();
    if (!text) return res.status(400).json({ success:false, message:'Could not read text' });
    res.json({ success:true, text });
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ success:false, message:'Failed to extract text' });
  }
});

// Simple analyze (7 short points) - uses Gemini
app.post('/api/analyze', async (req, res) => {
  try {
    const notes = (req.body.notes || '').trim();
    if (!notes || notes.length < 50) return res.status(400).json({ success:false, message:'Provide at least 50 characters' });

    const system = 'You extract study highlights. Return only a JSON array of strings.';
    const userPrompt = `Analyze these notes and return exactly 7 concise key points (6–20 words each) as JSON array:\n\n${notes}`;

    const raw = await callGemini(userPrompt, system);
    const json = extractJSON(raw);
    let points = Array.isArray(json) ? json : String(raw).split('\n').map(l=>l.replace(/^[-•*\d.]+\s*/,'').trim()).filter(Boolean);
    points = points.map(p => String(p).trim()).slice(0,7);
    if (!points.length) throw new Error('Failed to parse points');

    res.json({ success:true, points });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ success:false, message: 'Analyze error: ' + (err.message || 'unknown') });
  }
});

// Quiz generation (5 MCQs)
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const notes = (req.body.notes || '').trim();
    if (!notes || notes.length < 50) return res.status(400).json({ success:false, message:'Provide at least 50 characters' });

    const system = 'You create MCQ quizzes. Return only valid JSON.';
    const user = `Based on these notes, generate exactly 5 multiple-choice questions in JSON array. Each item must be: { "question": "text", "options": ["A","B","C","D"], "answer": "one option", "explanation": "1-2 sentences" }. Notes:\n${notes}`;

    const raw = await callGemini(user, system);
    const arr = extractJSON(raw);
    if (!Array.isArray(arr)) throw new Error('Failed to parse quiz JSON');

    const cleaned = arr.slice(0,5).map((q,i)=>{
      const question = String(q?.question || `Question ${i+1}`).trim();
      let options = Array.isArray(q?.options) ? q.options.map(String) : [];
      if (options.length !== 4) { options = options.slice(0,4); while (options.length < 4) options.push(`Option ${options.length+1}`); }
      let answer = String(q?.answer || options[0]).trim(); if (!options.includes(answer)) answer = options[0];
      const explanation = String(q?.explanation || 'Answer chosen based on notes.').trim();
      return { question, options, answer, explanation };
    });

    res.json({ success:true, questions: cleaned });
  } catch (err) {
    console.error('Quiz error:', err);
    res.status(500).json({ success:false, message: 'Quiz error: ' + (err.message || 'unknown') });
  }
});

// Analyze pages: split pdf/text into pages, ask Gemini for JSON points per page, save HTML
// Replace your existing /api/analyze-pages handler with this implementation
app.post('/api/analyze-pages', upload.single('file'), async (req, res) => {
  try {
    // 1) obtain pages (pdf-parse fallback)
    let pages = [];
    if (req.file && req.file.mimetype === 'application/pdf') {
      const data = await pdfParse(req.file.buffer);
      const fullText = data.text || '';
      const numPages = Number(data.numpages) || 5;
      pages = splitIntoPages(fullText, numPages);
    } else {
      const raw = (req.body.notes || '').trim();
      if (!raw || raw.length < 50) return res.status(400).json({ success:false, message:'Add notes or upload a PDF' });
      pages = splitIntoPages(raw, 5);
    }

    if (!pages.length) return res.status(400).json({ success:false, message:'No readable content found' });

    // 2) Build combined prompt
    let combined = '';
    pages.forEach(p => combined += `--- PAGE ${p.page} START ---\n${p.text}\n--- PAGE ${p.page} END ---\n\n`);

    const system = 'You are a concise study-buddy. Return only valid JSON.';

    const userCombined = `I will provide text separated by pages. For each page produce between 10 and 12 concise key points (6-20 words each). Aim for ~50 points total across the document. Output EXACTLY this JSON schema and nothing else:

{
  "pages": [
    { "page": 1, "points": ["point1","point2", ...] },
    { "page": 2, "points": ["point1","point2", ...] },
    ...
  ]
}

Here is the text by page:
${combined}
`;

    // 3) Try single combined call with retries
    let rawModelResp;
    try {
      rawModelResp = await callGemini(userCombined, system, { attempts: 3, backoffBaseMs: 1000, timeoutMs: 120000 });
    } catch (err) {
      console.warn('Combined call failed, will fallback to per-page calls:', err.message || err);
      // fallthrough to per-page generation below
    }

    let parsed = rawModelResp ? extractJSON(rawModelResp) : null;

    // 4) If combined parsing failed, call per-page smaller prompts
    if (!parsed || !Array.isArray(parsed.pages)) {
      const pagesPoints = [];
      for (let i = 0; i < pages.length; ++i) {
        const p = pages[i];
        const perPageSystem = 'You are a concise study-buddy. Return only a JSON object: { "page": <n>, "points": ["p1", "p2", ...] }';
        const perPageUser = `Page ${p.page} text:\n\n${p.text}\n\nReturn a JSON object: { "page": ${p.page}, "points": [ ... ] } with between 10 and 12 concise key points (6-20 words each). Return only JSON.`;

        try {
          const rawSingle = await callGemini(perPageUser, perPageSystem, { attempts: 3, backoffBaseMs: 700, timeoutMs: 60000 });
          const parsedSingle = extractJSON(rawSingle);
          if (parsedSingle && (Array.isArray(parsedSingle.points) || Array.isArray(parsedSingle.pages))) {
            // Support both {page, points} and {pages: [...]}
            if (Array.isArray(parsedSingle.points)) {
              pagesPoints.push({ page: Number(parsedSingle.page) || p.page, points: parsedSingle.points.map(x=>String(x).trim()).filter(Boolean) });
            } else if (Array.isArray(parsedSingle.pages)) {
              // if model returns pages array, take first
              const got = parsedSingle.pages[0];
              pagesPoints.push({ page: Number(got.page) || p.page, points: (got.points||[]).map(x=>String(x).trim()).filter(Boolean) });
            } else {
              // fallback: try to coerce lines
              const lines = String(rawSingle).split('\n').map(l=>l.replace(/^[-•*\d.]+\s*/,'').trim()).filter(Boolean).slice(0,12);
              pagesPoints.push({ page: p.page, points: lines });
            }
          } else {
            // failed parse -> coerce lines
            const lines = String(rawSingle || '').split('\n').map(l=>l.replace(/^[-•*\d.]+\s*/,'').trim()).filter(Boolean).slice(0,12);
            pagesPoints.push({ page: p.page, points: lines });
          }
        } catch (err) {
          console.error(`Per-page call failed for page ${p.page}:`, err.message || err);
          // fallback to empty/minimal
          pagesPoints.push({ page: p.page, points: [] });
        }
      }

      // Save aggregated pagesPoints
      const id = uuidv4();
      const title = req.body.title ? String(req.body.title).trim() : 'Important Points';
      const publicPath = saveImportantHtml(id, title, pagesPoints);
      return res.json({ success:true, url: publicPath });
    }

    // 5) If combined parsed OK -> normalize and save
    const pagesPoints = parsed.pages.map(pg => ({
      page: Number(pg.page) || 0,
      points: (Array.isArray(pg.points) ? pg.points : []).map(x => String(x).trim()).filter(Boolean)
    }));

    const id = uuidv4();
    const title = req.body.title ? String(req.body.title).trim() : 'Important Points';
    const publicPath = saveImportantHtml(id, title, pagesPoints);

    res.json({ success:true, url: publicPath });

  } catch (err) {
    console.error('analyze-pages error', err);
    res.status(500).json({ success:false, message:'Analyze error: ' + (err.message || 'unknown') });
  }
});


// ---------- Auth endpoints ----------
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success:false, message:'All fields required' });
    const existing = await User.findOne({ $or:[{email},{username}] });
    if (existing) return res.status(400).json({ success:false, message:'Username or email exists' });
    const user = await new User({ username, email, password }).save();
    req.session.userId = user._id; req.session.username = user.username;
    res.status(201).json({ success:true, message:'Account created', user:{ username:user.username, email:user.email }});
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

app.post('/api/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success:false, message:'Email and password required' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ success:false, message:'Invalid email or password' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ success:false, message:'Invalid email or password' });
    req.session.userId = user._id; req.session.username = user.username;
    res.json({ success:true, message:'Signed in', user:{ username:user.username, email:user.email }});
  } catch (err) {
    console.error('Signin error:', err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

app.get('/', (_req, res) => res.send('Notion IQ API (Gemini) running'));

app.listen(PORT, () => console.log(`🚀 API on http://127.0.0.1:${PORT} (Gemini model: ${GEMINI_MODEL})`));
