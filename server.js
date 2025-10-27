// server.js
import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

// --- sanitize verse text for plain output ---
// Removes pilcrow (¶), collapses multiple whitespace, trims.
// If you want to strip editorial [bracketed] words, uncomment the .replace(...) line.
function sanitizeText(s) {
  if (!s) return "";
  return String(s)
    .replace(/¶/g, "")            // remove pilcrow
    //.replace(/\[.*?\]/g, "")    // optional: remove bracketed words
    .replace(/\u00A0/g, " ")      // non-breaking space
    .replace(/\s+/g, " ")         // collapse multiple spaces/newlines
    .trim();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "eden_lite.db");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

// simple request logger
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

let db; // global DB handle

// Helper: normalized expression for whole-word matching
// (replaces common punctuation/newlines with spaces, lowercases, and pads with spaces)
function normalizedColumnExpr(colName) {
  return `
    LOWER(
      ' ' ||
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(
                          REPLACE(${colName},
                            CHAR(10), ' '),
                          CHAR(13), ' '),
                        CHAR(9), ' '),
                      '\r', ' '),
                    '\n', ' '),
                  '.', ' '),
                ',', ' '),
              ';', ' '),
            ':', ' '),
          '!', ' '),
        '?', ' '),
      '(', ' ')
    )
  `;
}

