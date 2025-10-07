// server.js
import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "eden_lite.db");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors()); // allow all origins by default (restrict in production if needed)
app.use(compression());
app.use(express.json());

// simple request logger to help diagnose on Render
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// health / root route
app.get("/", (req, res) => {
  res.json({
    message: "Eden Bible API — healthy",
    note: "Use /api/* endpoints",
    endpoints: [
      "/api/books",
      "/api/chapters/:bookId",
      "/api/verses/:bookId/:chapter",
      "/api/nav/book/:bookId",
      "/api/nav/chapter/:bookId/:chapter",
      "/api/search?q=...",
      "/api/tokens/:verseId",
      "/api/lexicon/:strong",
      "/api/comments"
    ]
  });
});

let db; // global handle

async function start() {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });

    // quick sanity log: list tables (helpful in logs)
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
    console.log("DB tables/views:", tables.map(t => t.name));

    // -------------------------
    // Routes used by the frontend
    // -------------------------

    // GET /api/books
    app.get("/api/books", async (req, res) => {
      try {
        // try numeric order if book_id numeric, else fallback to name
        const rows = await db.all(`SELECT book_id AS id, code, name FROM books ORDER BY CAST(book_id AS INTEGER)`);
        if (rows && rows.length) return res.json(rows);
        const alt = await db.all(`SELECT book_id AS id, code, name FROM books ORDER BY name`);
        res.json(alt);
      } catch (err) {
        console.error("GET /api/books error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/chapters/:bookId
    app.get("/api/chapters/:bookId", async (req, res) => {
      const { bookId } = req.params;
      try {
        const rows = await db.all(`SELECT DISTINCT chapter FROM verses WHERE book_id = ? ORDER BY chapter`, [bookId]);
        return res.json(rows.map(r => r.chapter));
      } catch (err) {
        console.error("GET /api/chapters error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/verses/:bookId/:chapter
    app.get("/api/verses/:bookId/:chapter", async (req, res) => {
      const { bookId, chapter } = req.params;
      try {
        const rows = await db.all(
          `SELECT id, verse, COALESCE(text_plain, text) AS text
           FROM verses
           WHERE book_id = ? AND chapter = ?
           ORDER BY verse ASC`,
          [bookId, chapter]
        );
        res.json(rows);
      } catch (err) {
        console.error("GET /api/verses error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // GET nav/book/:bookId  (prev/next book)
    app.get("/api/nav/book/:bookId", async (req, res) => {
      const { bookId } = req.params;
      try {
        // fetch books ordered (try numeric order)
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

    // GET nav/chapter/:bookId/:chapter  (prev/next chapter)
    app.get("/api/nav/chapter/:bookId/:chapter", async (req, res) => {
      const { bookId, chapter } = req.params;
      try {
        // prev in same book
        const prevRow = await db.get(`SELECT MAX(chapter) AS chapter FROM verses WHERE book_id = ? AND chapter < ?`, [bookId, chapter]);
        // next in same book
        const nextRow = await db.get(`SELECT MIN(chapter) AS chapter FROM verses WHERE book_id = ? AND chapter > ?`, [bookId, chapter]);

        let prev = null;
        let next = null;

        if (prevRow && prevRow.chapter !== null) {
          prev = { bookId, chapter: prevRow.chapter };
        } else {
          // previous book's last chapter
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
          // next book's first chapter
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

    // GET /api/search?q=...
    app.get("/api/search", async (req, res) => {
      const q = (req.query.q || "").trim();
      if (!q) return res.json([]);
      try {
        // detect fts table
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
             WHERE text_plain LIKE '%' || ? || '%'
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

    // GET /api/tokens/:verseId
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

    // GET /api/lexicon/:strong
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

    // Comments: GET
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

    // Comments: POST
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

    // Fallback 404 to return JSON (helps debugging)
    app.use((req, res) => {
      res.status(404).json({ error: "Not Found", path: req.path });
    });

    // start server
    app.listen(PORT, () => {
      console.log(`Eden Bible API running on http://localhost:${PORT || "PORT env"}`);
    });

  } catch (err) {
    console.error("Failed to open DB or start server:", err);
    process.exit(1);
  }
}

start();