// Start server and open DB
async function start() {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });

    // PRAGMA for resilience
    try {
      await db.exec("PRAGMA busy_timeout = 5000;");
      await db.exec("PRAGMA journal_mode = WAL;");
      console.log("Applied PRAGMA busy_timeout=5000 and journal_mode=WAL");
    } catch (e) {
      console.warn("PRAGMA setup failed:", e);
    }

    // quick sanity
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
    console.log("DB tables/views:", tables.map(t => t.name));

    // -------------------------
    // Helper: resolve book identifiers (numeric id, code, or name)
    // -------------------------
    async function resolveBookId(input) {
      if (!input) return null;
      const raw = String(input).trim();

      // numeric
      if (/^\d+$/.test(raw)) {
        const byId = await db.get(`SELECT book_id FROM books WHERE book_id = ?`, [Number(raw)]);
        if (byId) return String(byId.book_id);
      }

      // code exact
      const byCode = await db.get(`SELECT book_id FROM books WHERE code = ?`, [raw]);
      if (byCode) return String(byCode.book_id);

      // case-insensitive exact name
      const byName = await db.get(`SELECT book_id FROM books WHERE LOWER(name) = LOWER(?)`, [raw]);
      if (byName) return String(byName.book_id);

      // prefix match
      const byLike = await db.get(`SELECT book_id FROM books WHERE LOWER(name) LIKE LOWER(?)`, [raw + '%']);
      if (byLike) return String(byLike.book_id);

      // contains anywhere
      const byLikeAnywhere = await db.get(`SELECT book_id FROM books WHERE LOWER(name) LIKE LOWER(?)`, ['%' + raw + '%']);
      if (byLikeAnywhere) return String(byLikeAnywhere.book_id);

      // last ditch numeric parse
      const maybeNum = Number(raw);
      if (!Number.isNaN(maybeNum)) {
        const byId2 = await db.get(`SELECT book_id FROM books WHERE book_id = ?`, [maybeNum]);
        if (byId2) return String(byId2.book_id);
      }

      return null;
    }

    // -------------------------
    // Root / health route
    // -------------------------
    app.get("/", (req, res) => {
      res.json({
        message: "Eden Bible API — healthy",
        note: "Use /api/* endpoints",
        endpoints: [
          "/api/books",
          "/api/chapters/:bookId",
          "/api/verses/:bookId/:chapter",
          "/api/verses/:bookId (returns chapters)",
          "/api/verses/plain/:bookId/:chapter (plain text)",
          "/api/verse/plain/:bookId/:chapter/:verse (plain verse)",
          "/api/nav/book/:bookId",
          "/api/nav/chapter/:bookId/:chapter",
          "/api/nav/verse/:bookId/:chapter/:verse",
          "/api/search?q=...",
          "/api/search/plain?q=...&exact=1",
          "/api/tokens/:verseId",
          "/api/lexicon/:strong",
          "/api/comments"
        ]
      });
    });

    // -------------------------
    // GET /api/books
    // -------------------------
    app.get("/api/books", async (req, res) => {
      try {
        const rows = await db.all(`SELECT book_id AS id, code, name FROM books ORDER BY CAST(book_id AS INTEGER)`);
        if (rows && rows.length) return res.json(rows);
        const alt = await db.all(`SELECT book_id AS id, code, name FROM books ORDER BY name`);
        res.json(alt);
      } catch (err) {
        console.error("GET /api/books error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // GET /api/chapters/:bookId  (resolves book identifier flexibly)
    // -------------------------
    app.get("/api/chapters/:bookId", async (req, res) => {
      try {
        const raw = req.params.bookId;
        const bookId = await resolveBookId(raw);
        if (!bookId) return res.json([]);

        const sources = [
          { sql: `SELECT DISTINCT chapter FROM verses_api WHERE book_id = ? ORDER BY chapter`, args: [bookId] },
          { sql: `SELECT DISTINCT chapter FROM verses_with_book WHERE book_id = ? ORDER BY chapter`, args: [bookId] },
          { sql: `SELECT DISTINCT chapter FROM verses WHERE book_id = ? ORDER BY chapter`, args: [bookId] }
        ];

        for (const s of sources) {
          try {
            const rows = await db.all(s.sql, s.args);
            if (rows && rows.length) return res.json(rows.map(r => r.chapter));
          } catch (e) {
            console.warn("chapters: source query failed:", e.message);
          }
        }

        return res.json([]);
      } catch (err) {
        console.error("GET /api/chapters error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // JSON verses route (existing, returns JSON array of {id, verse, text})
    // GET /api/verses/:bookId/:chapter
    // -------------------------
    app.get("/api/verses/:bookId/:chapter", async (req, res) => {
      try {
        const raw = req.params.bookId;
        const chapter = req.params.chapter;
        const bookId = await resolveBookId(raw);
        console.log("[DEBUG] verses.resolveBookId(", raw, ") ->", bookId);
        if (!bookId) return res.status(404).json({ error: "Book not found", input: raw });

        // try verses_api, then verses_with_book, then verses
        try {
          const rowsApi = await db.all(
            `SELECT id, verse, COALESCE(text_plain, text, '') AS text
             FROM verses_api
             WHERE book_id = ? AND chapter = ?
             ORDER BY verse ASC`,
            [bookId, chapter]
          );
          if (rowsApi && rowsApi.length) return res.json(rowsApi);
        } catch (e) {
          console.warn("verses_api query failed:", e.message);
        }

        try {
          const rowsW = await db.all(
            `SELECT id, verse, COALESCE(text_plain, text, '') AS text
             FROM verses_with_book
             WHERE book_id = ? AND chapter = ?
             ORDER BY verse ASC`,
            [bookId, chapter]
          );
          if (rowsW && rowsW.length) return res.json(rowsW);
        } catch (e) {
          console.warn("verses_with_book query failed:", e.message);
        }

        try {
          const rows = await db.all(
            `SELECT id, verse, COALESCE(text_plain, '') AS text
             FROM verses
             WHERE book_id = ? AND chapter = ?
             ORDER BY verse ASC`,
            [bookId, chapter]
          );
          return res.json(rows || []);
        } catch (e) {
          console.warn("verses query failed:", e.message);
        }

        return res.json([]);
      } catch (err) {
        console.error("GET /api/verses error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // GET /api/verses/:bookId  -> returns chapters for that book (JSON)
    // -------------------------
    app.get("/api/verses/:bookId", async (req, res) => {
      try {
        const raw = req.params.bookId;
        const bookId = await resolveBookId(raw);
        if (!bookId) return res.status(404).json({ error: "Book not found", input: raw });

        const sources = [
          { sql: `SELECT DISTINCT chapter FROM verses_api WHERE book_id = ? ORDER BY chapter`, args: [bookId] },
          { sql: `SELECT DISTINCT chapter FROM verses_with_book WHERE book_id = ? ORDER BY chapter`, args: [bookId] },
          { sql: `SELECT DISTINCT chapter FROM verses WHERE book_id = ? ORDER BY chapter`, args: [bookId] }
        ];

        for (const s of sources) {
          try {
            const rows = await db.all(s.sql, s.args);
            if (rows && rows.length) return res.json(rows.map(r => r.chapter));
          } catch (e) {
            console.warn("verses(:bookId) chapters source failed:", e.message);
          }
        }

        return res.json([]);
      } catch (err) {
        console.error("GET /api/verses/:bookId chapters error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // GET nav/book/:bookId  (prev/next book)
    // -------------------------
    app.get("/api/nav/book/:bookId", async (req, res) => {
      const { bookId } = req.params;
      try {
        let orderRows = await db.all(`SELECT book_id, name FROM books ORDER BY CAST(book_id AS INTEGER)`);
        if (!orderRows || orderRows.length === 0) {
          orderRows = await db.all(`SELECT book_id, name FROM books ORDER BY name`);
        }
        const idx = orderRows.findIndex(r => String(r.book_id) === String(bookId));
        const prev = idx > 0 ? orderRows[idx - 1] : null;
        const next = idx >= 0 && idx < orderRows.length - 1 ? orderRows[idx + 1] : null;
        res.json({ prev, next });
      } catch (err) {
        console.error("GET /api/nav/book error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // GET nav/chapter/:bookId/:chapter  (prev/next chapter)
    // -------------------------
    app.get("/api/nav/chapter/:bookId/:chapter", async (req, res) => {
      const { bookId, chapter } = req.params;
      try {
        const prevRow = await db.get(`SELECT MAX(chapter) AS chapter FROM verses WHERE book_id = ? AND chapter < ?`, [bookId, chapter]);
        const nextRow = await db.get(`SELECT MIN(chapter) AS chapter FROM verses WHERE book_id = ? AND chapter > ?`, [bookId, chapter]);

        let prev = null;
        let next = null;

        if (prevRow && prevRow.chapter !== null) {
          prev = { bookId, chapter: prevRow.chapter };
        } else {
          const books = await db.all(`SELECT book_id FROM books ORDER BY CAST(book_id AS INTEGER)`);
          const idx = books.findIndex(b => String(b.book_id) === String(bookId));
          if (idx > 0) {
            const prevBook = books[idx - 1].book_id;
            const prevChap = await db.get(`SELECT MAX(chapter) AS chapter FROM verses WHERE book_id = ?`, [prevBook]);
            if (prevChap && prevChap.chapter !== null) prev = { bookId: prevBook, chapter: prevChap.chapter };
          }
        }

        if (nextRow && nextRow.chapter !== null) {
          next = { bookId, chapter: nextRow.chapter };
        } else {
          const books = await db.all(`SELECT book_id FROM books ORDER BY CAST(book_id AS INTEGER)`);
          const idx = books.findIndex(b => String(b.book_id) === String(bookId));
          if (idx >= 0 && idx < books.length - 1) {
            const nextBook = books[idx + 1].book_id;
            const nextChap = await db.get(`SELECT MIN(chapter) AS chapter FROM verses WHERE book_id = ?`, [nextBook]);
            if (nextChap && nextChap.chapter !== null) next = { bookId: nextBook, chapter: nextChap.chapter };
          }
        }

        res.json({ prev, next });
      } catch (err) {
        console.error("GET /api/nav/chapter error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // JSON search (keeps your existing behaviour)
    // GET /api/search?q=...
    // Uses FTS if present, otherwise LIKE
    // -------------------------
    app.get("/api/search", async (req, res) => {
      const q = (req.query.q || "").trim();
      if (!q) return res.json([]);
      try {
        const ftsExists = (await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='verses_fts'`)) !== undefined;
        if (ftsExists) {
          const rows = await db.all(
            `SELECT v.book_id AS book, v.chapter, v.verse, v.text_plain AS text
             FROM verses_fts f JOIN verses v ON v.id = f.rowid
             WHERE verses_fts MATCH ?
             LIMIT 200`,
            [q]
          );
          return res.json(rows);
        } else {
          const rows = await db.all(
            `SELECT book_id AS book, chapter, verse, text_plain AS text
             FROM verses
             WHERE LOWER(text_plain) LIKE '%' || LOWER(?) || '%'
             LIMIT 200`,
            [q]
          );
          return res.json(rows);
        }
      } catch (err) {
        console.error("GET /api/search error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // Tokens and lexicon endpoints (unchanged)
    // -------------------------
    app.get("/api/tokens/:verseId", async (req, res) => {
      const { verseId } = req.params;
      try {
        const rows = await db.all(
          `SELECT id, verse_id, word_index AS position, surface, strong
           FROM tokens
           WHERE verse_id = ?
           ORDER BY word_index ASC`,
          [verseId]
        );
        res.json({ tokens: rows });
      } catch (err) {
        console.error("GET /api/tokens error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/lexicon/:strong", async (req, res) => {
      const strong = req.params.strong;
      try {
        const row = await db.get(
          `SELECT strong, language, lemma, transliteration, definition FROM lexicon WHERE strong = ? LIMIT 1`,
          [strong]
        );
        res.json(row || null);
      } catch (err) {
        console.error("GET /api/lexicon error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // Comments GET and POST (unchanged)
    // -------------------------
    app.get("/api/comments", async (req, res) => {
      const { bookId, chapter, verse } = req.query;
      if (!bookId || !chapter || !verse) return res.status(400).json({ error: "Provide bookId, chapter, verse" });
      try {
        const rows = await db.all(
          `SELECT id, author, body, created_at AS createdAt FROM comments WHERE book = ? AND chapter = ? AND verse = ? ORDER BY created_at DESC`,
          [bookId, chapter, verse]
        );
        res.json(rows);
      } catch (err) {
        console.error("GET /api/comments error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/api/comments", async (req, res) => {
      const { bookId, chapter, verse, author, body } = req.body || {};
      if (!bookId || !chapter || !verse || !body) return res.status(400).json({ error: "Missing fields" });
      try {
        const result = await db.run(
          `INSERT INTO comments (book, chapter, verse, author, body) VALUES (?, ?, ?, ?, ?)`,
          [bookId, chapter, verse, author || "anonymous", body]
        );
        const saved = await db.get(`SELECT id, author, body, created_at AS createdAt FROM comments WHERE id = ?`, [result.lastID]);
        res.json(saved);
      } catch (err) {
        console.error("POST /api/comments error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------
    // Plain-text chapter (robust)
    // GET /api/verses/plain/:bookId/:chapter
    // -------------------------
    app.get("/api/verses/plain/:bookId/:chapter", async (req, res) => {
      try {
        const raw = req.params.bookId;
        const chapter = req.params.chapter;
        const bookId = await resolveBookId(raw);
        if (!bookId) return res.status(404).type("text/plain").send("");

        let rows = [];

        // try verses_api but gracefully handle errors and fallback to verses
        const hasVersesApi = (await db.get(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='verses_api'`)) !== undefined;
        if (hasVersesApi) {
          try {
            rows = await db.all(
              `SELECT verse, COALESCE(text_plain, text, '') AS text
               FROM verses_api
               WHERE book_id = ? AND chapter = ?
               ORDER BY verse ASC`,
              [bookId, chapter]
            );
          } catch (e) {
            console.warn("verses_api query failed (plain route):", e.message);
            rows = [];
          }
        }

        // fallback to verses if verses_api missing or returned nothing
        if (!rows || rows.length === 0) {
          try {
            rows = await db.all(
              `SELECT verse, COALESCE(text_plain, '') AS text
               FROM verses
               WHERE book_id = ? AND chapter = ?
               ORDER BY verse ASC`,
              [bookId, chapter]
            );
          } catch (e) {
            console.warn("verses query failed (plain route):", e.message);
            rows = [];
          }
        }

        if (!rows || rows.length === 0) {
          // nothing found: return empty plain text
          return res.type("text/plain").send("");
        }

        const out = rows.map(r => `${r.verse}. ${r.text.trim()}`).join("\n");
        res.type("text/plain").send(out);
      } catch (err) {
        console.error("GET /api/verses/plain error:", err);
        res.status(500).type("text/plain").send("");
      }
    });

    // -------------------------
    // Plain-text single verse (robust)
    // GET /api/verse/plain/:bookId/:chapter/:verse
    // -------------------------
    app.get("/api/verse/plain/:bookId/:chapter/:verse", async (req, res) => {
      try {
        const raw = req.params.bookId;
        const chapter = req.params.chapter;
        const verse = req.params.verse;
        const bookId = await resolveBookId(raw);
        if (!bookId) return res.status(404).type("text/plain").send("");

        let row = null;
        const hasVersesApi = (await db.get(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='verses_api'`)) !== undefined;

        if (hasVersesApi) {
          try {
            row = await db.get(
              `SELECT v.book_id, v.chapter, v.verse, COALESCE(v.text_plain, v.text, '') AS text, b.name AS book
               FROM verses_api v
               JOIN books b ON b.book_id = v.book_id
               WHERE v.book_id = ? AND v.chapter = ? AND v.verse = ? LIMIT 1`,
              [bookId, chapter, verse]
            );
          } catch (e) {
            console.warn("verses_api single-verse query failed (plain route):", e.message);
            row = null;
          }
        }

        // fallback to verses if verses_api missing or failed
        if (!row) {
          try {
            row = await db.get(
              `SELECT v.book_id, v.chapter, v.verse, COALESCE(v.text_plain, '') AS text, b.name AS book
               FROM verses v
               JOIN books b ON b.book_id = v.book_id
               WHERE v.book_id = ? AND v.chapter = ? AND v.verse = ? LIMIT 1`,
              [bookId, chapter, verse]
            );
          } catch (e) {
            console.warn("verses single-verse query failed (plain route):", e.message);
            row = null;
          }
        }

        if (!row) return res.status(404).type("text/plain").send("");

        res.type("text/plain").send(`${row.verse}. ${row.text.trim()}`);
      } catch (err) {
        console.error("GET /api/verse/plain error:", err);
        res.status(500).type("text/plain").send("");
      }
    });

    // -------------------------
// FIXED plain-text search route with exact and fuzzy match
// GET /api/search/plain?q=word&exact=1
// returns "Genesis 1:1. In the beginning..."
app.get("/api/search/plain", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.type("text/plain").send("");

    const exact = req.query.exact === "1" || req.query.exact === "true";

    // prefer main verses table
    const table = "verses";
    const textColumn = "text_plain";

    let rows = [];

    if (exact) {
      // Whole-word (normalized) search
      const normExpr = normalizedColumnExpr(`v.${textColumn}`);
      const pattern = `% ${q.toLowerCase()} %`;
      rows = await db.all(
        `
        SELECT b.name AS book, v.chapter, v.verse, COALESCE(v.${textColumn}, '') AS text
        FROM ${table} v
        JOIN books b ON b.book_id = v.book_id
        WHERE ${normExpr} LIKE ?
        LIMIT 500;
        `,
        [pattern]
      );
    } else {
      // Normal substring match
      rows = await db.all(
        `
        SELECT b.name AS book, v.chapter, v.verse, COALESCE(v.${textColumn}, '') AS text
        FROM ${table} v
        JOIN books b ON b.book_id = v.book_id
        WHERE LOWER(v.${textColumn}) LIKE '%' || LOWER(?) || '%'
        LIMIT 500;
        `,
        [q]
      );
    }

    if (!rows || rows.length === 0) {
      return res.type("text/plain").send("No results found.");
    }

    // Format and sanitize results
    const out = rows
      .map(r => `${r.book} ${r.chapter}:${r.verse}. ${sanitizeText(r.text)}`)
      .join("\n");

    res.type("text/plain").send(out);

    } catch (err) {
    console.error("GET /api/search/plain error:", err.message);
    console.error(err.stack);
    res.status(500).type("text/plain").send("Error performing search: " + err.message);
  }
});

    // -------------------------
    // Navigation helper for next/previous verse coordinates
    // GET /api/nav/verse/:bookId/:chapter/:verse
    // -------------------------
    app.get("/api/nav/verse/:bookId/:chapter/:verse", async (req, res) => {
      try {
        const { bookId: raw, chapter, verse } = req.params;
        const bookId = await resolveBookId(raw);
        if (!bookId) return res.status(404).json({ error: "Book not found" });

        const nextSame = await db.get(
          `SELECT verse FROM verses WHERE book_id = ? AND chapter = ? AND verse > ? ORDER BY verse ASC LIMIT 1`,
          [bookId, chapter, verse]
        );

        const prevSame = await db.get(
          `SELECT verse FROM verses WHERE book_id = ? AND chapter = ? AND verse < ? ORDER BY verse DESC LIMIT 1`,
          [bookId, chapter, verse]
        );

        let next = null, prev = null;

        if (nextSame) {
          next = { bookId, chapter, verse: nextSame.verse };
        } else {
          const books = await db.all(`SELECT book_id FROM books ORDER BY CAST(book_id AS INTEGER)`);
          const idx = books.findIndex(b => String(b.book_id) === String(bookId));
          if (idx >= 0 && idx < books.length - 1) {
            const nextBook = books[idx + 1].book_id;
            const nextChap = await db.get(`SELECT MIN(chapter) AS chapter FROM verses WHERE book_id = ?`, [nextBook]);
            if (nextChap && nextChap.chapter !== null) {
              const firstVerse = await db.get(`SELECT MIN(verse) AS verse FROM verses WHERE book_id = ? AND chapter = ?`, [nextBook, nextChap.chapter]);
              if (firstVerse) next = { bookId: nextBook, chapter: nextChap.chapter, verse: firstVerse.verse };
            }
          }
        }

        if (prevSame) {
          prev = { bookId, chapter, verse: prevSame.verse };
        } else {
          const books = await db.all(`SELECT book_id FROM books ORDER BY CAST(book_id AS INTEGER)`);
          const idx = books.findIndex(b => String(b.book_id) === String(bookId));
          if (idx > 0) {
            const prevBook = books[idx - 1].book_id;
            const prevChap = await db.get(`SELECT MAX(chapter) AS chapter FROM verses WHERE book_id = ?`, [prevBook]);
            if (prevChap && prevChap.chapter !== null) {
              const lastVerse = await db.get(`SELECT MAX(verse) AS verse FROM verses WHERE book_id = ? AND chapter = ?`, [prevBook, prevChap.chapter]);
              if (lastVerse) prev = { bookId: prevBook, chapter: prevChap.chapter, verse: lastVerse.verse };
            }
          }
        }

        res.json({ prev, next });
      } catch (err) {
        console.error("GET /api/nav/verse error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Fallback 404 to return JSON
    app.use((req, res) => {
      res.status(404).json({ error: "Not Found", path: req.path });
    });

    // start server
    app.listen(PORT, () => {
      console.log(`Eden Bible API running on http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error("Failed to open DB or start server:", err);
    process.exit(1);
  }
}

start();
